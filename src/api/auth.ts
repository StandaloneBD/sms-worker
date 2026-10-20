/**
 * Bearer-token auth middleware for the app-facing API (ADR 0003: D1-first,
 * KV-fallback — supersedes the KV-cache-first read order from ADR 0002).
 * D1 is authoritative whenever it's reachable, so key rotation and app
 * deactivation take effect immediately; ADR 0002's intent is preserved as
 * the outage path — a warm cache still lets requests through a D1 outage,
 * and a cold cache during an outage still fails closed with 503.
 */

import { createMiddleware } from "hono/factory";
import { getAppByKeyHash, getDb } from "../db";
import { sha256Hex } from "../shared/crypto";
import { kvAppByKeyHash } from "../shared/constants";
import { writeAppAuthCache } from "../core/auth-cache";
import type { AppEnv, AuthedApp } from "../shared/types";

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token = parseBearerToken(c.req.header("authorization"));
  if (!token || !token.startsWith("sk_")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const hash = await sha256Hex(token);
  const cacheKey = kvAppByKeyHash(hash);

  let cached: AuthedApp | null = null;
  try {
    const value = await c.env.CACHE.get<AuthedApp>(cacheKey, "json");
    if (value && Number.isSafeInteger(value.id) && value.id > 0 && typeof value.name === "string" && typeof value.isActive === "boolean") cached = value;
  } catch (err) {
    // KV failures are swallowed — D1 is queried regardless, below.
    console.warn(
      JSON.stringify({
        event: "auth_cache_get_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    cached = null;
  }

  let authed: AuthedApp | null;
  try {
    const db = getDb(c.env);
    const row = await getAppByKeyHash(db, hash);
    if (!row) {
      return c.json({ error: "unauthorized" }, 401);
    }
    authed = { id: row.id, name: row.name, isActive: row.isActive };

    // Refresh KV only when it's missing or stale so rotation/deactivation
    // aren't undone by a write racing an already-correct cache. KV writes
    // must stay rare (Workers Free: 1,000/day) — this keeps it to at most
    // one per key per TTL window in the common case.
    if (!cached || JSON.stringify(cached) !== JSON.stringify(authed)) {
      const authedForCache = authed;
      c.executionCtx.waitUntil(writeAppAuthCache(c.env, hash, authedForCache));
    }
  } catch (err) {
    // D1 unreachable: fall back to the warm cache (outage shield, ADR 0003).
    console.error(
      JSON.stringify({
        event: "auth_d1_lookup_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    if (!cached) {
      return c.json({ error: "service unavailable" }, 503);
    }
    authed = cached;
  }

  if (!authed.isActive) {
    return c.json({ error: "forbidden" }, 403);
  }

  c.set("app", authed);
  await next();
});
