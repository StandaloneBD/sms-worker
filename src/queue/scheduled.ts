/**
 * Cron trigger (wrangler.jsonc: every 15 minutes). Two independent steps,
 * each logged and never thrown — there is no caller to retry against:
 *
 *  1. Reaper — pending chunks with no progress for CHUNK_STALE_SECONDS (a
 *     dead-letter message that dropped, an enqueue that failed, a lost retry
 *     round) are re-enqueued for their current round; after
 *     CHUNK_MAX_REQUEUES they are force-finished, so every Job reaches a
 *     terminal status (and becomes purgeable) eventually.
 *  2. Retention — a bounded slice of the purge: history and finished Jobs
 *     past RETENTION_DAYS, expired idempotency keys, old usage counters.
 */

import { getDb } from "../db";
import {
  claimStaleChunks,
  listAbandonedChunks,
  purgeExpiredKeysAndUsage,
  purgeOlderThan,
  type Db,
} from "../db/queries";
import {
  CHUNK_MAX_REQUEUES,
  CHUNK_STALE_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
  PURGE_BATCH_ROWS,
  PURGE_MAX_BATCHES,
  REAPER_FAIL_BATCH,
  REAPER_REQUEUE_BATCH,
  RETENTION_DAYS,
  USAGE_RETENTION_DAYS,
  usageDay,
} from "../shared/constants";
import type { ChunkQueueMessage } from "../shared/types";
import { forceFinishChunk } from "./consumer";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const db = getDb(env);
  await runStep("reaper", controller, () => reapStaleChunks(env, db));
  await runStep("retention_purge", controller, () => purgeExpired(db));
}

async function runStep(
  name: string,
  controller: ScheduledController,
  step: () => Promise<Record<string, number>>,
): Promise<void> {
  try {
    const counts = await step();
    console.log(JSON.stringify({ event: `${name}_completed`, ts: nowSeconds(), cron: controller.cron, ...counts }));
  } catch (err) {
    console.error(
      JSON.stringify({ event: `${name}_failed`, ts: nowSeconds(), cron: controller.cron, error: errorMessage(err) }),
    );
  }
}

export async function reapStaleChunks(env: Env, db: Db): Promise<{ requeued: number; forceFinished: number }> {
  const staleBefore = nowSeconds() - CHUNK_STALE_SECONDS;

  const stale = await claimStaleChunks(db, {
    staleBefore,
    maxRequeues: CHUNK_MAX_REQUEUES,
    limit: REAPER_REQUEUE_BATCH,
  });
  if (stale.length > 0) {
    try {
      await env.SMS_QUEUE.sendBatch(
        stale.map((chunk) => ({
          body: { jobId: chunk.jobId, chunkIndex: chunk.chunkIndex, round: chunk.round } satisfies ChunkQueueMessage,
        })),
      );
    } catch (err) {
      // Already counted as a re-enqueue; they come up again after another
      // stale period, and are force-finished once out of re-enqueues.
      console.error(JSON.stringify({ event: "reaper_enqueue_failed", count: stale.length, error: errorMessage(err) }));
    }
  }

  const abandoned = await listAbandonedChunks(db, {
    staleBefore,
    maxRequeues: CHUNK_MAX_REQUEUES,
    limit: REAPER_FAIL_BATCH,
  });
  let forceFinished = 0;
  for (const chunk of abandoned) {
    try {
      const finished = await forceFinishChunk(env, db, {
        jobId: chunk.jobId,
        chunkIndex: chunk.chunkIndex,
        reason: `abandoned: no progress after ${CHUNK_MAX_REQUEUES} re-enqueues`,
      });
      if (finished) forceFinished++;
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "reaper_force_finish_failed",
          jobId: chunk.jobId,
          chunkIndex: chunk.chunkIndex,
          error: errorMessage(err),
        }),
      );
    }
  }

  return { requeued: stale.length, forceFinished };
}

async function purgeExpired(db: Db): Promise<Record<string, number>> {
  const budget = { batchRows: PURGE_BATCH_ROWS, maxBatches: PURGE_MAX_BATCHES };
  const history = await purgeOlderThan(db, RETENTION_DAYS, budget);
  const keys = await purgeExpiredKeysAndUsage(db, {
    ...budget,
    keysCreatedBefore: nowSeconds() - IDEMPOTENCY_TTL_SECONDS,
    beforeDay: usageDay(new Date(Date.now() - USAGE_RETENTION_DAYS * 86_400_000)),
  });
  return {
    retentionDays: RETENTION_DAYS,
    deletedMessages: history.messages,
    deletedJobChunks: history.jobChunks,
    deletedJobs: history.jobs,
    deletedIdempotencyKeys: keys.idempotencyKeys,
    deletedUsageRows: keys.appUsage,
  };
}
