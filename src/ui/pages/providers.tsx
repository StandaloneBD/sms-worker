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
import {
  EnabledSwitch,
  PROVIDER_LABELS,
  PriorityField,
  ProviderOrderFoot,
  ProviderOrderScript,
  ProviderSlot,
  ProviderTitle,
  rankCounter,
} from "../provider-order";
import { formChecked, formStr, formatTs, parseIntOr, providerCredentialError } from "../util";

export async function providersGet(c: Context<AppEnv>): Promise<Response> {
  const db = getDb(c.env);
  // Listed in priority order, which is the order sends try them in.
  const rows = (await getGlobalProviderRows(db)).sort((a, b) => a.priority - b.priority);
  const flash = readFlash(c);
  const nextRank = rankCounter();

  return c.html(
    <Layout title="Providers" active="providers" flash={flash}>
      <PageHeader
        eyebrow="PROVIDERS"
        title="Global providers"
        sub="Defaults for apps without their own provider plan. Credentials are stored encrypted in D1; changes take effect immediately."
      />
      <Panel flush>
        <form method="post" action={adminPath("/providers")}>
          <ol class="prov-list" data-prov-list>
            {rows.map((row) => {
              const id = (field: string) => `${row.provider}-${field}`;
              const rank = nextRank(row.enabled);
              return (
                <li class="prov" data-prov={PROVIDER_LABELS[row.provider]}>
                  <ProviderSlot rank={rank} />

                  <div class="prov-ident">
                    <ProviderTitle provider={row.provider} rank={rank} />
                    <EnabledSwitch provider={row.provider} checked={row.enabled} />
                    <PriorityField provider={row.provider} priority={row.priority} />
                  </div>

                  <div class="prov-fields">
                    {row.provider === "bulksmsbd" ? (
                      <div class="field">
                        <label for={id("sender-id")}>Sender ID</label>
                        <input
                          class="input mono"
                          type="text"
                          id={id("sender-id")}
                          name={`${row.provider}_senderId`}
                          value={row.senderId ?? ""}
                          placeholder="Numeric sender ID"
                        />
                      </div>
                    ) : null}
                    {row.provider === "mimsms" ? (
                      <>
                        <div class="field">
                          <label for={id("username")}>Username</label>
                          <input
                            class="input mono"
                            type="text"
                            id={id("username")}
                            name={`${row.provider}_username`}
                            value={row.username ?? ""}
                          />
                        </div>
                        <div class="field">
                          <label for={id("sender-name")}>Sender name</label>
                          <input
                            class="input"
                            type="text"
                            id={id("sender-name")}
                            name={`${row.provider}_senderName`}
                            value={row.senderName ?? ""}
                          />
                        </div>
                      </>
                    ) : null}
                    <div class="field prov-key">
                      <div class="prov-key-head">
                        <label for={id("api-key")}>API key</label>
                        <span class={row.hasApiKey ? "badge badge-on" : "badge"}>
                          {row.hasApiKey ? "Saved" : "Not set"}
                        </span>
                      </div>
                      <input
                        class="input mono"
                        type="password"
                        id={id("api-key")}
                        name={`${row.provider}_apiKey`}
                        autocomplete="new-password"
                        placeholder={row.hasApiKey ? "Leave blank to keep" : "Paste API key"}
                      />
                      {row.hasApiKey ? (
                        <div class="prov-key-foot">
                          {row.updatedAt !== null ? <span>Updated {formatTs(row.updatedAt)}</span> : <span />}
                          <label>
                            <input class="check" type="checkbox" name={`${row.provider}_clearApiKey`} value="on" />
                            Remove key
                          </label>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          <ProviderOrderFoot saveLabel="Save providers" />
        </form>
      </Panel>
      <ProviderOrderScript />
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
  return redirectFlash(c, adminPath("/providers"), "Providers saved.");
}
