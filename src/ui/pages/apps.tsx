/**
 * GET/POST /apps (list + create) and an App's configuration page
 * (/apps/:id/config): activate toggle, key rotation, IP allowlist, daily quota, provider
 * plan, masking profiles, and template create/delete (edit lives on its own
 * page, see ./templates). Its overview, jobs and messages are ./app-overview,
 * ./jobs and ./messages.
 */

import type { Context } from "hono";
import { getDb, isUniqueConstraintError } from "../../db";
import {
  createApp,
  createMaskingProfile,
  createTemplate,
  deleteMaskingProfile,
  deleteTemplate,
  getAppById,
  getAppUsage,
  listApps,
  listMaskingProfiles,
  listTemplates,
  rotateAppKey,
  setAppActive,
  setAppDailyQuota,
  setAppIpAllowlist,
  upsertAppProviders,
} from "../../db/queries";
import { invalidateAppConfig } from "../../core/plan";
import { invalidateAppAuthCache, toAuthedApp, writeAppAuthCache } from "../../core/auth-cache";
import { encryptSecret, generateApiKey } from "../../shared/crypto";
import {
  MAX_IP_ALLOWLIST_ENTRIES,
  MAX_MESSAGE_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  usageDay,
} from "../../shared/constants";
import { normalizeIpEntry } from "../../shared/ip";
import { PROVIDER_NAMES } from "../../shared/types";
import type { AppEnv, ProviderName } from "../../shared/types";
import { AppHeader, Empty, Kv, NotFoundPage, PageHeader, Panel, Segments } from "../components";
import { getAppProviderRows } from "../data";
import { redirectFlash, readFlash } from "../flash";
import type { Flash } from "../flash";
import { Layout } from "../layout";
import { adminPath, appPath } from "../paths";
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
import { formChecked, formatTs, formStr, parseId, parseIntOr, providerCredentialError } from "../util";

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function ApiKeyReveal({ appName, backHref, apiKey }: { appName: string; backHref: string; apiKey: string }) {
  return (
    <Layout title="API key" active="apps">
      <PageHeader eyebrow="API KEY" title={appName} sub="Shown once. Store it now — only a hash is kept." />
      <Panel>
        <div class="key-reveal">{apiKey}</div>
        <a class="btn btn-primary" href={backHref}>
          Done
        </a>
      </Panel>
    </Layout>
  );
}

/* ------------------------------------------------------------------ */
/* List + create                                                       */
/* ------------------------------------------------------------------ */

export async function appsListGet(c: Context<AppEnv>): Promise<Response> {
  const db = getDb(c.env);
  const apps = await listApps(db);
  const flash = readFlash(c);

  return c.html(
    <Layout title="Apps" active="apps" flash={flash}>
      <PageHeader eyebrow="APPS" title="Apps" />

      <Panel flush>
        {apps.length === 0 ? (
          <Empty title="No apps yet." hint="Register one below to get an API key." />
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key prefix</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr>
                    <td>
                      <a class="app-link" href={appPath(app.id)}>{app.name}</a>
                    </td>
                    <td class="mono">{app.keyPrefix}</td>
                    <td>
                      <span class={`badge ${app.isActive ? "badge-on" : "badge-off"}`}>
                        {app.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td class="mono">{formatTs(app.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Register app">
        <form method="post" action={adminPath("/apps")}>
          <div class="form-row">
            <div class="field">
              <label for="name">Name</label>
              <input class="input" type="text" id="name" name="name" maxlength={64} required />
            </div>
            <button type="submit" class="btn btn-primary" style="align-self:flex-end">
              Register app
            </button>
          </div>
        </form>
      </Panel>
    </Layout>,
  );
}

export async function appsCreatePost(c: Context<AppEnv>): Promise<Response> {
  const body = await c.req.parseBody();
  const name = formStr(body.name);

  if (name.length < 1 || name.length > 64) {
    return redirectFlash(c, adminPath("/apps"), "App name must be 1-64 characters.", "error");
  }

  const db = getDb(c.env);
  const generated = await generateApiKey();

  let app: { id: number; name: string };
  try {
    app = await createApp(db, { name, keyHash: generated.hash, keyPrefix: generated.prefix });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return redirectFlash(c, adminPath("/apps"), `An app named "${name}" already exists.`, "error");
  }

  return c.html(
    <ApiKeyReveal appName={app.name} backHref={appPath(app.id)} apiKey={generated.key} />,
  );
}

/* ------------------------------------------------------------------ */
/* Configuration                                                               */
/* ------------------------------------------------------------------ */

export async function appConfigGet(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.html(<NotFoundPage flash={readFlash(c)} what="App" />, 404);
  }

  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) {
    return c.html(<NotFoundPage flash={readFlash(c)} what="App" />, 404);
  }
  return renderAppConfig(c, app, { flash: readFlash(c) });
}

type AppRow = NonNullable<Awaited<ReturnType<typeof getAppById>>>;

/** An IP allowlist submission that failed validation, shown back in the form
 *  so the admin can correct it instead of typing it all again. */
interface IpAllowlistDraft {
  enabled: boolean;
  entries: string;
}

async function renderAppConfig(
  c: Context<AppEnv>,
  app: AppRow,
  opts: { flash?: Flash; ipAllowlistDraft?: IpAllowlistDraft },
): Promise<Response> {
  const db = getDb(c.env);
  const [providerRows, profiles, templates, usedToday] = await Promise.all([
    getAppProviderRows(db, app.id),
    listMaskingProfiles(db, app.id),
    listTemplates(db, app.id),
    getAppUsage(db, app.id, usageDay()),
  ]);
  const { flash, ipAllowlistDraft } = opts;
  // Listed in priority order, which is the order this app's sends try them in.
  const planRows = [...providerRows].sort((a, b) => a.priority - b.priority);
  const nextRank = rankCounter();

  return c.html(
    <Layout title={`Configuration · ${app.name}`} active="apps" flash={flash}>
      <AppHeader app={app} tab="config" />

      <nav class="jump" aria-label="Configuration sections">
        <a href="#access">Access</a>
        <a href="#ip-allowlist">IP allowlist</a>
        <a href="#quota">Daily quota</a>
        <a href="#providers">Provider plan</a>
        <a href="#masking">Masking profiles</a>
        <a href="#templates">Templates</a>
      </nav>

      <Panel
        id="access"
        title="Access"
        actions={
          <>
            <form method="post" action={adminPath(`/apps/${app.id}/active`)}>
              <input type="hidden" name="active" value={app.isActive ? "false" : "true"} />
              <button type="submit" class="btn btn-sm">
                {app.isActive ? "Deactivate app" : "Activate app"}
              </button>
            </form>
            <form
              method="post"
              action={adminPath(`/apps/${app.id}/rotate-key`)}
              data-confirm="Rotate this app’s API key? The current key will stop working immediately."
            >
              <button type="submit" class="btn btn-danger btn-sm">
                Rotate key
              </button>
            </form>
          </>
        }
      >
        <Kv
          items={[
            {
              label: "Status",
              value: app.isActive ? "Active: its API key is accepted" : "Inactive: its API key is refused (403)",
            },
            { label: "Key prefix", value: <span class="mono">{app.keyPrefix}</span> },
            { label: "Registered", value: <span class="mono">{formatTs(app.createdAt)}</span> },
          ]}
        />
      </Panel>

      <Panel id="ip-allowlist" title="IP allowlist">
        <form method="post" action={adminPath(`/apps/${app.id}/ip-allowlist`)}>
          <div class="field">
            <label class="switch-label">
              <input
                class="switch"
                type="checkbox"
                name="enabled"
                value="on"
                checked={ipAllowlistDraft ? ipAllowlistDraft.enabled : app.ipAllowlistEnabled}
              />
              Only these addresses may send or make changes
            </label>
          </div>
          <div class="field field-narrow">
            <label for="ip-allowlist-entries">Addresses, one per line</label>
            <textarea
              class="input mono"
              id="ip-allowlist-entries"
              name="entries"
              rows={4}
              placeholder={"203.0.113.7\n198.51.100.0/28\n2001:db8::/48"}
            >{ipAllowlistDraft ? ipAllowlistDraft.entries : app.ipAllowlist.join("\n")}</textarea>
          </div>
          <p class="hint">
            IPv4 or IPv6 addresses, or CIDR ranges. When on, sends, jobs and template or provider changes from
            any other address get a 403; reads such as job status stay open. A server with IPv6 usually reaches
            the API over IPv6, so add its IPv6 address too. The list is kept while switched off.
          </p>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              Save IP allowlist
            </button>
          </div>
        </form>
      </Panel>

      <Panel id="quota" title="Daily quota">
        <form method="post" action={adminPath(`/apps/${app.id}/quota`)}>
          <div class="field field-narrow">
            <label for="daily-quota">Max recipients per UTC day ({usedToday} used today)</label>
            <input
              class="input"
              type="number"
              id="daily-quota"
              name="dailyQuota"
              min={1}
              value={app.dailyQuota === null ? "" : String(app.dailyQuota)}
              placeholder="unlimited"
            />
          </div>
          <p class="hint">
            Sends and jobs that would take the app past this get a 429. Bounds what a leaked API key can
            cost. Leave blank for no limit.
          </p>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              Save quota
            </button>
          </div>
        </form>
      </Panel>

      <Panel id="providers" title="Provider plan" flush>
        <form method="post" action={adminPath(`/apps/${app.id}/providers`)}>
          <ol class="prov-list is-compact" data-prov-list>
            {planRows.map((row) => {
              const rank = nextRank(row.enabled && row.globallyEnabled);
              return (
                <li
                  class="prov"
                  data-prov={PROVIDER_LABELS[row.provider]}
                  data-prov-off={row.globallyEnabled ? undefined : true}
                >
                  <ProviderSlot rank={rank} />
                  <div class="prov-ident">
                    <ProviderTitle provider={row.provider} rank={rank} globallyOff={!row.globallyEnabled} />
                  </div>
                  <div class="prov-controls">
                    <EnabledSwitch provider={row.provider} checked={row.enabled} />
                    <PriorityField provider={row.provider} priority={row.priority} />
                  </div>
                </li>
              );
            })}
          </ol>
          <ProviderOrderFoot
            saveLabel="Save provider plan"
            note={planRows[0]?.inherited ? "This app follows the global order until you save a plan here." : undefined}
          />
        </form>
      </Panel>
      <ProviderOrderScript />

      <Panel id="masking" title="Masking profiles" flush>
        {profiles.length === 0 ? (
          <Empty title="No masking profiles." hint="Add one below when a customer buys SMS masking." />
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Provider</th>
                  <th>Sender ID</th>
                  <th>Sender name</th>
                  <th>Username</th>
                  <th>API key</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr>
                    <td>{profile.label}</td>
                    <td>{PROVIDER_LABELS[profile.provider]}</td>
                    <td class="mono">{profile.senderId ?? "—"}</td>
                    <td>{profile.senderName ?? "—"}</td>
                    <td class="mono">{profile.username ?? "—"}</td>
                    <td>{profile.apiKeyEnc ? "Set" : "—"}</td>
                    <td>
                      <form
                        method="post"
                        action={adminPath(`/apps/${app.id}/masking-profiles/${profile.id}/delete`)}
                        data-confirm="Delete this masking profile? This cannot be undone."
                      >
                        <button type="submit" class="btn btn-danger btn-sm">
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div class="panel-foot">
          <form method="post" action={adminPath(`/apps/${app.id}/masking-profiles`)}>
            <div class="form-row">
              <div class="field">
                <label for="mp-provider">Provider</label>
                <select class="select" id="mp-provider" name="provider" required>
                  {PROVIDER_NAMES.map((p) => (
                    <option value={p}>{PROVIDER_LABELS[p]}</option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label for="mp-label">Label</label>
                <input class="input" type="text" id="mp-label" name="label" maxlength={32} required />
              </div>
            </div>
            <div class="form-row">
              <div class="field">
                <label for="mp-sender-id">Sender ID (BulkSMSBD)</label>
                <input class="input mono" type="text" id="mp-sender-id" name="senderId" />
              </div>
              <div class="field">
                <label for="mp-sender-name">Sender name (MimSms)</label>
                <input class="input" type="text" id="mp-sender-name" name="senderName" />
              </div>
              <div class="field">
                <label for="mp-username">Username (MimSms)</label>
                <input class="input mono" type="text" id="mp-username" name="username" />
              </div>
            </div>
            <div class="form-row">
              <div class="field">
                <label for="mp-api-key">API key override</label>
                <input class="input mono" type="text" id="mp-api-key" name="apiKey" autocomplete="off" />
              </div>
            </div>
            <button type="submit" class="btn btn-primary">
              Add profile
            </button>
          </form>
        </div>
      </Panel>

      <Panel id="templates" title="Templates" flush>
        {templates.length === 0 ? (
          <Empty title="No templates." hint="Add one below." />
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th class="num" title="Pass this as templateId in the send API">ID</th>
                  <th>Name</th>
                  <th>Body</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {templates.map((tpl) => (
                  <tr>
                    <td class="num mono">{tpl.id}</td>
                    <td>{tpl.name}</td>
                    <td class="cell-wrap">
                      <div class="mono">{tpl.body}</div>
                      <Segments body={tpl.body} />
                    </td>
                    <td class="mono">{formatTs(tpl.updatedAt)}</td>
                    <td>
                      <div style="display:flex;gap:8px">
                        <a class="btn btn-sm" href={adminPath(`/apps/${app.id}/templates/${tpl.id}`)}>
                          Edit
                        </a>
                        <form
                          method="post"
                          action={adminPath(`/apps/${app.id}/templates/${tpl.id}/delete`)}
                          data-confirm="Delete this template? This cannot be undone."
                        >
                          <button type="submit" class="btn btn-danger btn-sm">
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div class="panel-foot">
          <form method="post" action={adminPath(`/apps/${app.id}/templates`)}>
            <div class="form-row">
              <div class="field">
                <label for="tpl-name">Name</label>
                <input
                  class="input"
                  type="text"
                  id="tpl-name"
                  name="name"
                  maxlength={MAX_TEMPLATE_NAME_LENGTH}
                  required
                />
              </div>
            </div>
            <div class="field">
              <label for="tpl-body">Body</label>
              <textarea
                class="input"
                id="tpl-body"
                name="body"
                rows={3}
                maxlength={MAX_MESSAGE_LENGTH}
                required
              />
            </div>
            <p class="muted">
              Use %TOKENS% (A-Z, 0-9, _) for per-recipient values; a missing variable renders as empty.
            </p>
            <button type="submit" class="btn btn-primary">
              Add template
            </button>
          </form>
        </div>
      </Panel>
    </Layout>,
    ipAllowlistDraft ? 400 : 200,
  );
}

/* ------------------------------------------------------------------ */
/* Mutations                                                            */
/* ------------------------------------------------------------------ */

async function notFoundOrRedirect(c: Context<AppEnv>, flash?: Flash): Promise<Response> {
  return c.html(<NotFoundPage flash={flash} what="App" />, 404);
}

export async function appQuotaPost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  if (id === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const body = await c.req.parseBody();
  const raw = formStr(body.dailyQuota);
  const quota = raw === "" ? null : Number(raw);
  if (quota !== null && (!Number.isInteger(quota) || quota < 1)) {
    return redirectFlash(c, appPath(id, "config"), "Daily quota must be a whole number of at least 1.", "error");
  }
  await setAppDailyQuota(db, id, quota);
  // Auth reads D1 first, so the next request already sees the new quota;
  // the cached verdict is refreshed so a D1 outage doesn't serve the old one.
  await writeAppAuthCache(c.env, app.keyHash, toAuthedApp({ ...app, dailyQuota: quota }));
  return redirectFlash(
    c,
    appPath(id, "config"),
    quota === null ? "Daily quota removed." : `Daily quota set to ${quota} recipients.`,
  );
}

export async function appIpAllowlistPost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  if (id === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const body = await c.req.parseBody();
  const draft: IpAllowlistDraft = { enabled: formChecked(body.enabled), entries: formStr(body.entries) };
  // Rejected input is shown back in the form rather than lost to a redirect.
  const reject = (message: string) =>
    renderAppConfig(c, app, { flash: { message, type: "error" }, ipAllowlistDraft: draft });

  const entries: string[] = [];
  const lines = draft.entries.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const raw of line.split(/[\s,]+/)) {
      if (raw === "") continue;
      const entry = normalizeIpEntry(raw);
      if (entry === null) {
        const shown = raw.length > 45 ? `${raw.slice(0, 45)}…` : raw;
        return reject(`Line ${index + 1}: "${shown}" is not an IP address or CIDR range.`);
      }
      if (!entries.includes(entry)) entries.push(entry);
    }
  }
  if (entries.length > MAX_IP_ALLOWLIST_ENTRIES) {
    return reject(`The IP allowlist can hold at most ${MAX_IP_ALLOWLIST_ENTRIES} entries.`);
  }
  const { enabled } = draft;
  if (enabled && entries.length === 0) {
    return reject("Add at least one address before turning the IP allowlist on.");
  }

  await setAppIpAllowlist(db, id, { enabled, entries });
  // Auth reads D1 first, so the next request already sees the new list; the
  // cached verdict is refreshed so a D1 outage doesn't serve the old one.
  await writeAppAuthCache(
    c.env,
    app.keyHash,
    toAuthedApp({ ...app, ipAllowlistEnabled: enabled, ipAllowlist: entries }),
  );
  return redirectFlash(
    c,
    appPath(id, "config"),
    enabled
      ? `IP allowlist on with ${entries.length} ${entries.length === 1 ? "entry" : "entries"}.`
      : "IP allowlist off: any address may send.",
  );
}

export async function appActivePost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  if (id === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const body = await c.req.parseBody();
  const desired = formStr(body.active) === "true";
  await setAppActive(db, id, desired);
  // Overwrite (not delete) so an outage-time request sees 403 rather than
  // 503 for a key we know is deactivated (ADR 0003).
  await writeAppAuthCache(c.env, app.keyHash, toAuthedApp({ ...app, isActive: desired }));
  return redirectFlash(
    c,
    appPath(id, "config"),
    desired ? "App activated." : "App deactivated.",
  );
}

export async function appRotateKeyPost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  if (id === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const generated = await generateApiKey();
  const ok = await rotateAppKey(db, id, generated.hash, generated.prefix);
  if (!ok) return notFoundOrRedirect(c);

  // Purge the OLD key's cache entry so it can't be used to authenticate
  // during a D1 outage after rotation (ADR 0003). Awaited, not waitUntil,
  // so the response implies completion.
  await invalidateAppAuthCache(c.env, app.keyHash);

  return c.html(
    <ApiKeyReveal appName={app.name} backHref={appPath(app.id, "config")} apiKey={generated.key} />,
  );
}

export async function appProvidersPost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  if (id === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const body = await c.req.parseBody();
  const inputs = PROVIDER_NAMES.map((provider) => ({
    appId: id,
    provider,
    enabled: formChecked(body[`${provider}_enabled`]),
    priority: parseIntOr(formStr(body[`${provider}_priority`]), 0),
  }));
  if (inputs.some((row) => row.priority < 1)) {
    return redirectFlash(c, appPath(id, "config"), "Priority must be a positive integer.", "error");
  }
  await upsertAppProviders(db, inputs);
  await invalidateAppConfig(c.env, id);

  return redirectFlash(c, appPath(id, "config"), "Provider plan saved.");
}

export async function appMaskingCreatePost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  if (id === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const body = await c.req.parseBody();
  const providerRaw = formStr(body.provider);
  const label = formStr(body.label);
  const senderId = formStr(body.senderId);
  const senderName = formStr(body.senderName);
  const username = formStr(body.username);
  const apiKey = formStr(body.apiKey);

  if (!isProviderName(providerRaw)) {
    return redirectFlash(c, appPath(id, "config"), "Unknown provider.", "error");
  }
  if (label.length < 1 || label.length > 32) {
    return redirectFlash(c, appPath(id, "config"), "Label must be 1-32 characters.", "error");
  }
  const credentialError = providerCredentialError({ apiKey, senderId, senderName, username });
  if (credentialError) return redirectFlash(c, appPath(id, "config"), credentialError, "error");

  const apiKeyEnc = apiKey ? await encryptSecret(c.env, apiKey) : null;

  try {
    await createMaskingProfile(db, {
      appId: id,
      provider: providerRaw,
      label,
      senderId: senderId || null,
      senderName: senderName || null,
      username: username || null,
      apiKeyEnc,
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return redirectFlash(
      c,
      appPath(id, "config"),
      `A masking profile named "${label}" already exists for ${PROVIDER_LABELS[providerRaw]}.`,
      "error",
    );
  }

  await invalidateAppConfig(c.env, id);
  return redirectFlash(c, appPath(id, "config"), "Masking profile added.");
}

export async function appMaskingDeletePost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  const profileId = parseId(c.req.param("profileId"));
  if (id === null || profileId === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const deleted = await deleteMaskingProfile(db, id, profileId);
  if (deleted) {
    await invalidateAppConfig(c.env, id);
  }

  return redirectFlash(
    c,
    appPath(id, "config"),
    deleted ? "Masking profile deleted." : "Masking profile not found.",
    deleted ? "success" : "error",
  );
}

export async function appTemplateCreatePost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  if (id === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const body = await c.req.parseBody();
  const name = formStr(body.name);
  const tplBody = formStr(body.body);

  if (name.length < 1 || name.length > MAX_TEMPLATE_NAME_LENGTH) {
    return redirectFlash(
      c,
      appPath(id, "config"),
      `"name" must be 1-${MAX_TEMPLATE_NAME_LENGTH} characters`,
      "error",
    );
  }
  if (tplBody.length < 1 || tplBody.length > MAX_MESSAGE_LENGTH) {
    return redirectFlash(
      c,
      appPath(id, "config"),
      `"body" must be 1-${MAX_MESSAGE_LENGTH} characters`,
      "error",
    );
  }

  let created;
  try {
    created = await createTemplate(db, { appId: id, name, body: tplBody });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return redirectFlash(
        c,
        appPath(id, "config"),
        `A template named "${name}" already exists.`,
        "error",
      );
    }
    throw err;
  }

  // No invalidateAppConfig here: templates aren't KV-cached (unlike masking
  // profiles / provider plan) — the send path fetches them from D1 by id on
  // every request, so there's nothing to invalidate.
  return redirectFlash(c, appPath(id, "config"), `Template added. Send it with "templateId": ${created.id}.`);
}

export async function appTemplateDeletePost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  const templateId = parseId(c.req.param("templateId"));
  if (id === null || templateId === null) return notFoundOrRedirect(c);
  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) return notFoundOrRedirect(c);

  const deleted = await deleteTemplate(db, id, templateId);

  return redirectFlash(
    c,
    appPath(id, "config"),
    deleted
      ? `Template deleted. API calls still sending templateId=${templateId} will now get 404.`
      : "Template not found.",
    deleted ? "success" : "error",
  );
}
