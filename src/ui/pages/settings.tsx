/** GET/POST /settings — the signed-in admin changes their own password. */

import type { Context } from "hono";
import { getDb } from "../../db";
import { updateAdminPassword } from "../../db/queries";
import { hashPassword, verifyPassword } from "../../shared/crypto";
import type { AppEnv } from "../../shared/types";
import { Kv, Panel, PageHeader } from "../components";
import { getAdminById } from "../data";
import { redirectFlash, readFlash } from "../flash";
import { Layout } from "../layout";
import { adminPath } from "../paths";
import { createSession } from "../session";
import { MAX_PASSWORD_LENGTH } from "../../shared/constants";
import { formRaw } from "../util";

const MIN_PASSWORD_LENGTH = 8;

export async function settingsGet(c: Context<AppEnv>): Promise<Response> {
  const db = getDb(c.env);
  const adminId = c.get("adminId");
  const admin = await getAdminById(db, adminId);
  const flash = readFlash(c);

  return c.html(
    <Layout title="Settings" active="settings" flash={flash} adminName={admin?.username}>
      <PageHeader eyebrow="SETTINGS" title="Account" />
      <Panel>
        <Kv
          items={[
            {
              label: "Signed in as",
              value: <span class="mono">{admin?.username ?? `admin #${adminId}`}</span>,
            },
          ]}
        />
      </Panel>
      <Panel title="Change password">
        <form method="post" action={adminPath("/settings")}>
          <div class="field field-narrow">
            <label for="current-password">Current password</label>
            <input class="input" type="password" id="current-password" name="currentPassword" required />
          </div>
          <div class="field field-narrow">
            <label for="new-password">New password</label>
            <input
              class="input"
              type="password"
              id="new-password"
              name="newPassword"
              minlength={MIN_PASSWORD_LENGTH}
              required
            />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              Update password
            </button>
          </div>
        </form>
      </Panel>
    </Layout>,
  );
}

export async function settingsPost(c: Context<AppEnv>): Promise<Response> {
  const adminId = c.get("adminId");
  const body = await c.req.parseBody();
  const currentPassword = formRaw(body.currentPassword);
  const newPassword = formRaw(body.newPassword);

  if (
    newPassword.length < MIN_PASSWORD_LENGTH ||
    newPassword.length > MAX_PASSWORD_LENGTH ||
    currentPassword.length > MAX_PASSWORD_LENGTH
  ) {
    return redirectFlash(
      c,
      adminPath("/settings"),
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
      "error",
    );
  }

  const db = getDb(c.env);
  const admin = await getAdminById(db, adminId);
  if (!admin || !(await verifyPassword(currentPassword, admin.passwordHash))) {
    return redirectFlash(c, adminPath("/settings"), "Current password is incorrect.", "error");
  }

  const newHash = await hashPassword(newPassword);
  const version = await updateAdminPassword(db, adminId, newHash);
  // The bump signed out every session, this one included — re-issue it.
  if (version !== undefined) await createSession(c, { adminId, version });
  return redirectFlash(c, adminPath("/settings"), "Password updated. Other sessions were signed out.");
}
