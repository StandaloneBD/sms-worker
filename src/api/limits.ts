/**
 * Spend guards for the send routes: a per-App request rate limit (Workers
 * Rate Limiting binding SEND_LIMITER) against a runaway client, and a
 * per-App daily recipient quota (apps.daily_quota, counted in D1) that
 * bounds what a leaked key can cost. Both fail open when their backend
 * errors — ADR 0002, sending outranks record-keeping.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { consumeDailyQuota, refundDailyQuota, type Db } from "../db";
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

const noRefund = async (): Promise<void> => {};

/** Charges `count` recipients to the App's daily quota, failing the request
 *  with 429 when it would go over. No-op for an App without a quota.
 *
 *  Returns a refund for a request that then fails before sending or queuing
 *  anything: the client retries it (its Idempotency-Key is released), and
 *  that retry must not be charged twice. Best-effort, never throws. */
export async function chargeDailyQuota(c: Context<AppEnv>, db: Db, count: number): Promise<() => Promise<void>> {
  const quota = c.var.app.dailyQuota;
  if (quota === null || quota === undefined || count === 0) return noRefund;

  const appId = c.var.app.id;
  // Captured once, so a request that crosses midnight refunds the day it charged.
  const day = usageDay();
  let charged: boolean;
  try {
    charged = await consumeDailyQuota(db, { appId, day, count, quota });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "daily_quota_check_failed",
        appId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return noRefund;
  }
  if (!charged) fail(429, `daily quota of ${quota} recipients exceeded`);
  return () =>
    refundDailyQuota(db, { appId, day, count }).catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          event: "daily_quota_refund_failed",
          appId,
          count,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
}
