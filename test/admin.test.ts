import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { createAdmin, getAdminByUsername, getDb, listApps } from "../src/db";
import { hashPassword, signSession, timingSafeEqualStr, verifySession } from "../src/shared/crypto";
import { SESSION_COOKIE } from "../src/shared/constants";
import { resetDatabase } from "./helpers";

beforeEach(resetDatabase);
const db = getDb(env);

async function request(path: string, init: RequestInit = {}, bindings: Env = env) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://sms.test${path}`, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function login(password: string, bindings: Env = env) {
  return request("/admin/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://sms.test", "cf-connecting-ip": crypto.randomUUID() }, body: new URLSearchParams({ username: "admin", password }) }, bindings);
}

describe("admin sessions", () => {
  it("registers an app, sends with its key, rotates it, and immediately deactivates the replacement", async () => {
    const passwordHash = await hashPassword("admin-password");
    const admin = await createAdmin(db, { username: "admin", passwordHash });
    const token = await signSession(env, admin.id, Math.floor(Date.now() / 1000) + 3600, passwordHash);
    const headers = { cookie: `${SESSION_COOKIE}=${token}`, origin: "https://sms.test", "content-type": "application/x-www-form-urlencoded" };
    const created = await request("/admin/apps", { method: "POST", headers, body: new URLSearchParams({ name: "integration-app" }) });
    expect(created.status).toBe(200);
    const key = (await created.text()).match(/sk_[a-f0-9]{48}/)![0];
    const app = (await listApps(db))[0]!;
    const sent = await request("/v1/sms/send", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ message: "Hi", recipients: ["01712345678"] }) });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ results: [{ accepted: true, provider: "fake" }] });
    const rotated = await request(`/admin/apps/${app.id}/rotate-key`, { method: "POST", headers });
    const replacement = (await rotated.text()).match(/sk_[a-f0-9]{48}/)![0];
    expect((await request("/v1/templates", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    expect((await request("/v1/templates", { headers: { authorization: `Bearer ${replacement}` } })).status).toBe(200);
    await request(`/admin/apps/${app.id}/active`, { method: "POST", headers, body: new URLSearchParams({ active: "false" }) });
    expect((await request("/v1/templates", { headers: { authorization: `Bearer ${replacement}` } })).status).toBe(403);
    for (const path of ["/admin", "/admin/apps", `/admin/apps/${app.id}`, "/admin/jobs", "/admin/messages", "/admin/providers", "/admin/settings"]) {
      expect((await request(path, { headers: { cookie: headers.cookie } })).status).toBe(200);
    }
  });
  it("bootstrap rejects the wrong password and creates the first admin only on a correct one", async () => {
    const wrong = await login("incorrect");
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await getAdminByUsername(db, "admin")).toBeUndefined();
    const res = await login(env.ADMIN_BOOTSTRAP_PASSWORD);
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("Secure");
    expect(await getAdminByUsername(db, "admin")).toBeDefined();
  });
  it("revokes other sessions on password change while renewing the current one", async () => {
    const oldHash = await hashPassword("old-password");
    const admin = await createAdmin(db, { username: "admin", passwordHash: oldHash });
    const token = await signSession(env, admin.id, Math.floor(Date.now() / 1000) + 3600, oldHash);
    const cookie = `${SESSION_COOKIE}=${token}`;
    const res = await request("/admin/settings", { method: "POST", headers: { cookie, origin: "https://sms.test", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ currentPassword: "old-password", newPassword: "new-password" }) });
    expect(res.status).toBe(303);
    const freshCookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(freshCookie).not.toBe(cookie);
    expect((await request("/admin", { headers: { cookie } })).headers.get("location")).toBe("/admin/login");
    expect((await request("/admin", { headers: { cookie: freshCookie } })).status).toBe(200);
  });
  it("rejects sessions for deleted admins", async () => {
    const token = await signSession(env, 999, Math.floor(Date.now() / 1000) + 3600, "nonexistent");
    expect((await request("/admin", { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).headers.get("location")).toBe("/admin/login");
  });
  it("bounds and throttles login attempts before password hashing", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const res = await login(env.ADMIN_BOOTSTRAP_PASSWORD, { ...env, LOGIN_RATE_LIMIT: { limit } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await getAdminByUsername(db, "admin")).toBeUndefined();
  });
  it("admin responses containing credentials cannot be cached or framed", async () => {
    const res = await request("/admin/login");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("CSRF", () => {
  it.each([
    { origin: "https://other.test" },
    { origin: "http://sms.test" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { referer: "https://other.test/page" },
  ])("rejects cross-origin login (%j)", async (headers) => {
    const actualHeaders = new Headers();
    for (const [key, value] of Object.entries(headers)) if (value !== undefined) actualHeaders.set(key, value);
    const res = await request("/admin/login", { method: "POST", headers: actualHeaders });
    expect(res.status).toBe(403);
  });
});

it("compares secret strings and rejects tampered/expired session tokens", async () => {
  expect(await timingSafeEqualStr("short", "much longer")).toBe(false);
  expect(await timingSafeEqualStr("same", "same")).toBe(true);
  const hash = await hashPassword("test-password");
  const token = await signSession(env, 1, Math.floor(Date.now() / 1000) + 100, hash);
  expect(await verifySession(env, token, hash)).toBe(1);
  expect(await verifySession(env, token, hash + "changed")).toBeNull();
  expect(await verifySession(env, token + "tampered", hash)).toBeNull();
  expect(await verifySession(env, await signSession(env, 1, 1, hash), hash)).toBeNull();
});
