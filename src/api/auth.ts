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

/** Key hash → the verdict this isolate last confirmed is in KV. Lets the
 *  request path skip KV entirely once the outage shield is known to be
 *  current; bounded so a flood of distinct keys can't grow it unchecked. */
const confirmedInCache = new Map<string, string>();
const CONFIRMED_CACHE_MAX = 1000;

function isAuthedApp(value: unknown): value is AuthedApp {
  const v = value as AuthedApp | null;
  return (
    !!v &&
    Number.isSafeInteger(v.id) &&
    v.id > 0 &&
    typeof v.name === "string" &&
    typeof v.isActive === "boolean"
  );
}

async function readAuthCache(env: Env, hash: string): Promise<AuthedApp | null> {
  try {
    const value = await env.CACHE.get<AuthedApp>(kvAppByKeyHash(hash), "json");
    // Only trust a cache entry with the expected shape.
    return isAuthedApp(value) ? value : null;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "auth_cache_get_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** Brings the KV shield in line with D1, off the request path. Reads KV at
 *  most once per key per isolate, and writes only when the entry is missing
 *  or differs — KV writes must stay rare (Workers Free: 1,000/day). */
async function syncAuthCache(env: Env, hash: string, authed: AuthedApp): Promise<void> {
  const serialized = JSON.stringify(authed);
  if (confirmedInCache.get(hash) === serialized) return;
  const cached = await readAuthCache(env, hash);
  if (!cached || JSON.stringify(cached) !== serialized) {
    await writeAppAuthCache(env, hash, authed);
  }
  if (confirmedInCache.size >= CONFIRMED_CACHE_MAX) confirmedInCache.clear();
  confirmedInCache.set(hash, serialized);
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token = parseBearerToken(c.req.header("authorization"));
  if (!token || !token.startsWith("sk_")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const hash = await sha256Hex(token);

  let authed: AuthedApp | null;
  try {
    const db = getDb(c.env);
    const row = await getAppByKeyHash(db, hash);
    if (!row) {
      return c.json({ error: "unauthorized" }, 401);
    }
    authed = { id: row.id, name: row.name, isActive: row.isActive, dailyQuota: row.dailyQuota };
    c.executionCtx.waitUntil(syncAuthCache(c.env, hash, authed));
  } catch (err) {
    // D1 unreachable: fall back to the warm cache (outage shield, ADR 0003).
    console.error(
      JSON.stringify({
        event: "auth_d1_lookup_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    authed = await readAuthCache(c.env, hash);
    if (!authed) {
      return c.json({ error: "service unavailable" }, 503);
    }
  }

  if (!authed.isActive) {
    return c.json({ error: "forbidden" }, 403);
  }

  c.set("app", authed);
  await next();
});
