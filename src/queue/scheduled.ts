/**
 * Minute cron: recover durable jobs whose queue publication did not finish.
 * Nightly cron ("0 21 * * *"): purge history and the corresponding R2 data.
 * Failures are logged; persisted state remains available to the next run.
 */

import { getDb } from "../db";
import { purgeOlderThan } from "../db/queries";
import { RETENTION_DAYS, r2JobKey } from "../shared/constants";
import { recoverUnpublishedJobs } from "./producer";
import { purgeOrphanedPayloads } from "./retention";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    const db = getDb(env);
    if (controller.cron !== "0 21 * * *") {
      await recoverUnpublishedJobs(env, db);
      return;
    }
    const deleted = await purgeOlderThan(db, RETENTION_DAYS, (ids) => env.PAYLOADS.delete(ids.map(r2JobKey)));
    const deletedOrphans = await purgeOrphanedPayloads(env, db);
    console.log(
      JSON.stringify({
        event: "retention_purge_completed",
        ts: nowSeconds(),
        cron: controller.cron,
        retentionDays: RETENTION_DAYS,
        deletedMessages: deleted.messages,
        deletedJobChunks: deleted.jobChunks,
        deletedJobs: deleted.jobs,
        deletedOrphanedPayloads: deletedOrphans,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "retention_purge_failed",
        ts: nowSeconds(),
        cron: controller.cron,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
