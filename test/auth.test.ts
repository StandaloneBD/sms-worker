/**
 * authMiddleware (src/api/auth.ts) — D1-first, KV-fallback (ADR 0003).
 * `src/db` is mocked so D1 behavior is fully controllable (row / undefined /
 * throw); `env.CACHE` is the real Workers-runtime KV binding from
 * `cloudflare:test`, so cache reads/writes are exercised for real.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvAppByKeyHash } from "../src/shared/constants";
import { sha256Hex } from "../src/shared/crypto";
import type { AppEnv, AuthedApp } from "../src/shared/types";

const dbState = vi.hoisted(() => ({
  row: undefined as { id: number; name: string; isActive: boolean } | undefined,
  error: null as Error | null,
}));

vi.mock("../src/db", () => ({
  getDb: () => ({}),
  getAppByKeyHash: async (_db: unknown, _hash: string) => {
    if (dbState.error) throw dbState.error;
    return dbState.row;
  },
}));

const { authMiddleware } = await import("../src/api/auth");
const { invalidateAppAuthCache, writeAppAuthCache } = await import("../src/core/auth-cache");

const TOKEN = "sk_test_token_for_auth_middleware";
let HASH: string;

function makeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware);
  app.get("/", (c) => c.json(c.var.app));
  return app;
}

/** Fake execution context whose `waitUntil` promises are collected for the
 *  caller to await explicitly (per the task's harness guidance). */
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, flush: () => Promise.all(pending) };
}

function authedHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

beforeEach(async () => {
  dbState.row = undefined;
  dbState.error = null;
  HASH = await sha256Hex(TOKEN);
  await env.CACHE.delete(kvAppByKeyHash(HASH));
});

describe("authMiddleware", () => {
  it("rejects malformed fallback cache data during a D1 outage", async () => {
    await env.CACHE.put(kvAppByKeyHash(HASH), JSON.stringify({ id: 1, name: "Acme", isActive: "false" }));
    dbState.error = new Error("D1 unreachable");
    const { ctx } = fakeCtx();
    expect((await makeApp().request("/", { headers: authedHeaders() }, env, ctx)).status).toBe(503);
  });
  it("valid key: D1 row -> 200 and warms KV", async () => {
    dbState.row = { id: 1, name: "Acme", isActive: true };
    const { ctx, flush } = fakeCtx();

    const res = await makeApp().request("/", { headers: authedHeaders() }, env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: "Acme", isActive: true });

    await flush();
    const cached = await env.CACHE.get(kvAppByKeyHash(HASH), "json");
    expect(cached).toEqual({ id: 1, name: "Acme", isActive: true });
  });

  it("key rotated in D1 (row gone) while KV still warm -> 401 immediately", async () => {
    await env.CACHE.put(
      kvAppByKeyHash(HASH),
      JSON.stringify({ id: 1, name: "Acme", isActive: true }),
    );
    dbState.row = undefined;
    const { ctx } = fakeCtx();

    const res = await makeApp().request("/", { headers: authedHeaders() }, env, ctx);
    expect(res.status).toBe(401);
  });

  it("app deactivated in D1 while KV warm says active -> 403 immediately", async () => {
    await env.CACHE.put(
      kvAppByKeyHash(HASH),
      JSON.stringify({ id: 1, name: "Acme", isActive: true }),
    );
    dbState.row = { id: 1, name: "Acme", isActive: false };
    const { ctx, flush } = fakeCtx();

    const res = await makeApp().request("/", { headers: authedHeaders() }, env, ctx);
    expect(res.status).toBe(403);

    // The stale KV entry gets corrected too (verdict differs from cached).
    await flush();
    const cached = await env.CACHE.get(kvAppByKeyHash(HASH), "json");
    expect(cached).toEqual({ id: 1, name: "Acme", isActive: false });
  });

  it("D1 throws + warm KV -> 200 (outage shield)", async () => {
    await env.CACHE.put(
      kvAppByKeyHash(HASH),
      JSON.stringify({ id: 1, name: "Acme", isActive: true }),
    );
    dbState.error = new Error("D1 unreachable");
    const { ctx } = fakeCtx();

    const res = await makeApp().request("/", { headers: authedHeaders() }, env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: "Acme", isActive: true });
  });

  it("D1 throws + no KV entry -> 503", async () => {
    dbState.error = new Error("D1 unreachable");
    const { ctx } = fakeCtx();

    const res = await makeApp().request("/", { headers: authedHeaders() }, env, ctx);
    expect(res.status).toBe(503);
  });

  it("D1 throws + KV entry with isActive:false -> 403", async () => {
    await env.CACHE.put(
      kvAppByKeyHash(HASH),
      JSON.stringify({ id: 1, name: "Acme", isActive: false }),
    );
    dbState.error = new Error("D1 unreachable");
    const { ctx } = fakeCtx();

    const res = await makeApp().request("/", { headers: authedHeaders() }, env, ctx);
    expect(res.status).toBe(403);
  });

  it("no/malformed bearer token -> 401 without touching D1/KV", async () => {
    const { ctx } = fakeCtx();
    const res = await makeApp().request("/", {}, env, ctx);
    expect(res.status).toBe(401);
  });
});

describe("auth-cache helpers", () => {
  it("invalidateAppAuthCache removes the key", async () => {
    await env.CACHE.put(kvAppByKeyHash(HASH), "placeholder");
    await invalidateAppAuthCache(env, HASH);
    expect(await env.CACHE.get(kvAppByKeyHash(HASH))).toBeNull();
  });

  it("writeAppAuthCache overwrites an existing entry", async () => {
    await env.CACHE.put(
      kvAppByKeyHash(HASH),
      JSON.stringify({ id: 1, name: "old-name", isActive: true }),
    );
    const authed: AuthedApp = { id: 1, name: "new-name", isActive: false };
    await writeAppAuthCache(env, HASH, authed);
    expect(await env.CACHE.get(kvAppByKeyHash(HASH), "json")).toEqual(authed);
  });
});
