/**
 * Global provider credentials in D1 (docs/adr/0004-provider-credentials-in-d1.md).
 *
 * Drives `upsertGlobalProvider`/`buildDispatchPlan`/`invalidateAllAppConfigs`
 * directly against a REAL D1 binding (`env.DB` from `cloudflare:test`, per
 * wrangler.jsonc) and a REAL KV binding (`env.CACHE`), following the
 * test/templates-api.test.ts convention: schema created from the exact DDL
 * in drizzle/0000_tiny_hercules.sql, split into individual statements since D1's
 * `.prepare()` takes one statement at a time, re-run + row-wiped in
 * `beforeEach`. `loadAppConfig` (src/core/plan.ts) caches per app in KV under
 * `app:config:<appId>`, so `beforeEach` also invalidates the cache to keep
 * cases from bleeding into each other.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { buildDispatchPlan, invalidateAllAppConfigs, loadAppConfig } from "../src/core/plan";
import { createMaskingProfile, getDb, upsertGlobalProvider } from "../src/db";
import { encryptSecret } from "../src/shared/crypto";

async function ensureSchema() {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS provider_settings (
      provider text PRIMARY KEY NOT NULL,
      enabled integer DEFAULT true NOT NULL,
      priority integer NOT NULL,
      sender_id text,
      api_key_enc text,
      username text,
      sender_name text,
      updated_at integer
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_providers (
      app_id integer NOT NULL,
      provider text NOT NULL,
      enabled integer DEFAULT true NOT NULL,
      priority integer NOT NULL,
      PRIMARY KEY(app_id, provider)
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS masking_profiles (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      app_id integer NOT NULL,
      provider text NOT NULL,
      label text NOT NULL,
      sender_id text,
      sender_name text,
      username text,
      api_key_enc text,
      created_at integer NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS masking_profiles_app_provider_label_unique ON masking_profiles (app_id, provider, label)",
  ).run();
  await env.DB.prepare("DELETE FROM provider_settings").run();
  await env.DB.prepare("DELETE FROM app_providers").run();
  await env.DB.prepare("DELETE FROM masking_profiles").run();
}

beforeEach(async () => {
  await ensureSchema();
  // loadAppConfig caches per app in KV; wipe so cases don't bleed.
  await invalidateAllAppConfigs(env);
});

const db = getDb(env);
// buildDispatchPlan short-circuits to FakeSms when FAKE_SMS === "true"
// (real local/test env); force the real dispatch path for these tests.
const testEnv = { ...env, FAKE_SMS: "false" } as Env;

describe("upsertGlobalProvider", () => {
  it("apiKeyEnc: string sets, undefined keeps, null clears", async () => {
    const row1 = await upsertGlobalProvider(db, {
      provider: "bulksmsbd",
      enabled: true,
      priority: 1,
      apiKeyEnc: "enc1",
    });
    expect(row1.apiKeyEnc).toBe("enc1");
    expect(row1.updatedAt).toEqual(expect.any(Number));

    const row2 = await upsertGlobalProvider(db, {
      provider: "bulksmsbd",
      enabled: true,
      priority: 1,
      apiKeyEnc: undefined,
    });
    expect(row2.apiKeyEnc).toBe("enc1");

    const row3 = await upsertGlobalProvider(db, {
      provider: "bulksmsbd",
      enabled: true,
      priority: 1,
      apiKeyEnc: null,
    });
    expect(row3.apiKeyEnc).toBeNull();
  });

  it("username: string sets, undefined keeps, null clears", async () => {
    const row1 = await upsertGlobalProvider(db, {
      provider: "mimsms",
      enabled: true,
      priority: 1,
      username: "user1",
    });
    expect(row1.username).toBe("user1");

    const row2 = await upsertGlobalProvider(db, {
      provider: "mimsms",
      enabled: true,
      priority: 1,
      username: undefined,
    });
    expect(row2.username).toBe("user1");

    const row3 = await upsertGlobalProvider(db, {
      provider: "mimsms",
      enabled: true,
      priority: 1,
      username: null,
    });
    expect(row3.username).toBeNull();
  });
});

describe("buildDispatchPlan", () => {
  it("a damaged credential cannot block a healthy fallback provider", async () => {
    await upsertGlobalProvider(db, { provider: "bulksmsbd", enabled: true, priority: 1, apiKeyEnc: "broken", senderId: "123" });
    await upsertGlobalProvider(db, { provider: "mimsms", enabled: true, priority: 2, apiKeyEnc: await encryptSecret(testEnv, "valid"), username: "user", senderName: "brand" });
    const plan = await buildDispatchPlan(testEnv, db, 1);
    expect(plan.entries.map((entry) => entry.provider.name)).toEqual(["mimsms"]);
    expect(plan.warnings).toEqual(["bulksmsbd omitted: credentials could not be loaded"]);
  });
  it("bulksmsbd with api key + sender id: 1 entry, no warnings", async () => {
    await upsertGlobalProvider(db, {
      provider: "bulksmsbd",
      enabled: true,
      priority: 1,
      apiKeyEnc: await encryptSecret(testEnv, "k"),
      senderId: "8809",
    });

    const { entries, warnings } = await buildDispatchPlan(testEnv, db, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.provider.name).toBe("bulksmsbd");
    expect(warnings).toEqual([]);
  });

  it("bulksmsbd without api key: 0 entries, warning about missing key", async () => {
    await upsertGlobalProvider(db, {
      provider: "bulksmsbd",
      enabled: true,
      priority: 1,
      senderId: "8809",
    });

    const { entries, warnings } = await buildDispatchPlan(testEnv, db, 1);
    expect(entries).toHaveLength(0);
    expect(warnings).toEqual([expect.stringMatching(/no API key configured/)]);
  });

  it("bulksmsbd with api key but no sender id: 0 entries, warning about missing sender id", async () => {
    await upsertGlobalProvider(db, {
      provider: "bulksmsbd",
      enabled: true,
      priority: 1,
      apiKeyEnc: await encryptSecret(testEnv, "k"),
    });

    const { entries, warnings } = await buildDispatchPlan(testEnv, db, 1);
    expect(entries).toHaveLength(0);
    expect(warnings).toEqual([expect.stringMatching(/no sender id/)]);
  });

  it("mimsms with api key + username + senderName: 1 entry", async () => {
    await upsertGlobalProvider(db, {
      provider: "mimsms",
      enabled: true,
      priority: 1,
      apiKeyEnc: await encryptSecret(testEnv, "k"),
      username: "muser",
      senderName: "MSENDER",
    });

    const { entries, warnings } = await buildDispatchPlan(testEnv, db, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.provider.name).toBe("mimsms");
    expect(warnings).toEqual([]);
  });

  it("masking profile matching the label overrides global credentials: 1 entry, no 'matched no provider' warning", async () => {
    await upsertGlobalProvider(db, {
      provider: "bulksmsbd",
      enabled: true,
      priority: 1,
      apiKeyEnc: await encryptSecret(testEnv, "global-key"),
      senderId: "8809",
    });
    await createMaskingProfile(db, {
      appId: 1,
      provider: "bulksmsbd",
      label: "brand",
      senderId: "1234",
    });

    const { entries, warnings } = await buildDispatchPlan(testEnv, db, 1, "brand");
    expect(entries).toHaveLength(1);
    expect(warnings.some((w) => w.includes("matched no provider"))).toBe(false);
  });

  it("masking label that matches no profile: warning, falls back to global credentials", async () => {
    await upsertGlobalProvider(db, {
      provider: "bulksmsbd",
      enabled: true,
      priority: 1,
      apiKeyEnc: await encryptSecret(testEnv, "global-key"),
      senderId: "8809",
    });
    await createMaskingProfile(db, {
      appId: 1,
      provider: "bulksmsbd",
      label: "brand",
      senderId: "1234",
    });

    const { warnings } = await buildDispatchPlan(testEnv, db, 1, "nope");
    expect(warnings.some((w) => w.match(/matched no provider/))).toBe(true);
  });
});

describe("invalidateAllAppConfigs", () => {
  it("purges every app:config:* key, leaving unrelated keys alone", async () => {
    await env.CACHE.put("app:config:1", JSON.stringify({ a: 1 }));
    await env.CACHE.put("app:config:2", JSON.stringify({ a: 2 }));
    await env.CACHE.put("other:key", "keep-me");

    await invalidateAllAppConfigs(env);

    expect(await env.CACHE.get("app:config:1")).toBeNull();
    expect(await env.CACHE.get("app:config:2")).toBeNull();
    expect(await env.CACHE.get("other:key")).toBe("keep-me");
  });
});
