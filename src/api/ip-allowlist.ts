/**
 * IP Allowlist enforcement for the app-facing API (ADR 0006). Runs after auth, so
 * c.var.app carries the App's allowlist when it is switched on. Only write
 * requests are checked (sends, jobs, template and provider changes); reads
 * (GET/HEAD) stay open from anywhere. It runs ahead of the send routes' rate
 * limit and Idempotency-Key handling, so a refused caller can neither use up
 * the App's rate limit nor claim or replay a key.
 *
 * The caller's address is CF-Connecting-IP, which Cloudflare sets and
 * clients can't override. A missing header is refused.
 */

import { createMiddleware } from "hono/factory";
import { ipAllowed } from "../shared/ip";
import type { AppEnv } from "../shared/types";

export const ipAllowlistMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const allowlist = c.var.app.ipAllowlist;
  if (allowlist === undefined || c.req.method === "GET" || c.req.method === "HEAD") {
    return next();
  }

  const ip = c.req.header("cf-connecting-ip") ?? null;
  if (ip === null || !ipAllowed(ip, allowlist)) {
    console.warn(
      JSON.stringify({
        event: "ip_not_allowed",
        appId: c.var.app.id,
        ip,
        method: c.req.method,
        path: c.req.path,
      }),
    );
    // The caller's own address, so they can see what to add to the list.
    return c.json({ error: "ip not allowed", ip }, 403);
  }
  await next();
});
