/**
 * Dispatch-plan building: which providers, in what order, with which
 * credentials. Shared by the sync send path and the queue consumer.
 *
 * Credential resolution per provider (CONTEXT.md "Masking Profile"):
 *   masking profile (app-owned, D1, api key AES-GCM encrypted)
 *     → global provider settings (D1, api key AES-GCM encrypted).
 *
 * App config is KV-cached (ADR 0002: the cache is an availability shield —
 * a warm cache lets sends proceed through a D1 outage). D1 stays the source
 * of truth; admin/API mutations call `invalidateAppConfig`.
 */

import type { Db } from "../db/queries";
import { getAppProviderPlan, getGlobalProviders, listMaskingProfiles } from "../db/queries";
import { decryptSecret } from "../shared/crypto";
import { KV_APP_CONFIG_PREFIX, KV_TTL_SECONDS, kvAppConfig } from "../shared/constants";
import type { DispatchPlanEntry, ProviderName } from "../shared/types";
import { BulkSmsBd } from "../sms/bulksmsbd";
import { MimSms } from "../sms/mimsms";
import { FakeSms } from "../sms/fake";

interface CachedProfile {
  provider: ProviderName;
  label: string;
  senderId: string | null;
  senderName: string | null;
  username: string | null;
  apiKeyEnc: string | null;
}

interface CachedGlobal {
  senderId: string | null;
  senderName: string | null;
  username: string | null;
  apiKeyEnc: string | null;
}

export interface AppDispatchConfig {
  plan: { provider: ProviderName; priority: number }[];
  /** Global provider defaults from provider_settings (ciphertext only; decrypted at use). */
  globals: Partial<Record<ProviderName, CachedGlobal>>;
  profiles: CachedProfile[];
}

export async function loadAppConfig(env: Env, db: Db, appId: number): Promise<AppDispatchConfig> {
  const key = kvAppConfig(appId);
  const cached = await env.CACHE.get<AppDispatchConfig>(key, "json").catch(() => null);
  if (cached) return cached;

  const [plan, globalRows, profiles] = await Promise.all([
    getAppProviderPlan(db, appId),
    getGlobalProviders(db),
    listMaskingProfiles(db, appId),
  ]);

  const config: AppDispatchConfig = {
    plan,
    globals: Object.fromEntries(
      globalRows.map((g) => [
        g.provider,
        { senderId: g.senderId, senderName: g.senderName, username: g.username, apiKeyEnc: g.apiKeyEnc },
      ]),
    ),
    profiles: profiles.map((p) => ({
      provider: p.provider,
      label: p.label,
      senderId: p.senderId,
      senderName: p.senderName,
      username: p.username,
      apiKeyEnc: p.apiKeyEnc,
    })),
  };

  // Cache write is best-effort: a KV failure must never fail a send.
  await env.CACHE.put(key, JSON.stringify(config), { expirationTtl: KV_TTL_SECONDS }).catch(
    (err: unknown) => {
      console.warn(JSON.stringify({ event: "app_config_cache_put_failed", appId, error: String(err) }));
    },
  );
  return config;
}

export async function invalidateAppConfig(env: Env, appId: number): Promise<void> {
  await env.CACHE.delete(kvAppConfig(appId)).catch((err: unknown) => {
    console.warn(JSON.stringify({ event: "app_config_cache_delete_failed", appId, error: String(err) }));
  });
}

/**
 * Clears every cached app config. Called on global provider save — a save
 * changes credentials/sender identity every app's plan may inherit, and the
 * per-app cache has no way to know which apps that affects, so every entry
 * is dropped. Fires only on an explicit admin action and the app count is
 * tiny, so the ADR 0002 cost (one cold refill per app on next send) is
 * acceptable here. Best-effort: must never throw.
 */
export async function invalidateAllAppConfigs(env: Env): Promise<void> {
  try {
    let cursor: string | undefined;
    for (;;) {
      const list = await env.CACHE.list({ prefix: KV_APP_CONFIG_PREFIX, cursor });
      await Promise.all(list.keys.map((k) => env.CACHE.delete(k.name)));
      if (list.list_complete) break;
      cursor = list.cursor;
    }
  } catch (err) {
    console.warn(JSON.stringify({ event: "app_config_cache_clear_failed", error: String(err) }));
  }
}

export interface BuiltPlan {
  entries: DispatchPlanEntry[];
  /** Non-fatal resolution notes (e.g. masking label matched no profile). */
  warnings: string[];
}

/** Whether the App has a masking profile with this label (for any provider).
 *  Reads the same cached config dispatch uses. */
export async function maskingProfileExists(env: Env, db: Db, appId: number, label: string): Promise<boolean> {
  const config = await loadAppConfig(env, db, appId);
  return config.profiles.some((profile) => profile.label === label);
}

export async function buildDispatchPlan(
  env: Env,
  db: Db,
  appId: number,
  maskingLabel?: string,
  opts: { maskingStrict?: boolean } = {},
): Promise<BuiltPlan> {
  if (env.FAKE_SMS === "true") {
    return { entries: [{ provider: new FakeSms() }], warnings: [] };
  }

  const config = await loadAppConfig(env, db, appId);
  const warnings: string[] = [];
  const entries: DispatchPlanEntry[] = [];
  let maskingMatched = false;

  for (const item of config.plan) {
    const profile = maskingLabel
      ? config.profiles.find((p) => p.provider === item.provider && p.label === maskingLabel)
      : undefined;
    if (profile) maskingMatched = true;
    // Strict masking: a provider without the profile would send under the
    // global sender identity instead, so it is left out of the chain.
    if (maskingLabel && opts.maskingStrict && !profile) {
      warnings.push(`${item.provider} omitted: no "${maskingLabel}" masking profile (maskingStrict)`);
      continue;
    }
    const global = config.globals[item.provider];

    // Credentials resolve masking profile → global provider settings, both
    // D1-backed; there is no worker-secret fallback. A provider without
    // usable credentials (missing, or failing to decrypt) is omitted from
    // the chain rather than failing the whole dispatch — the warning is
    // additive, callers treat warnings as non-fatal.
    try {
      const apiKeyEnc = profile?.apiKeyEnc ?? global?.apiKeyEnc;
      const apiKey = apiKeyEnc ? await decryptSecret(env, apiKeyEnc) : undefined;
      if (!apiKey) {
        warnings.push(`${item.provider} omitted: no API key configured (Admin → Providers)`);
        continue;
      }

      if (item.provider === "bulksmsbd") {
        const senderId = profile?.senderId ?? global?.senderId;
        if (!senderId) {
          warnings.push("bulksmsbd omitted: no sender id configured");
          continue;
        }
        entries.push({ provider: new BulkSmsBd({ apiKey, senderId }) });
      } else {
        const username = profile?.username ?? global?.username;
        const senderName = profile?.senderName ?? global?.senderName;
        if (!username || !senderName) {
          warnings.push("mimsms omitted: username/senderName not configured");
          continue;
        }
        entries.push({ provider: new MimSms({ apiKey, username, senderName }) });
      }
    } catch (err) {
      // Details go to the log only: warnings reach API clients.
      console.error(
        JSON.stringify({
          event: "provider_credentials_invalid",
          provider: item.provider,
          appId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      warnings.push(`${item.provider} omitted: credentials could not be loaded`);
    }
  }

  if (maskingLabel && !maskingMatched && !opts.maskingStrict) {
    warnings.push(`masking profile "${maskingLabel}" matched no provider; using global credentials`);
  }
  return { entries, warnings };
}
