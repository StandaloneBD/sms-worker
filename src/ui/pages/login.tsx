/**
 * GET/POST /login. Bootstrap rule: while there are zero admins, only
 * username "admin" with the ADMIN_BOOTSTRAP_PASSWORD secret is accepted and
 * creates that admin row; afterwards it's a normal username/password check.
 * Failures are always the same generic message (no user enumeration).
 */

import type { Context } from "hono";
import { getDb } from "../../db";
import { countAdmins, createAdmin, getAdminByUsername } from "../../db/queries";
import { hashPassword, timingSafeEqualStr, verifyPassword } from "../../shared/crypto";
import type { AppEnv } from "../../shared/types";
import { redirectFlash, readFlash } from "../flash";
import { LoginShell } from "../layout";
import { adminPath } from "../paths";
import { clearSession, createSession, readSession } from "../session";
import { formRaw } from "../util";

const INVALID_CREDENTIALS = "Invalid username or password.";
const TOO_MANY_ATTEMPTS = "Too many sign-in attempts. Wait a minute and try again.";
const BOOTSTRAP_USERNAME = "admin";

function LoginForm({ bootstrap }: { bootstrap: boolean }) {
  return (
    <>
      <h1 class="page-title" style="font-size:20px;margin-bottom:20px">
        Sign in
      </h1>
      <form method="post" action={adminPath("/login")}>
        <div class="field">
          <label for="username">Username</label>
          <input class="input" type="text" id="username" name="username" maxlength={64} required autofocus />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input class="input" type="password" id="password" name="password" required />
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%">
          Sign in
        </button>
      </form>
      {bootstrap ? (
        <p class="hint">
          No admin exists yet. Sign in as {BOOTSTRAP_USERNAME} with the bootstrap password to create the
          first account.
        </p>
      ) : null}
    </>
  );
}

export async function loginGet(c: Context<AppEnv>): Promise<Response> {
  const existing = await readSession(c);
  if (existing !== null) {
    return c.redirect(adminPath("/"), 303);
  }
  const db = getDb(c.env);
  const bootstrap = (await countAdmins(db)) === 0;
  const flash = readFlash(c);
  return c.html(
    <LoginShell title="Sign in" flash={flash}>
      <LoginForm bootstrap={bootstrap} />
    </LoginShell>,
  );
}

export async function loginPost(c: Context<AppEnv>): Promise<Response> {
  const body = await c.req.parseBody();
  const username = formRaw(body.username).trim();
  const password = formRaw(body.password);

  if (!username || !password) {
    return redirectFlash(c, adminPath("/login"), "Username and password are required.", "error");
  }

  if (!(await loginAllowed(c))) {
    return redirectFlash(c, adminPath("/login"), TOO_MANY_ATTEMPTS, "error");
  }

  const db = getDb(c.env);
  const adminCount = await countAdmins(db);

  if (adminCount === 0) {
    const bootstrapPassword = c.env.ADMIN_BOOTSTRAP_PASSWORD ?? "";
    if (
      username !== BOOTSTRAP_USERNAME ||
      !bootstrapPassword ||
      !timingSafeEqualStr(password, bootstrapPassword)
    ) {
      return redirectFlash(c, adminPath("/login"), INVALID_CREDENTIALS, "error");
    }
    const passwordHash = await hashPassword(password);
    const admin = await createAdmin(db, { username: BOOTSTRAP_USERNAME, passwordHash });
    await createSession(c, { adminId: admin.id, version: admin.sessionVersion });
    return c.redirect(adminPath("/"), 303);
  }

  const admin = await getAdminByUsername(db, username);
  const ok = admin ? await verifyPassword(password, admin.passwordHash) : false;
  if (!admin || !ok) {
    return redirectFlash(c, adminPath("/login"), INVALID_CREDENTIALS, "error");
  }

  await createSession(c, { adminId: admin.id, version: admin.sessionVersion });
  return c.redirect(adminPath("/"), 303);
}

/** Per-client-IP attempt limit (LOGIN_LIMITER binding) against password
 *  guessing. Fails open if the limiter itself errors. */
async function loginAllowed(c: Context<AppEnv>): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  try {
    const { success } = await c.env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
    return success;
  } catch (err) {
    console.warn(
      JSON.stringify({ event: "login_rate_limit_failed", error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  }
}

export async function logoutPost(c: Context<AppEnv>): Promise<Response> {
  clearSession(c);
  return c.redirect(adminPath("/login"), 303);
}
