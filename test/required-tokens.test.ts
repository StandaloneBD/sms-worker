import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, expect, it } from "vitest";
import { smsRoutes } from "../src/api/sms";
import { createTemplate, getDb, updateTemplate } from "../src/db";
import type { AppEnv } from "../src/shared/types";
import { resetDatabase } from "./helpers";

beforeEach(resetDatabase);
const db = getDb(env);

function api() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("app", { id: 1, name: "test", isActive: true }); await next(); });
  app.route("/", smsRoutes);
  app.onError((err, c) => { if (err instanceof HTTPException) return c.json({ error: err.message }, err.status); throw err; });
  return app;
}

it("sends only while the template has the required placeholder and every recipient a value for it", async () => {
  const template = await createTemplate(db, { appId: 1, name: "OTP", body: "Code %OTP%" });
  const ctx = createExecutionContext();
  const send = (path: string, recipient: Record<string, unknown>) => api().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId: template.id, requiredTemplateTokens: ["OTP"], recipients: [{ to: "01712345678", ...recipient }] }),
  }, env, ctx);

  expect((await send("/sms/send", { vars: { OTP: "123456" } })).status).toBe(200);
  expect((await send("/sms/send", { vars: { OTP: "" } })).status).toBe(400);
  expect((await send("/sms/send", { vars: { OTP: "123456" }, message: "no code" })).status).toBe(400);
  expect((await send("/sms/jobs", {})).status).toBe(400);

  await updateTemplate(db, 1, template.id, { body: "Welcome!" });
  expect(await (await send("/sms/send", { vars: { OTP: "123456" } })).json())
    .toEqual({ error: `required template token "OTP" is not in the template` });
  await waitOnExecutionContext(ctx);
});
