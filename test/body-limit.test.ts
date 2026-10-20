import { env } from "cloudflare:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import { smsRoutes } from "../src/api/sms";
import { MAX_BODY_BYTES, MAX_MESSAGE_LENGTH, MAX_SYNC_BODY_BYTES } from "../src/shared/constants";
import type { AppEnv } from "../src/shared/types";

/**
 * Drives smsRoutes directly (not through apiRoutes/authMiddleware) with a
 * fake-authed `app` variable, replicating just the error-shape contract
 * apiRoutes.onError provides in production (src/api/index.ts) so a 413/400
 * comes back as `{error: string}` here exactly as it would in prod.
 */
function buildApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("app", { id: 1, name: "test-app", isActive: true });
    await next();
  });
  app.route("/", smsRoutes);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  });
  return app;
}

/** A ReadableStream that lazily emits `totalBytes` of filler content —
 *  avoids allocating one giant string/buffer up front. */
function streamOfSize(totalBytes: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(97)); // 'a'
      sent += size;
    },
  });
}

describe("body-limit middleware", () => {
  it("/sms/send: a streamed body over MAX_SYNC_BODY_BYTES with no Content-Length is 413", async () => {
    const app = buildApp();
    const oversize = MAX_SYNC_BODY_BYTES + 64 * 1024; // ~320 KiB > 256 KiB cap
    const res = await app.request(
      "/sms/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: streamOfSize(oversize),
        duplex: "half",
      } as RequestInit,
      env,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  it("/sms/jobs: a streamed body over MAX_BODY_BYTES with no Content-Length is 413", async () => {
    const app = buildApp();
    const oversize = MAX_BODY_BYTES + 64 * 1024; // just over the 25 MiB cap
    const res = await app.request(
      "/sms/jobs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: streamOfSize(oversize),
        duplex: "half",
      } as RequestInit,
      env,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  it("/sms/send: an accurate small Content-Length under the cap is not rejected by the limiter", async () => {
    const app = buildApp();
    // Missing "recipients" — proves the request reached the handler (400
    // from validation), not the limiter (which would be 413).
    const res = await app.request(
      "/sms/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/recipients/);
  });

  it("/sms/send: a spoofed small Content-Length cannot bypass actual byte counting", async () => {
    const app = buildApp();
    const actualBody = "a".repeat(MAX_SYNC_BODY_BYTES + 1);
    const res = await app.request(
      "/sms/send",
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "10" },
        body: actualBody,
      },
      env,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("request body too large");
  });

  it("/sms/send: a normal body reaches the handler and gets a 400 from validation, not a 413", async () => {
    const app = buildApp();
    const res = await app.request(
      "/sms/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", recipients: [] }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("MAX_MESSAGE_LENGTH is enforced before dispatch, well under the byte cap", () => {
  it("/sms/send: a per-recipient body over MAX_MESSAGE_LENGTH is a 400, not dispatched", async () => {
    const app = buildApp();
    const overLong = "a".repeat(MAX_MESSAGE_LENGTH + 1);
    const res = await app.request(
      "/sms/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: overLong, recipients: ["01712345678"] }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(`"message" exceeds ${MAX_MESSAGE_LENGTH} characters`);
  });

  it("/sms/jobs: a per-recipient body over MAX_MESSAGE_LENGTH is a 400, never enqueued", async () => {
    const app = buildApp();
    const overLong = "a".repeat(MAX_MESSAGE_LENGTH + 1);
    const res = await app.request(
      "/sms/jobs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: overLong, recipients: ["01712345678"] }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; indexes: number[] };
    expect(body.error).toBe(`"message" exceeds ${MAX_MESSAGE_LENGTH} characters`);
  });
});
