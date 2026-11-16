/**
 * Template CRUD, scoped to the authenticated App (c.var.app.id).
 */

import { Hono } from "hono";
import { createTemplate, deleteTemplate, getDb, isUniqueConstraintError, listTemplates, updateTemplate } from "../db";
import { templateBodyProblem, templateNameProblem } from "../sms/template";
import type { AppEnv } from "../shared/types";
import { fail, jsonObject, parseIdParam, readJsonBody } from "./validate";
import { requestBodyLimit } from "../shared/body-limit";

export const templatesRoutes = new Hono<AppEnv>();
templatesRoutes.use("*", requestBodyLimit(64 * 1024));

function validateName(name: unknown): string {
  const problem = templateNameProblem(name);
  return problem === null ? (name as string) : fail(400, problem);
}

function validateBody(body: unknown): string {
  const problem = templateBodyProblem(body);
  return problem === null ? (body as string) : fail(400, problem);
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
