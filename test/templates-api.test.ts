/**
 * Drives templatesRoutes (src/api/templates.ts) directly, with a fake-authed
 * `app` variable (see test/body-limit.test.ts for the same pattern), against
 * a REAL D1 binding (`env.DB` from `cloudflare:test`, per wrangler.jsonc).
 *
 * The test D1 database has no migrations applied, so the `templates` table
 * (and its `(app_id, name)` unique index) is created here from the exact DDL
 * in drizzle/0000_tiny_hercules.sql — split into individual statements since
 * D1's `.prepare()` takes one statement at a time. The `templates` table has
 * no FK to `apps` in that migration (`app_id` is a bare NOT NULL integer),
 * so no `apps` table setup is needed. Schema creation is idempotent
 * (`IF NOT EXISTS`) and re-run in `beforeEach` alongside a row wipe, so the
 * suite is correct whether or not the harness's "isolated per-test storage"
 * resets D1 between tests within this file.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it } from "vitest";

import { templatesRoutes } from "../src/api/templates";
import { MAX_MESSAGE_LENGTH } from "../src/shared/constants";
import type { AppEnv } from "../src/shared/types";

interface TemplateRow {
  id: number;
  appId: number;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

async function ensureSchema() {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS templates (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      app_id integer NOT NULL,
      name text NOT NULL,
      body text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS templates_app_name_unique ON templates (app_id, name)",
  ).run();
  await env.DB.prepare("DELETE FROM templates").run();
}

beforeEach(async () => {
  await ensureSchema();
});

/** Builds a tiny Hono app stubbing `c.var.app` to the given id, mounting
 *  templatesRoutes, and converting thrown HTTPExceptions to `{error}` json
 *  the way apiRoutes.onError does in production (src/api/index.ts). */
function buildApp(appId: number) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("app", { id: appId, name: `test-app-${appId}`, isActive: true });
    await next();
  });
  app.route("/", templatesRoutes);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  });
  return app;
}

const APP_A = 1;
const APP_B = 2;

function postTemplate(appId: number, payload: unknown) {
  return buildApp(appId).request(
    "/templates",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    env,
  );
}

function putTemplate(appId: number, id: number | string, payload: unknown) {
  return buildApp(appId).request(
    `/templates/${id}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    env,
  );
}

function deleteTemplateReq(appId: number, id: number | string) {
  return buildApp(appId).request(`/templates/${id}`, { method: "DELETE" }, env);
}

function listTemplatesReq(appId: number) {
  return buildApp(appId).request("/templates", {}, env);
}

async function createAndGetId(appId: number, name: string, body: string): Promise<number> {
  const res = await postTemplate(appId, { name, body });
  const row = (await res.json()) as TemplateRow;
  return row.id;
}

describe("GET /templates", () => {
  it("returns [] when the app has no templates", async () => {
    const res = await listTemplatesReq(APP_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns rows ordered by name ascending", async () => {
    await postTemplate(APP_A, { name: "zeta", body: "z body" });
    await postTemplate(APP_A, { name: "alpha", body: "a body" });
    await postTemplate(APP_A, { name: "mid", body: "m body" });

    const res = await listTemplatesReq(APP_A);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as TemplateRow[];
    expect(rows.map((r) => r.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("is scoped to the authenticated app — another app's template is not returned", async () => {
    await postTemplate(APP_A, { name: "mine", body: "body a" });
    await postTemplate(APP_B, { name: "theirs", body: "body b" });

    const res = await listTemplatesReq(APP_A);
    const rows = (await res.json()) as TemplateRow[];
    expect(rows.map((r) => r.name)).toEqual(["mine"]);
  });
});

describe("POST /templates", () => {
  it.each([null, [], 12, "text"])("400 for a non-object JSON body (%j)", async (body) => {
    const res = await postTemplate(APP_A, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });
  it("201: creates a template, echoing name/body/appId with timestamps set", async () => {
    const res = await postTemplate(APP_A, { name: "welcome", body: "Hi there" });
    expect(res.status).toBe(201);
    const row = (await res.json()) as TemplateRow;
    expect(row).toMatchObject({ appId: APP_A, name: "welcome", body: "Hi there" });
    expect(row.id).toEqual(expect.any(Number));
    expect(row.createdAt).toEqual(expect.any(Number));
    expect(row.updatedAt).toEqual(expect.any(Number));
  });

  it("400: missing name", async () => {
    const res = await postTemplate(APP_A, { body: "hi" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `"name" must be 1-64 characters` });
  });

  it("400: empty name", async () => {
    const res = await postTemplate(APP_A, { name: "", body: "hi" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `"name" must be 1-64 characters` });
  });

  it("400: 65-char name", async () => {
    const res = await postTemplate(APP_A, { name: "a".repeat(65), body: "hi" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `"name" must be 1-64 characters` });
  });

  it("400: missing body", async () => {
    const res = await postTemplate(APP_A, { name: "ok" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `"body" must be 1-${MAX_MESSAGE_LENGTH} characters` });
  });

  it("400: empty body", async () => {
    const res = await postTemplate(APP_A, { name: "ok", body: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `"body" must be 1-${MAX_MESSAGE_LENGTH} characters` });
  });

  it(`400: ${MAX_MESSAGE_LENGTH + 1}-char body`, async () => {
    const res = await postTemplate(APP_A, { name: "ok", body: "a".repeat(MAX_MESSAGE_LENGTH + 1) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `"body" must be 1-${MAX_MESSAGE_LENGTH} characters` });
  });

  it("409: duplicate (appId, name)", async () => {
    await postTemplate(APP_A, { name: "dup", body: "one" });
    const res = await postTemplate(APP_A, { name: "dup", body: "two" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "a template with this name already exists" });
  });

  it("the same name under a DIFFERENT appId succeeds", async () => {
    await postTemplate(APP_A, { name: "shared", body: "one" });
    const res = await postTemplate(APP_B, { name: "shared", body: "two" });
    expect(res.status).toBe(201);
  });
});

describe("PUT /templates/:id", () => {
  it("patches name only, leaving body unchanged", async () => {
    const id = await createAndGetId(APP_A, "orig-name", "orig-body");
    const res = await putTemplate(APP_A, id, { name: "new-name" });
    expect(res.status).toBe(200);
    const row = (await res.json()) as TemplateRow;
    expect(row.name).toBe("new-name");
    expect(row.body).toBe("orig-body");
  });

  it("patches body only, leaving name unchanged", async () => {
    const id = await createAndGetId(APP_A, "keep-name", "orig-body");
    const res = await putTemplate(APP_A, id, { body: "new-body" });
    expect(res.status).toBe(200);
    const row = (await res.json()) as TemplateRow;
    expect(row.name).toBe("keep-name");
    expect(row.body).toBe("new-body");
  });

  it('400 when neither "name" nor "body" is given', async () => {
    const id = await createAndGetId(APP_A, "n", "b");
    const res = await putTemplate(APP_A, id, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `at least one of "name" or "body" is required` });
  });

  it("404 for a nonexistent id", async () => {
    const res = await putTemplate(APP_A, 999999, { name: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "template not found" });
  });

  it("404 for an id owned by another app", async () => {
    const id = await createAndGetId(APP_B, "theirs", "body");
    const res = await putTemplate(APP_A, id, { name: "hijack" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "template not found" });
  });

  it("409 when renaming onto an existing name", async () => {
    await createAndGetId(APP_A, "taken", "body");
    const id = await createAndGetId(APP_A, "movable", "body");
    const res = await putTemplate(APP_A, id, { name: "taken" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "a template with this name already exists" });
  });

  it("bumps updatedAt", async () => {
    const id = await createAndGetId(APP_A, "ts-test", "body");
    // Force an old updatedAt directly, since two calls within the same test
    // can land in the same unix second (updatedAt granularity), which would
    // make a naive "changed" assertion flaky.
    await env.DB.prepare("UPDATE templates SET updated_at = 1000 WHERE id = ?").bind(id).run();

    const res = await putTemplate(APP_A, id, { body: "new-body" });
    expect(res.status).toBe(200);
    const row = (await res.json()) as TemplateRow;
    expect(row.updatedAt).toBeGreaterThan(1000);
  });
});

describe("DELETE /templates/:id", () => {
  it("200 {ok:true}, and the row is actually gone afterward", async () => {
    const id = await createAndGetId(APP_A, "to-delete", "body");
    const res = await deleteTemplateReq(APP_A, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const listRes = await listTemplatesReq(APP_A);
    expect(await listRes.json()).toEqual([]);
  });

  it("404 for a nonexistent id", async () => {
    const res = await deleteTemplateReq(APP_A, 999999);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "template not found" });
  });

  it("404 for another app's template, and it remains undeleted", async () => {
    const id = await createAndGetId(APP_B, "not-yours", "body");
    const res = await deleteTemplateReq(APP_A, id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "template not found" });

    const listRes = await listTemplatesReq(APP_B);
    const rows = (await listRes.json()) as TemplateRow[];
    expect(rows.map((r) => r.name)).toEqual(["not-yours"]);
  });
});
