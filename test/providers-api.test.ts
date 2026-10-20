import { env } from "cloudflare:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, expect, it } from "vitest";
import { providersRoutes } from "../src/api/providers";
import { getAppProviderPlan, getDb, upsertGlobalProvider } from "../src/db";
import type { AppEnv } from "../src/shared/types";
import { getAppProviderRows } from "../src/ui/data";
import { resetDatabase } from "./helpers";

beforeEach(resetDatabase);
const db = getDb(env);

function request(body: unknown) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("app", { id: 1, name: "test", isActive: true }); await next(); });
  app.route("/", providersRoutes);
  app.onError((err, c) => { if (err instanceof HTTPException) return c.json({ error: err.message }, err.status); throw err; });
  return app.request("/providers", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
}

it.each([
  [{ provider: "bulksmsbd", enabled: true, priority: 1 }, { provider: "bulksmsbd", enabled: false, priority: 2 }],
  [{ provider: "bulksmsbd", enabled: true, priority: Number.MAX_SAFE_INTEGER + 1 }],
  [{ provider: "mimsms", enabled: true, priority: 0 }],
])("invalid provider plans are rejected before writing any rows (%j)", async (...rows) => {
  const res = await request(rows);
  expect(res.status).toBe(400);
  expect(await env.DB.prepare("SELECT count(*) AS count FROM app_providers").first("count")).toBe(0);
});

it("a partial per-app override renders inherited providers as disabled", async () => {
  for (const provider of ["bulksmsbd", "mimsms"] as const) await upsertGlobalProvider(db, { provider, enabled: true, priority: 1 });
  const res = await request([{ provider: "bulksmsbd", enabled: true, priority: 2 }]);
  expect(res.status).toBe(200);
  expect(await getAppProviderPlan(db, 1)).toEqual([{ provider: "bulksmsbd", priority: 2 }]);
  expect(await getAppProviderRows(db, 1)).toMatchObject([{ provider: "bulksmsbd", enabled: true }, { provider: "mimsms", enabled: false }]);
});
