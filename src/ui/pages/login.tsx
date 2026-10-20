/**
 * GET/POST /login. Bootstrap rule: while there are zero admins, only
 * username "admin" with the ADMIN_BOOTSTRAP_PASSWORD secret is accepted and
 * creates that admin row; afterwards it's a normal username/password check.
 * Failures are always the same generic message (no user enumeration).
 */

import type { Context } from "hono";
import { getDb, isUniqueConstraintError } from "../../db";
import { MAX_PASSWORD_LENGTH } from "../../shared/constants";
import { countAdmins, createAdmin, getAdminByUsername } from "../../db/queries";
import { hashPassword, timingSafeEqualStr, verifyPassword } from "../../shared/crypto";
import type { AppEnv } from "../../shared/types";
import { redirectFlash, readFlash } from "../flash";
import { LoginShell } from "../layout";
import { adminPath } from "../paths";
import { clearSession, createSession, readSession } from "../session";
import { formRaw } from "../util";

const INVALID_CREDENTIALS = "Invalid username or password.";
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
  const limit = await c.env.LOGIN_RATE_LIMIT.limit({ key: `sms-worker:admin-login:${c.req.header("CF-Connecting-IP") ?? "local"}` });
  if (!limit.success) {
    c.header("Retry-After", "60");
    return c.text("Too many sign-in attempts. Try again in a minute.", 429);
  }
  const body = await c.req.parseBody();
  const username = formRaw(body.username).trim();
  const password = formRaw(body.password);

  if (!username || !password) {
    return redirectFlash(c, adminPath("/login"), "Username and password are required.", "error");
  }
  if (username.length > 64 || password.length > MAX_PASSWORD_LENGTH) {
    return redirectFlash(c, adminPath("/login"), INVALID_CREDENTIALS, "error");
  }

  const db = getDb(c.env);
  const adminCount = await countAdmins(db);

  if (adminCount === 0) {
    const bootstrapPassword = c.env.ADMIN_BOOTSTRAP_PASSWORD ?? "";
    if (
      username !== BOOTSTRAP_USERNAME ||
      !bootstrapPassword ||
      !(await timingSafeEqualStr(password, bootstrapPassword))
    ) {
      return redirectFlash(c, adminPath("/login"), INVALID_CREDENTIALS, "error");
    }
    const passwordHash = await hashPassword(password);
    let admin;
    try {
      admin = await createAdmin(db, { username: BOOTSTRAP_USERNAME, passwordHash });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // Another first login may have won the insert while PBKDF2 ran.
      admin = await getAdminByUsername(db, BOOTSTRAP_USERNAME);
      if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
        return redirectFlash(c, adminPath("/login"), INVALID_CREDENTIALS, "error");
      }
    }
    await createSession(c, admin.id, admin.passwordHash);
    return c.redirect(adminPath("/"), 303);
  }

  const admin = await getAdminByUsername(db, username);
  const ok = admin ? await verifyPassword(password, admin.passwordHash) : false;
  if (!admin || !ok) {
    return redirectFlash(c, adminPath("/login"), INVALID_CREDENTIALS, "error");
  }

  await createSession(c, admin.id, admin.passwordHash);
  return c.redirect(adminPath("/"), 303);
}

export async function logoutPost(c: Context<AppEnv>): Promise<Response> {
  clearSession(c);
  return c.redirect(adminPath("/login"), 303);
}
