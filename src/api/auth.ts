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
import { AUTH_CACHE_TTL_SECONDS, kvAppByKeyHash } from "../shared/constants";
import { toAuthedApp, writeAppAuthCache, type AuthCacheMetadata } from "../core/auth-cache";
import type { AppEnv, AuthedApp } from "../shared/types";

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/** Key hash → the verdict this isolate last confirmed is in KV, and until
 *  when to trust that. Lets the request path skip KV while the outage shield
 *  is known to be current. Bounded so a flood of distinct keys can't grow it
 *  unchecked. */
const confirmedInCache = new Map<string, { serialized: string; until: number }>();
const CONFIRMED_CACHE_MAX = 1000;
const AUTH_CACHE_TTL_MS = AUTH_CACHE_TTL_SECONDS * 1000;
/** Longest an isolate goes without re-reading an entry it confirmed. */
const CONFIRM_FOR_MS = AUTH_CACHE_TTL_MS / 2;
/** An entry this close to expiry is rewritten, and one is trusted only up to
 *  this long before its expiry, so the shield is renewed before it lapses
 *  rather than up to CONFIRM_FOR_MS after. */
const REFRESH_BEFORE_EXPIRY_MS = AUTH_CACHE_TTL_MS / 6;

function isAuthedApp(value: unknown): value is AuthedApp {
  const v = value as AuthedApp | null;
  return (
    !!v &&
    Number.isSafeInteger(v.id) &&
    v.id > 0 &&
    typeof v.name === "string" &&
    typeof v.isActive === "boolean" &&
    (v.ipAllowlist === undefined ||
      (Array.isArray(v.ipAllowlist) && v.ipAllowlist.every((entry) => typeof entry === "string")))
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
 *  most once per key per isolate per CONFIRM_FOR_MS, and writes only when the
 *  entry is missing, differs, or is about to expire — KV writes must stay
 *  rare (Workers Free: 1,000/day). Entries expire, so a write that races a
 *  key rotation can outlive it by at most AUTH_CACHE_TTL_SECONDS. */
async function syncAuthCache(env: Env, hash: string, authed: AuthedApp): Promise<void> {
  const serialized = JSON.stringify(authed);
  const now = Date.now();
  const confirmed = confirmedInCache.get(hash);
  if (confirmed && confirmed.serialized === serialized && confirmed.until > now) return;

  let expiresAt = 0;
  try {
    const { value, metadata } = await env.CACHE.getWithMetadata<AuthCacheMetadata>(kvAppByKeyHash(hash), "text");
    // An entry written before metadata existed has an unknown expiry: rewrite it.
    if (value === serialized && typeof metadata?.writtenAt === "number") {
      expiresAt = metadata.writtenAt + AUTH_CACHE_TTL_MS;
    }
  } catch (err) {
    console.warn(
      JSON.stringify({ event: "auth_cache_get_failed", error: err instanceof Error ? err.message : String(err) }),
    );
  }
  if (expiresAt - now < REFRESH_BEFORE_EXPIRY_MS) {
    await writeAppAuthCache(env, hash, authed);
    expiresAt = now + AUTH_CACHE_TTL_MS;
  }
  if (confirmedInCache.size >= CONFIRMED_CACHE_MAX) confirmedInCache.clear();
  confirmedInCache.set(hash, { serialized, until: Math.min(now + CONFIRM_FOR_MS, expiresAt - REFRESH_BEFORE_EXPIRY_MS) });
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
    authed = toAuthedApp(row);
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
