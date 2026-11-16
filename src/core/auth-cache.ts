/**
 * KV auth-cache helpers for the app-facing API (ADR 0003: D1-first,
 * KV-fallback). D1 is authoritative when reachable; these helpers keep the
 * KV shield in sync with it so a D1 outage can't resurrect a rotated or
 * deactivated key. Mirrors `invalidateAppConfig` in `src/core/plan.ts`:
 * best-effort, swallow-and-log, never throw or block the caller on KV.
 */

import type { apps } from "../db/schema";
import { AUTH_CACHE_TTL_SECONDS, kvAppByKeyHash } from "../shared/constants";
import type { AuthedApp } from "../shared/types";

type AppAuthFields = Pick<
  typeof apps.$inferSelect,
  "id" | "name" | "isActive" | "dailyQuota" | "ipAllowlistEnabled" | "ipAllowlist"
>;

/** The auth verdict for an apps row: what the API sees as c.var.app, and
 *  what the KV shield caches. The allowlist is left out while it's off. */
export function toAuthedApp(app: AppAuthFields): AuthedApp {
  return {
    id: app.id,
    name: app.name,
    isActive: app.isActive,
    dailyQuota: app.dailyQuota,
    ...(app.ipAllowlistEnabled ? { ipAllowlist: app.ipAllowlist } : {}),
  };
}

/** KV metadata on an auth-cache entry: when it was written (ms), so a reader
 *  knows when it expires — KV doesn't say. */
export interface AuthCacheMetadata {
  writtenAt: number;
}

export async function writeAppAuthCache(
  env: Env,
  keyHash: string,
  authed: AuthedApp,
): Promise<void> {
  const metadata: AuthCacheMetadata = { writtenAt: Date.now() };
  await env.CACHE.put(kvAppByKeyHash(keyHash), JSON.stringify(authed), {
    expirationTtl: AUTH_CACHE_TTL_SECONDS,
    metadata,
  }).catch((err: unknown) => {
    console.warn(
      JSON.stringify({ event: "auth_cache_write_failed", error: String(err) }),
    );
  });
}

export async function invalidateAppAuthCache(env: Env, keyHash: string): Promise<void> {
  await env.CACHE.delete(kvAppByKeyHash(keyHash)).catch((err: unknown) => {
    console.warn(
      JSON.stringify({ event: "auth_cache_delete_failed", error: String(err) }),
    );
  });
}
