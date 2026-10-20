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
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "../shared/constants";
import { signSession, verifySession } from "../shared/crypto";
import type { AppEnv } from "../shared/types";
import { adminPath } from "./paths";
import { getDb } from "../db";
import { getAdminById } from "./data";

function isHttps(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/** Signs a fresh session token (exp = now + SESSION_TTL_SECONDS) and sets the cookie. */
export async function createSession(c: Context<AppEnv>, adminId: number, passwordHash: string): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession(c.env, adminId, expiresAt, passwordHash);
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

/** Reads + verifies the session cookie, returning the admin id or null. Never logs the token. */
export async function readSession(c: Context<AppEnv>): Promise<number | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const adminId = Number(parts[0]);
  const exp = Number(parts[1]);
  if (!Number.isSafeInteger(adminId) || adminId <= 0 || !Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
  const admin = await getAdminById(getDb(c.env), adminId);
  if (!admin) return null;
  return verifySession(c.env, token, admin.passwordHash);
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

/** Browser POSTs must come from the same origin, including scheme/port. */
export async function csrfMiddleware(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  if (c.req.method === "POST") {
    const origin = c.req.header("Origin");
    if (c.req.header("Sec-Fetch-Site") === "cross-site") return c.text("Forbidden: cross-origin request", 403);
    const source = origin ?? c.req.header("Referer");
    if (source) {
      let sourceOrigin: string;
      try {
        sourceOrigin = new URL(source).origin;
      } catch {
        return c.text("Forbidden: invalid Origin", 403);
      }
      if (sourceOrigin !== new URL(c.req.url).origin) {
        return c.text("Forbidden: cross-origin request", 403);
      }
    }
  }
  await next();
}
