/**
 * Cookie-backed admin sessions (hono/cookie) + the two cross-cutting
 * middlewares every admin route runs through: auth (redirect to /login when
 * there's no valid session) and CSRF (reject cross-host POSTs).
 *
 * Registration order matters in Hono: a middleware only applies to routes
 * registered *after* it. adminRoutes registers csrfMiddleware first (so it
 * covers every POST, including /login), then the public /login routes, then
 * authMiddleware, then everything else — see src/ui/index.tsx.
 */

import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getDb } from "../db";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "../shared/constants";
import { signSession, verifySession, type SessionClaims } from "../shared/crypto";
import type { AppEnv } from "../shared/types";
import { getAdminById } from "./data";
import { adminPath } from "./paths";

function isHttps(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/** Signs a fresh session token (exp = now + SESSION_TTL_SECONDS) and sets the cookie. */
export async function createSession(c: Context<AppEnv>, claims: SessionClaims): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession(c.env, claims, expiresAt);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isHttps(c),
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Clears the session cookie (logout). */
export function clearSession(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * Reads + verifies the session cookie, returning the admin id or null. Never
 * logs the token. Beyond the signature and expiry, the admin must still
 * exist and the token's session version must match the row's — a password
 * change bumps it, signing out every other session.
 */
export async function readSession(c: Context<AppEnv>): Promise<number | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const claims = await verifySession(c.env, token);
  if (!claims) return null;
  const admin = await getAdminById(getDb(c.env), claims.adminId);
  return admin && admin.sessionVersion === claims.version ? admin.id : null;
}

/** Gate for every route registered after this middleware: no valid session → redirect to /login. */
export async function authMiddleware(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const adminId = await readSession(c);
  if (adminId === null) {
    return c.redirect(adminPath("/login"), 303);
  }
  c.set("adminId", adminId);
  await next();
}

/** CSRF guard for all POSTs: a present Origin header whose host differs from the request host is rejected. */
export async function csrfMiddleware(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  if (c.req.method === "POST") {
    const origin = c.req.header("Origin");
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return c.text("Forbidden: invalid Origin", 403);
      }
      const requestHost = new URL(c.req.url).host;
      if (originHost !== requestHost) {
        return c.text("Forbidden: cross-origin request", 403);
      }
    }
  }
  await next();
}
