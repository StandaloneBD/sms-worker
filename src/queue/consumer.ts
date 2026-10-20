/**
 * Queue consumer — the two consumers declared in wrangler.jsonc share this
 * one handler, branching on `batch.queue`: a queue whose name ends in
 * "-dlq" is the dead-letter queue, every other queue is chunk processing
 * (by suffix, so per-environment queue names keep working):
 *
 *  - chunk processing ("sms-jobs", max_retries 5, DLQ "sms-dlq"): one send
 *    round of one chunk per message (ADR 0005).
 *  - dead-letter ("sms-dlq", max_retries 3, then the message drops — the
 *    reaper is the backstop): force-finishes the chunk.
 *
 * Ordering on the main path is load-bearing (ADR 0002: prefer duplicate
 * sends over lost sends) — the provider dispatch happens BEFORE the
 * `settleChunkRound` gate (which atomically claims the round and rolls up
 * job counters); in between, the round's results are checkpointed to R2 so
 * a redelivery replays them instead of sending again; per-recipient history
 * writes after the gate are best-effort. See per-step comments below.
 */

import { getDb } from "../db";
import { getJobChunk, insertMessages, markChunksStale, settleChunkRound, type Db, type NewMessageRow } from "../db/queries";
import { buildDispatchPlan } from "../core/plan";
import {
  deleteJobObjects,
  deleteRoundResults,
  readChunkPayload,
  readRoundResults,
  writeRoundResults,
} from "../core/payload";
import { dispatch, toDispatchInput } from "../sms/dispatch";
import { resolveBody } from "../sms/template";
import {
  MAX_REASON_LENGTH,
  RETRY_BASE_SECONDS,
  RETRY_MAX_SECONDS,
  SEND_RETRY_BASE_SECONDS,
  SEND_ROUNDS,
} from "../shared/constants";
import type { ChunkPayload, ChunkQueueMessage, DispatchResultItem } from "../shared/types";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateReason(reason: string): string {
  return reason.length > MAX_REASON_LENGTH ? reason.slice(0, MAX_REASON_LENGTH) : reason;
}

/** Infrastructure-error backoff: RETRY_BASE_SECONDS * 2^attempts, capped. */
function backoffSeconds(attempts: number): number {
  return Math.min(RETRY_BASE_SECONDS * 2 ** attempts, RETRY_MAX_SECONDS);
}

/** Delay before send round `round` (≥ 1): SEND_RETRY_BASE_SECONDS * 2^(round-1). */
function sendRoundDelaySeconds(round: number): number {
  return Math.min(SEND_RETRY_BASE_SECONDS * 2 ** (round - 1), RETRY_MAX_SECONDS);
}

export function isDeadLetterQueue(queueName: string): boolean {
  return queueName.endsWith("-dlq");
}

/** Narrows an unknown queue body without a cast to `any`. */
function isChunkQueueMessage(value: unknown): value is ChunkQueueMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.jobId === "string" &&
    record.jobId.length > 0 &&
    typeof record.chunkIndex === "number" &&
    Number.isInteger(record.chunkIndex) &&
    record.chunkIndex >= 0 &&
    (record.round === undefined ||
      (typeof record.round === "number" && Number.isInteger(record.round) && record.round >= 0))
  );
}

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const db = getDb(env);
  const deadLetter = isDeadLetterQueue(batch.queue);

  for (const msg of batch.messages) {
    try {
      if (deadLetter) await processDlqMessage(msg, env, db);
      else await processChunkMessage(msg, env, db);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: deadLetter ? "dlq_chunk_unhandled_error" : "job_chunk_unhandled_error",
          ts: nowSeconds(),
          queue: batch.queue,
          messageId: msg.id,
          attempts: msg.attempts,
          error: errorMessage(err),
        }),
      );
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shared: which recipients a round covers, and how it settles          */
/* ------------------------------------------------------------------ */

interface RoundTarget {
  /** Chunk-relative recipient index. */
  index: number;
  to: string;
  /** Undefined when no body resolves (immediate failure, never dispatched). */
  body: string | undefined;
  /** Whether the history row keeps the body: an explicit recipient.message
   *  override, or a template render (vars aren't stored, so the row is the
   *  only record of the text). A plain request-level message is on the job. */
  storeBody: boolean;
}

/** Chunk-relative indexes still to send: all of them in round 0, the
 *  retryable leftovers recorded by the previous round otherwise. */
function pendingIndexes(chunk: { retryIndexes: string | null }, total: number): number[] {
  if (chunk.retryIndexes !== null) return JSON.parse(chunk.retryIndexes) as number[];
  return Array.from({ length: total }, (_, index) => index);
}

function resolveTargets(payload: ChunkPayload, indexes: readonly number[]): RoundTarget[] {
  const targets: RoundTarget[] = [];
  for (const index of indexes) {
    const recipient = payload.recipients[index];
    if (!recipient) {
      console.error(
        JSON.stringify({ event: "chunk_index_out_of_range", jobId: payload.jobId, chunkIndex: payload.chunkIndex, index }),
      );
      continue;
    }
    targets.push({
      index,
      to: recipient.to,
      body: resolveBody(recipient, payload) || undefined,
      storeBody: recipient.message !== undefined || payload.templateBody !== undefined,
    });
  }
  return targets;
}

interface RoundSettlement {
  rows: NewMessageRow[];
  sent: number;
  failed: number;
  /** Recipients held back for the next round. */
  retryIndexes: number[];
}

/**
 * Turns one round's dispatch results into history rows and counts.
 * `results` lines up, in order, with the targets that resolved a body
 * (dispatch() returns exactly one result per input); null means the round
 * was never dispatched, and each such target fails with `unsentReason`.
 * With `allowRetry`, retryable failures are held back for the next round
 * instead of being recorded.
 */
function settleRound(
  appId: number,
  jobId: string,
  targets: readonly RoundTarget[],
  results: readonly DispatchResultItem[] | null,
  opts: { allowRetry: boolean; unsentReason: string },
): RoundSettlement {
  const settlement: RoundSettlement = { rows: [], sent: 0, failed: 0, retryIndexes: [] };
  const failedRow = (target: RoundTarget, reason: string): NewMessageRow => ({
    jobId,
    appId,
    recipient: target.to,
    body: target.storeBody ? (target.body ?? null) : null,
    provider: null,
    status: "failed",
    reason: truncateReason(reason),
    trackingId: null,
  });

  let resultIndex = 0;
  for (const target of targets) {
    if (target.body === undefined) {
      settlement.failed++;
      settlement.rows.push(failedRow(target, "no message body resolved for recipient"));
      continue;
    }
    if (results === null) {
      settlement.failed++;
      settlement.rows.push(failedRow(target, opts.unsentReason));
      continue;
    }

    const outcome = results[resultIndex];
    resultIndex++;
    if (!outcome) {
      // Invariant: dispatch() returns exactly one result per dispatchable
      // recipient, in order — this would indicate a bug in the dispatch
      // module, not a data problem, so surface it loudly.
      throw new Error(`dispatch() returned no result for recipient at index ${resultIndex - 1}`);
    }

    if (outcome.accepted) {
      settlement.sent++;
    } else if (outcome.retryable && opts.allowRetry) {
      settlement.retryIndexes.push(target.index);
      continue;
    } else {
      settlement.failed++;
    }
    settlement.rows.push({
      jobId,
      appId,
      recipient: target.to,
      body: target.storeBody ? target.body : null,
      provider: outcome.provider,
      status: outcome.accepted ? "sent" : "failed",
      reason: outcome.reason ? truncateReason(outcome.reason) : null,
      trackingId: outcome.trackingId ?? null,
    });
  }
  return settlement;
}

/** Best-effort follow-ups once a round is settled in D1. */
async function afterSettle(
  env: Env,
  db: Db,
  input: { jobId: string; chunkIndex: number; round: number; rows: NewMessageRow[]; jobFinished: boolean },
): Promise<void> {
  const { jobId, chunkIndex, round } = input;
  // The settle made the checkpoint obsolete: a redelivery of this round now
  // acks on the round mismatch before ever reading it.
  await deleteRoundResults(env, jobId, chunkIndex, round).catch((err: unknown) => {
    console.warn(JSON.stringify({ event: "round_results_delete_failed", jobId, chunkIndex, round, error: errorMessage(err) }));
  });

  // A failure here still acks: the chunk and job counters are already
  // committed; only per-recipient detail is lost (ADR 0002 accepts history
  // gaps, never blocked sends).
  try {
    await insertMessages(db, input.rows);
  } catch (err) {
    console.error(
      JSON.stringify({ event: "chunk_history_failed", ts: nowSeconds(), jobId, chunkIndex, error: errorMessage(err) }),
    );
  }

  if (input.jobFinished) {
    await deleteJobObjects(env, jobId).catch((err: unknown) => {
      console.warn(JSON.stringify({ event: "job_payload_delete_failed", ts: nowSeconds(), jobId, error: errorMessage(err) }));
    });
  }
}

/* ------------------------------------------------------------------ */
/* Chunk processing ("sms-jobs")                                        */
/* ------------------------------------------------------------------ */

async function processChunkMessage(msg: Message<unknown>, env: Env, db: Db): Promise<void> {
  // (a) Parse. Unparseable is a poison message — redelivery can never fix a
  // body that was never valid JSON shaped like ChunkQueueMessage.
  if (!isChunkQueueMessage(msg.body)) {
    console.error(
      JSON.stringify({ event: "chunk_message_unparseable", ts: nowSeconds(), messageId: msg.id }),
    );
    msg.ack();
    return;
  }
  const { jobId, chunkIndex } = msg.body;
  const round = msg.body.round ?? 0;

  // (b) Pre-send skip check: only the round the chunk is currently in may
  // run. A finished chunk, or a message for a round already settled (a
  // redelivery, or a reaper re-enqueue racing the original), is acked.
  const chunk = await getJobChunk(db, jobId, chunkIndex);
  if (!chunk) {
    // Producer bookkeeping may not have landed yet — retry, don't poison.
    console.error(
      JSON.stringify({ event: "chunk_row_missing", ts: nowSeconds(), jobId, chunkIndex, attempts: msg.attempts }),
    );
    msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    return;
  }
  if (chunk.status !== "pending" || chunk.round !== round) {
    console.log(
      JSON.stringify({
        event: "chunk_already_handled",
        ts: nowSeconds(),
        jobId,
        chunkIndex,
        status: chunk.status,
        chunkRound: chunk.round,
        messageRound: round,
      }),
    );
    msg.ack();
    return;
  }

  // (c) Load this chunk's slice of the payload (a ranged R2 read). A thrown
  // R2 error propagates to the outer catch (infra retry); a missing object
  // gets its own explicit retry.
  const payload = await readChunkPayload(env, jobId, chunk);
  if (!payload) {
    console.error(JSON.stringify({ event: "job_payload_missing", ts: nowSeconds(), jobId, chunkIndex }));
    msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    return;
  }

  const targets = resolveTargets(payload, pendingIndexes(chunk, payload.recipients.length));
  const sends = targets.flatMap((target) => (target.body === undefined ? [] : [{ to: target.to, body: target.body }]));

  // (d) Dispatch — unless this round already did and checkpointed its
  // results before a failure further down. Skips the plan/dispatch
  // round-trip entirely when nothing in the round resolved a body.
  let results = await readRoundResults(env, jobId, chunkIndex, round);
  if (results) {
    console.warn(JSON.stringify({ event: "round_results_replayed", ts: nowSeconds(), jobId, chunkIndex, round }));
  } else {
    results = [];
    if (sends.length > 0) {
      const plan = await buildDispatchPlan(env, db, payload.appId, payload.maskingProfile, {
        maskingStrict: payload.maskingStrict,
      });
      if (plan.warnings.length > 0) {
        console.warn(
          JSON.stringify({ event: "dispatch_plan_warnings", ts: nowSeconds(), jobId, chunkIndex, warnings: plan.warnings }),
        );
      }
      results = await dispatch(plan.entries, toDispatchInput(sends));
      // Best-effort: without the checkpoint a redelivery re-sends this round
      // (duplicates over loss), which is exactly the pre-checkpoint behavior.
      await writeRoundResults(env, jobId, chunkIndex, round, results).catch((err: unknown) => {
        console.warn(JSON.stringify({ event: "round_results_write_failed", jobId, chunkIndex, round, error: errorMessage(err) }));
      });
    }
  }

  // (e) Settle gate + counter rollup, atomically, AFTER the send — never
  // before (ADR 0002). If this throws, nothing was committed: the outer
  // catch retries and the redelivery replays the checkpoint.
  const settled = settleRound(payload.appId, jobId, targets, results, {
    allowRetry: round + 1 < SEND_ROUNDS,
    unsentReason: "not dispatched",
  });
  const { claimed, jobFinished } = await settleChunkRound(db, {
    jobId,
    chunkIndex,
    round,
    sent: settled.sent,
    failed: settled.failed,
    retryIndexes: settled.retryIndexes,
  });
  if (!claimed) {
    console.warn(JSON.stringify({ event: "chunk_claim_lost", ts: nowSeconds(), jobId, chunkIndex, round }));
    msg.ack();
    return;
  }

  // (f) History, checkpoint and payload cleanup — best-effort.
  await afterSettle(env, db, { jobId, chunkIndex, round, rows: settled.rows, jobFinished });

  // (g) Retryable failures go to the next round, after a backoff. The round
  // is already claimed in D1, so if enqueueing it fails the chunk is marked
  // idle and the reaper enqueues it instead.
  if (settled.retryIndexes.length > 0) {
    const nextRound = round + 1;
    const delaySeconds = sendRoundDelaySeconds(nextRound);
    try {
      await env.SMS_QUEUE.send({ jobId, chunkIndex, round: nextRound } satisfies ChunkQueueMessage, { delaySeconds });
      console.log(
        JSON.stringify({
          event: "chunk_round_scheduled",
          ts: nowSeconds(),
          jobId,
          chunkIndex,
          round: nextRound,
          recipients: settled.retryIndexes.length,
          delaySeconds,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({ event: "chunk_round_enqueue_failed", ts: nowSeconds(), jobId, chunkIndex, round: nextRound, error: errorMessage(err) }),
      );
      await markChunksStale(db, jobId, { from: chunkIndex, to: chunkIndex }).catch((markErr: unknown) => {
        console.error(JSON.stringify({ event: "chunk_mark_stale_failed", jobId, chunkIndex, error: errorMessage(markErr) }));
      });
    }
  }

  msg.ack();
}

/* ------------------------------------------------------------------ */
/* Force-finish: dead-lettered ("sms-dlq") or abandoned (reaper) chunks */
/* ------------------------------------------------------------------ */

/**
 * Finishes a chunk that won't complete normally. If its current round was
 * dispatched (a results checkpoint exists), those sends happened and are
 * recorded as such; every other recipient still pending fails with
 * `reason`. With `expectedRound`, only acts while the chunk is still in that
 * round. Returns false when there was nothing to finish.
 */
export async function forceFinishChunk(
  env: Env,
  db: Db,
  input: { jobId: string; chunkIndex: number; reason: string; expectedRound?: number },
): Promise<boolean> {
  const { jobId, chunkIndex, reason } = input;
  const chunk = await getJobChunk(db, jobId, chunkIndex);
  if (!chunk || chunk.status !== "pending") return false;
  if (input.expectedRound !== undefined && chunk.round !== input.expectedRound) return false;

  const round = chunk.round;
  const [payload, results] = await Promise.all([
    readChunkPayload(env, jobId, chunk),
    readRoundResults(env, jobId, chunkIndex, round),
  ]);

  let settled: RoundSettlement;
  if (payload) {
    const targets = resolveTargets(payload, pendingIndexes(chunk, payload.recipients.length));
    settled = settleRound(payload.appId, jobId, targets, results, { allowRetry: false, unsentReason: reason });
  } else {
    // Payload gone (cleanup or retention): counts only, from the chunk row.
    const remaining = pendingIndexes(chunk, chunk.total).length;
    const sent = results?.filter((result) => result.accepted).length ?? 0;
    settled = { rows: [], sent, failed: Math.max(0, remaining - sent), retryIndexes: [] };
    console.warn(JSON.stringify({ event: "force_finish_payload_missing", ts: nowSeconds(), jobId, chunkIndex }));
  }

  const { claimed, jobFinished } = await settleChunkRound(db, {
    jobId,
    chunkIndex,
    round,
    sent: settled.sent,
    failed: settled.failed,
    retryIndexes: [],
  });
  if (!claimed) return false;

  await afterSettle(env, db, { jobId, chunkIndex, round, rows: settled.rows, jobFinished });
  console.warn(
    JSON.stringify({
      event: "chunk_force_finished",
      ts: nowSeconds(),
      jobId,
      chunkIndex,
      round,
      reason,
      sent: settled.sent,
      failed: settled.failed,
    }),
  );
  return true;
}

async function processDlqMessage(msg: Message<unknown>, env: Env, db: Db): Promise<void> {
  if (!isChunkQueueMessage(msg.body)) {
    console.error(JSON.stringify({ event: "dlq_message_unparseable", ts: nowSeconds(), messageId: msg.id }));
    msg.ack();
    return;
  }
  const { jobId, chunkIndex } = msg.body;
  const round = msg.body.round ?? 0;

  // If this throws, nothing committed and the outer catch retries with
  // backoff (DLQ max_retries 3, then it drops — the reaper then finds the
  // chunk idle and finishes it).
  const finished = await forceFinishChunk(env, db, {
    jobId,
    chunkIndex,
    reason: "dead-lettered after retries exhausted",
    expectedRound: round,
  });
  if (!finished) {
    console.log(JSON.stringify({ event: "dlq_chunk_already_handled", ts: nowSeconds(), jobId, chunkIndex, round }));
  }
  msg.ack();
}
