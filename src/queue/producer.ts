import { jobsAwaitingEnqueue, markJobEnqueued, pendingChunkIndexes, type Db } from "../db/queries";
import type { ChunkQueueMessage } from "../shared/types";

/** Publish pending pointers only. Leave enqueuedAt null on ANY failure so
 * the durable D1 outbox remains recoverable, including partial batches. */
export async function enqueueJob(env: Env, db: Db, jobId: string): Promise<void> {
  const indexes = await pendingChunkIndexes(db, jobId);
  for (let offset = 0; offset < indexes.length; offset += 100) {
    await env.SMS_QUEUE.sendBatch(indexes.slice(offset, offset + 100).map((chunkIndex) => ({
      body: { jobId, chunkIndex } satisfies ChunkQueueMessage,
      contentType: "json" as const,
    })));
  }
  await markJobEnqueued(db, jobId);
}

export async function recoverUnpublishedJobs(env: Env, db: Db): Promise<void> {
  // Avoid overlapping normal request publication; cap work below the Free
  // invocation's 50-query budget (one lookup + two queries per job).
  const pending = await jobsAwaitingEnqueue(db, Math.floor(Date.now() / 1000) - 60);
  for (const job of pending) {
    try {
      await enqueueJob(env, db, job.id);
      console.log(JSON.stringify({ event: "job_enqueue_recovered", jobId: job.id }));
    } catch (err) {
      console.error(JSON.stringify({ event: "job_enqueue_recovery_failed", jobId: job.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}
