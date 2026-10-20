/**
 * Template CRUD, scoped to the authenticated App (c.var.app.id).
 */

import { Hono } from "hono";
import { createTemplate, deleteTemplate, getDb, isUniqueConstraintError, listTemplates, updateTemplate } from "../db";
import { MAX_MESSAGE_LENGTH, MAX_TEMPLATE_NAME_LENGTH } from "../shared/constants";
import type { AppEnv } from "../shared/types";
import { fail, jsonObject, parseIdParam, readJsonBody } from "./validate";
import { requestBodyLimit } from "../shared/body-limit";

export const templatesRoutes = new Hono<AppEnv>();
templatesRoutes.use("*", requestBodyLimit(64 * 1024));

function validateName(name: unknown): string {
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_TEMPLATE_NAME_LENGTH) {
    return fail(400, `"name" must be 1-${MAX_TEMPLATE_NAME_LENGTH} characters`);
  }
  return name;
}

function validateBody(body: unknown): string {
  if (typeof body !== "string" || body.length < 1 || body.length > MAX_MESSAGE_LENGTH) {
    return fail(400, `"body" must be 1-${MAX_MESSAGE_LENGTH} characters`);
  }
  return body;
}

templatesRoutes.get("/templates", async (c) => {
  const db = getDb(c.env);
  const rows = await listTemplates(db, c.var.app.id);
  return c.json(rows, 200);
});

templatesRoutes.post("/templates", async (c) => {
  const db = getDb(c.env);
  const raw = jsonObject(await readJsonBody<unknown>(c));
  const name = validateName(raw.name);
  const body = validateBody(raw.body);
  try {
    const row = await createTemplate(db, { appId: c.var.app.id, name, body });
    return c.json(row, 201);
  } catch (err) {
    if (isUniqueConstraintError(err)) return fail(409, "a template with this name already exists");
    throw err;
  }
});

templatesRoutes.put("/templates/:id", async (c) => {
  const db = getDb(c.env);
  const id = parseIdParam(c.req.param("id"));
  const raw = jsonObject(await readJsonBody<unknown>(c));
  const patch: { name?: string; body?: string } = {};
  if (raw.name !== undefined) patch.name = validateName(raw.name);
  if (raw.body !== undefined) patch.body = validateBody(raw.body);
  if (patch.name === undefined && patch.body === undefined) {
    return fail(400, "at least one of \"name\" or \"body\" is required");
  }
  try {
    const row = await updateTemplate(db, c.var.app.id, id, patch);
    if (!row) return fail(404, "template not found");
    return c.json(row, 200);
  } catch (err) {
    if (isUniqueConstraintError(err)) return fail(409, "a template with this name already exists");
    throw err;
  }
});

templatesRoutes.delete("/templates/:id", async (c) => {
  const db = getDb(c.env);
  const id = parseIdParam(c.req.param("id"));
  const ok = await deleteTemplate(db, c.var.app.id, id);
  if (!ok) return fail(404, "template not found");
  return c.json({ ok: true }, 200);
});
