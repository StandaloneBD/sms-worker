/** GET/POST /apps/:id/templates/:templateId — edit a single template. */

import type { Context } from "hono";
import { getDb, isUniqueConstraintError } from "../../db";
import { getAppById, getTemplate, updateTemplate } from "../../db/queries";
import { MAX_MESSAGE_LENGTH, MAX_TEMPLATE_NAME_LENGTH } from "../../shared/constants";
import type { AppEnv } from "../../shared/types";
import { extractTokens } from "../../sms/template";
import { AppHeader, NotFoundPage, Panel, Segments } from "../components";
import { redirectFlash, readFlash } from "../flash";
import { Layout } from "../layout";
import { adminPath, appPath } from "../paths";
import { formStr, parseId } from "../util";

export async function templateEditGet(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  const templateId = parseId(c.req.param("templateId"));
  if (id === null || templateId === null) {
    return c.html(<NotFoundPage flash={readFlash(c)} what="Template" />, 404);
  }

  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) {
    return c.html(<NotFoundPage flash={readFlash(c)} what="App" />, 404);
  }
  const tpl = await getTemplate(db, id, templateId);
  if (!tpl) {
    return c.html(<NotFoundPage flash={readFlash(c)} what="Template" />, 404);
  }

  const tokens = extractTokens(tpl.body);
  const flash = readFlash(c);

  return c.html(
    <Layout title={`${tpl.name} · ${app.name}`} active="apps" flash={flash}>
      <AppHeader app={app} tab="config" trail={tpl.name} />

      <Panel title={`Template #${tpl.id}`}>
        <p class="muted panel-note">Send it with "templateId": {tpl.id}.</p>
        <form method="post" action={adminPath(`/apps/${id}/templates/${templateId}`)}>
          <div class="form-row">
            <div class="field">
              <label for="tpl-name">Name</label>
              <input
                class="input"
                type="text"
                id="tpl-name"
                name="name"
                value={tpl.name}
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
            >{tpl.body}</textarea>
          </div>
          <p class="muted">
            Use %TOKENS% (A-Z, 0-9, _) for per-recipient values; a missing variable renders as empty.
          </p>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              Save template
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="Preview">
        <Segments body={tpl.body} />
        <p class="mono muted">
          {tokens.length === 0 ? "No tokens found." : `Tokens found: ${tokens.map((t) => `%${t}%`).join(", ")}`}
        </p>
      </Panel>
    </Layout>,
  );
}

export async function templateEditPost(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  const templateId = parseId(c.req.param("templateId"));
  if (id === null || templateId === null) {
    return c.html(<NotFoundPage flash={readFlash(c)} what="Template" />, 404);
  }

  const db = getDb(c.env);
  const app = await getAppById(db, id);
  if (!app) {
    return c.html(<NotFoundPage flash={readFlash(c)} what="App" />, 404);
  }

  const body = await c.req.parseBody();
  const name = formStr(body.name);
  const tplBody = formStr(body.body);

  if (name.length < 1 || name.length > MAX_TEMPLATE_NAME_LENGTH) {
    return redirectFlash(
      c,
      adminPath(`/apps/${id}/templates/${templateId}`),
      `"name" must be 1-${MAX_TEMPLATE_NAME_LENGTH} characters`,
      "error",
    );
  }
  if (tplBody.length < 1 || tplBody.length > MAX_MESSAGE_LENGTH) {
    return redirectFlash(
      c,
      adminPath(`/apps/${id}/templates/${templateId}`),
      `"body" must be 1-${MAX_MESSAGE_LENGTH} characters`,
      "error",
    );
  }

  let updated;
  try {
    updated = await updateTemplate(db, id, templateId, { name, body: tplBody });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return redirectFlash(
        c,
        adminPath(`/apps/${id}/templates/${templateId}`),
        `A template named "${name}" already exists.`,
        "error",
      );
    }
    throw err;
  }
  if (!updated) {
    return c.html(<NotFoundPage flash={readFlash(c)} what="Template" />, 404);
  }

  return redirectFlash(c, appPath(id, "config"), "Template updated.");
}
