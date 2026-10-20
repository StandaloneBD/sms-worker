/**
 * KV auth-cache helpers for the app-facing API (ADR 0003: D1-first,
 * KV-fallback). D1 is authoritative when reachable; these helpers keep the
 * KV shield in sync with it so a D1 outage can't resurrect a rotated or
 * deactivated key. Mirrors `invalidateAppConfig` in `src/core/plan.ts`:
 * best-effort, swallow-and-log, never throw or block the caller on KV.
 */

import { kvAppByKeyHash } from "../shared/constants";
import type { AuthedApp } from "../shared/types";

export async function writeAppAuthCache(
  env: Env,
  keyHash: string,
  authed: AuthedApp,
): Promise<void> {
  // No TTL: the request path no longer re-reads KV to refresh an expiring
  // entry (it confirms each key once per isolate), so an expired entry would
  // leave the outage shield cold. Admin mutations overwrite or delete it.
  await env.CACHE.put(kvAppByKeyHash(keyHash), JSON.stringify(authed)).catch((err: unknown) => {
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
