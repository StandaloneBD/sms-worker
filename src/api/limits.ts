/**
 * Spend guards for the send routes: a per-App request rate limit (Workers
 * Rate Limiting binding SEND_LIMITER) against a runaway client, and a
 * per-App daily recipient quota (apps.daily_quota, counted in D1) that
 * bounds what a leaked key can cost. Both fail open when their backend
 * errors — ADR 0002, sending outranks record-keeping.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { consumeDailyQuota, type Db } from "../db";
import { usageDay } from "../shared/constants";
import type { AppEnv } from "../shared/types";
import { fail } from "./validate";

export const sendRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  let allowed = true;
  try {
    ({ success: allowed } = await c.env.SEND_LIMITER.limit({ key: `app:${c.var.app.id}` }));
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "send_rate_limit_failed",
        appId: c.var.app.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  if (!allowed) return fail(429, "rate limit exceeded; slow down");
  await next();
});

/** Charges `count` recipients to the App's daily quota, failing the request
 *  with 429 when it would go over. No-op for an App without a quota. */
export async function chargeDailyQuota(c: Context<AppEnv>, db: Db, count: number): Promise<void> {
  const quota = c.var.app.dailyQuota;
  if (quota === null || quota === undefined || count === 0) return;

  let charged: boolean;
  try {
    charged = await consumeDailyQuota(db, { appId: c.var.app.id, day: usageDay(), count, quota });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "daily_quota_check_failed",
        appId: c.var.app.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }
  if (!charged) fail(429, `daily quota of ${quota} recipients exceeded`);
}
