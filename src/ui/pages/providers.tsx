/** GET/POST /providers — global (worker-wide) provider defaults. */

import type { Context } from "hono";
import { getDb } from "../../db";
import { upsertGlobalProviders } from "../../db/queries";
import { invalidateAllAppConfigs } from "../../core/plan";
import { encryptSecret } from "../../shared/crypto";
import { PROVIDER_NAMES } from "../../shared/types";
import type { AppEnv, ProviderName } from "../../shared/types";
import { Panel, PageHeader } from "../components";
import { getGlobalProviderRows } from "../data";
import { redirectFlash, readFlash } from "../flash";
import { Layout } from "../layout";
import { adminPath } from "../paths";
import { formChecked, formStr, formatTs, parseIntOr, providerCredentialError } from "../util";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  bulksmsbd: "BulkSMSBD",
  mimsms: "MimSms",
};

export async function providersGet(c: Context<AppEnv>): Promise<Response> {
  const db = getDb(c.env);
  const rows = await getGlobalProviderRows(db);
  const flash = readFlash(c);

  return c.html(
    <Layout title="Providers" active="providers" flash={flash}>
      <PageHeader
        eyebrow="PROVIDERS"
        title="Global providers"
        sub="Defaults for apps without their own provider plan. Credentials are stored encrypted in D1; changes take effect immediately."
      />
      <Panel flush>
        <form method="post" action={adminPath("/providers")}>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Enabled</th>
                  <th>Priority</th>
                  <th>Sender ID</th>
                  <th>Username</th>
                  <th>Sender name</th>
                  <th>API key</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr>
                    <td>{PROVIDER_LABELS[row.provider]}</td>
                    <td>
                      <input
                        class="check"
                        type="checkbox"
                        name={`${row.provider}_enabled`}
                        value="on"
                        checked={row.enabled}
                      />
                    </td>
                    <td>
                      <input
                        class="input"
                        type="number"
                        name={`${row.provider}_priority`}
                        value={String(row.priority)}
                        style="width:90px"
                      />
                    </td>
                    <td>
                      {row.provider === "bulksmsbd" ? (
                        <input
                          class="input mono"
                          type="text"
                          name={`${row.provider}_senderId`}
                          value={row.senderId ?? ""}
                          placeholder="numeric sender id"
                        />
                      ) : (
                        <span class="muted">Not used</span>
                      )}
                    </td>
                    <td>
                      {row.provider === "mimsms" ? (
                        <input
                          class="input mono"
                          type="text"
                          name={`${row.provider}_username`}
                          value={row.username ?? ""}
                          placeholder="username"
                        />
                      ) : (
                        <span class="muted">Not used</span>
                      )}
                    </td>
                    <td>
                      {row.provider === "mimsms" ? (
                        <input
                          class="input"
                          type="text"
                          name={`${row.provider}_senderName`}
                          value={row.senderName ?? ""}
                          placeholder="sender name"
                        />
                      ) : (
                        <span class="muted">Not used</span>
                      )}
                    </td>
                    <td>
                      <div style="display:flex;flex-direction:column;gap:6px">
                        <span class={row.hasApiKey ? undefined : "muted"}>
                          {row.hasApiKey
                            ? row.updatedAt !== null
                              ? `set · updated ${formatTs(row.updatedAt)}`
                              : "set"
                            : "not set"}
                        </span>
                        <input
                          class="input mono"
                          type="password"
                          name={`${row.provider}_apiKey`}
                          autocomplete="new-password"
                          placeholder="leave blank to keep"
                        />
                        <label
                          class="mono"
                          style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)"
                        >
                          <input class="check" type="checkbox" name={`${row.provider}_clearApiKey`} value="on" />
                          Remove key
                        </label>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="panel-foot">
            <button type="submit" class="btn btn-primary">
              Save
            </button>
          </div>
        </form>
      </Panel>
    </Layout>,
  );
}

export async function providersPost(c: Context<AppEnv>): Promise<Response> {
  const db = getDb(c.env);
  const body = await c.req.parseBody();

  const parsed: {
    provider: ProviderName;
    enabled: boolean;
    priority: number;
    senderId: string | null;
    username: string | null;
    senderName: string | null;
    apiKeyEnc?: string | null;
  }[] = [];

  // Parse and validate every provider's input before writing any of them, so
  // a rejected key on one provider never leaves the other half-saved.
  for (const provider of PROVIDER_NAMES) {
    const enabled = formChecked(body[`${provider}_enabled`]);
    const priority = parseIntOr(formStr(body[`${provider}_priority`]), 0);
    if (priority < 1) return redirectFlash(c, adminPath("/providers"), "Priority must be a positive integer.", "error");
    const senderIdRaw = formStr(body[`${provider}_senderId`]);
    const usernameRaw = formStr(body[`${provider}_username`]);
    const senderNameRaw = formStr(body[`${provider}_senderName`]);
    const apiKeyRaw = formStr(body[`${provider}_apiKey`]);
    const clearApiKey = formChecked(body[`${provider}_clearApiKey`]);

    const credentialError = providerCredentialError({ apiKey: apiKeyRaw, senderId: senderIdRaw, senderName: senderNameRaw, username: usernameRaw });
    if (credentialError) {
      return redirectFlash(
        c,
        adminPath("/providers"),
        credentialError,
        "error",
      );
    }

    const apiKeyEnc = clearApiKey ? null : apiKeyRaw ? await encryptSecret(c.env, apiKeyRaw) : undefined;

    parsed.push({
      provider,
      enabled,
      priority,
      senderId: provider === "bulksmsbd" ? senderIdRaw || null : null,
      username: provider === "mimsms" ? usernameRaw || null : null,
      senderName: provider === "mimsms" ? senderNameRaw || null : null,
      apiKeyEnc,
    });
  }

  await upsertGlobalProviders(db, parsed);

  await invalidateAllAppConfigs(c.env);
  return redirectFlash(c, adminPath("/providers"), "Global provider settings saved.");
}
