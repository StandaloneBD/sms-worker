/**
 * Queue consumer — the two consumers declared in wrangler.jsonc share this
 * one handler, branching on `batch.queue`:
 *
 *  - "sms-jobs": normal chunk processing (max_retries 5, DLQ "sms-dlq").
 *  - "sms-dlq": last-chance accounting for chunks that exhausted retries on
 *    "sms-jobs" (max_retries 3, then the message drops).
 *
 * Ordering on the main path is load-bearing (ADR 0002: prefer duplicate
 * sends over lost sends) — the provider dispatch happens BEFORE the
 * `completeChunk` idempotency gate (which atomically claims the chunk and
 * rolls up job counters), and per-recipient history writes after the gate
 * are best-effort. See per-step comments below.
 */

import { getDb } from "../db";
import {
  completeChunk,
  getJob,
  getJobChunk,
  insertMessages,
  markJobRunning,
  type Db,
  type NewMessageRow,
} from "../db/queries";
import { buildDispatchPlan } from "../core/plan";
import { dispatch } from "../sms/dispatch";
import { renderTemplate } from "../sms/template";
import { CHUNK_SIZE, MAX_REASON_LENGTH, RETRY_BASE_SECONDS, RETRY_MAX_SECONDS, r2JobKey } from "../shared/constants";
import type { ChunkQueueMessage, DispatchInput, DispatchResultItem, JobPayload, JobRecipient } from "../shared/types";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateReason(reason: string): string {
  return reason.length > MAX_REASON_LENGTH ? reason.slice(0, MAX_REASON_LENGTH) : reason;
}

/** Chunk retry backoff, per spec: RETRY_BASE_SECONDS * 2^attempts, capped. */
function backoffSeconds(attempts: number): number {
  return Math.min(RETRY_BASE_SECONDS * 2 ** attempts, RETRY_MAX_SECONDS);
}

/** Narrows an unknown queue body without a cast to `any`. */
function isChunkQueueMessage(value: unknown): value is ChunkQueueMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.jobId === "string" &&
    record.jobId.length > 0 &&
    typeof record.chunkIndex === "number" &&
    Number.isSafeInteger(record.chunkIndex) &&
    record.chunkIndex >= 0
  );
}

function assertPayloadMatchesJob(payload: JobPayload, job: NonNullable<Awaited<ReturnType<typeof getJob>>>): void {
  if (!payload || payload.jobId !== job.id || payload.appId !== job.appId || payload.chunkSize !== CHUNK_SIZE || !Array.isArray(payload.recipients) || payload.recipients.length !== job.total) {
    throw new Error("job payload does not match its recorded job");
  }
}

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const db = getDb(env);

  if (batch.queue === "sms-jobs") {
    for (const msg of batch.messages) {
      try {
        await processJobMessage(msg, env, db);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "job_chunk_unhandled_error",
            ts: nowSeconds(),
            messageId: msg.id,
            attempts: msg.attempts,
            error: errorMessage(err),
          }),
        );
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
      }
    }
    return;
  }

  if (batch.queue === "sms-dlq") {
    for (const msg of batch.messages) {
      try {
        await processDlqMessage(msg, env, db);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "dlq_chunk_unhandled_error",
            ts: nowSeconds(),
            messageId: msg.id,
            attempts: msg.attempts,
            error: errorMessage(err),
          }),
        );
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
      }
    }
    return;
  }

  console.error(JSON.stringify({ event: "unknown_queue", ts: nowSeconds(), queue: batch.queue }));
  batch.ackAll();
}

/* ------------------------------------------------------------------ */
/* "sms-jobs" — main chunk processing                                  */
/* ------------------------------------------------------------------ */

async function processJobMessage(msg: Message<unknown>, env: Env, db: Db): Promise<void> {
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

  const job = await getJob(db, jobId);
  if (!job || job.status === "failed") {
    msg.ack();
    return;
  }

  // (b) Pre-send skip check.
  const chunk = await getJobChunk(db, jobId, chunkIndex);
  if (!chunk) {
    // Job/chunk creation is atomic. Missing bookkeeping is an invariant
    // failure; retry infrastructure errors and let the DLQ account for it.
    console.error(
      JSON.stringify({ event: "chunk_row_missing", ts: nowSeconds(), jobId, chunkIndex, attempts: msg.attempts }),
    );
    msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    return;
  }
  if (chunk.status !== "pending") {
    console.log(
      JSON.stringify({ event: "chunk_already_handled", ts: nowSeconds(), jobId, chunkIndex, status: chunk.status }),
    );
    await cleanupPayloadIfComplete(db, env, jobId);
    msg.ack();
    return;
  }

  // (c) Cheap guarded status flip. Best-effort per ADR 0002 (queue chunk
  // processing: only the claim marker gates ack); a D1 hiccup here must not
  // block the send below.
  try {
    await markJobRunning(db, jobId);
  } catch (err) {
    console.warn(
      JSON.stringify({ event: "mark_job_running_failed", ts: nowSeconds(), jobId, chunkIndex, error: errorMessage(err) }),
    );
  }

  // (d) Load the payload (ADR 0001). A thrown R2 error propagates to the
  // outer catch (infra retry); a missing object gets its own explicit retry.
  const object = await env.PAYLOADS.get(r2JobKey(jobId));
  if (!object) {
    console.error(JSON.stringify({ event: "job_payload_missing", ts: nowSeconds(), jobId, chunkIndex }));
    msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    return;
  }
  const payload = await object.json<JobPayload>();
  assertPayloadMatchesJob(payload, job);

  // (e) Slice + resolve bodies.
  const start = chunkIndex * payload.chunkSize;
  const slice = payload.recipients.slice(start, start + payload.chunkSize);
  const resolved = slice.map((recipient) => resolveRecipient(payload, recipient));
  const dispatchable = resolved.filter((r): r is ResolvedSend => r.kind === "send");

  const kind = classifyDispatchKind(payload, dispatchable);

  // (f) Dispatch. Skips the plan/dispatch round-trip entirely when nothing
  // in this chunk resolved a body (keeps D1/subrequest usage down).
  let dispatchResults: DispatchResultItem[] = [];
  if (dispatchable.length > 0) {
    const input: DispatchInput =
      kind === "uniform"
        ? {
            kind: "uniform",
            // Non-empty by the dispatchable.length > 0 guard above.
            message: (dispatchable[0] as ResolvedSend).body,
            recipients: dispatchable.map((r) => r.to),
          }
        : { kind: "dynamic", messages: dispatchable.map((r) => ({ to: r.to, message: r.body })) };
    const plan = await buildDispatchPlan(env, db, payload.appId, payload.maskingProfile);
    if (plan.warnings.length > 0) console.warn(JSON.stringify({ event: "chunk_plan_warnings", jobId, chunkIndex, warnings: plan.warnings }));
    dispatchResults = await dispatch(plan.entries, input);
  }

  // (g) Idempotency gate + counter rollup, atomically, AFTER the send —
  // never before (ADR 0002). If this throws, nothing was committed: the
  // outer catch retries and redelivery re-sends (duplicates over loss).
  const { rows, sent, failed } = buildHistoryRows(payload.appId, jobId, resolved, dispatchResults, payload.templateBody !== undefined);
  const claimed = await completeChunk(db, { jobId, chunkIndex, sent, failed });
  if (!claimed) {
    console.warn(
      JSON.stringify({ event: "chunk_claim_lost", ts: nowSeconds(), jobId, chunkIndex }),
    );
    msg.ack();
    return;
  }

  // (h) Best-effort history rows. A failure here still acks: the chunk and
  // job counters are already committed; only per-recipient detail is lost
  // (ADR 0002 accepts history gaps, never blocked sends).
  try {
    await insertMessages(db, rows);
  } catch (err) {
    console.error(
      JSON.stringify({ event: "chunk_history_failed", ts: nowSeconds(), jobId, chunkIndex, error: errorMessage(err) }),
    );
  }

  // (i) Best-effort payload cleanup once the job is fully done.
  await cleanupPayloadIfComplete(db, env, jobId);

  msg.ack();
}

/** Deletes the R2 payload once the job has reached a terminal status.
 *  Best-effort: shared by the main and DLQ paths. */
async function cleanupPayloadIfComplete(db: Db, env: Env, jobId: string): Promise<void> {
  try {
    const job = await getJob(db, jobId);
    if (job && (job.status === "completed" || job.status === "completed_with_errors")) {
      await env.PAYLOADS.delete(r2JobKey(jobId));
    }
  } catch (err) {
    console.warn(
      JSON.stringify({ event: "job_payload_delete_failed", ts: nowSeconds(), jobId, error: errorMessage(err) }),
    );
  }
}

interface ResolvedSend {
  kind: "send";
  to: string;
  body: string;
  /** true only when the body came from an explicit recipient.message override. */
  isExplicitOverride: boolean;
}
interface ResolvedImmediateFail {
  kind: "immediate_fail";
  to: string;
}
type ResolvedRecipient = ResolvedSend | ResolvedImmediateFail;

function resolveRecipient(payload: JobPayload, recipient: JobRecipient): ResolvedRecipient {
  const body =
    recipient.message ??
    (payload.templateBody ? renderTemplate(payload.templateBody, recipient.vars) : payload.message);
  if (!body) return { kind: "immediate_fail", to: recipient.to };
  return { kind: "send", to: recipient.to, body, isExplicitOverride: recipient.message !== undefined };
}

/** "uniform" only when every dispatchable body is the untouched job-level
 *  message (no per-recipient override, no template) — otherwise "dynamic". */
function classifyDispatchKind(payload: JobPayload, dispatchable: ResolvedSend[]): "uniform" | "dynamic" {
  if (dispatchable.length === 0) return "uniform";
  if (payload.templateBody !== undefined) return "dynamic";
  return dispatchable.every((r) => !r.isExplicitOverride) ? "uniform" : "dynamic";
}

function buildHistoryRows(
  appId: number,
  jobId: string,
  resolved: ResolvedRecipient[],
  dispatchResults: DispatchResultItem[],
  hasTemplate: boolean,
): { rows: NewMessageRow[]; sent: number; failed: number } {
  const rows: NewMessageRow[] = [];
  let sent = 0;
  let failed = 0;
  let resultIndex = 0;

  for (const r of resolved) {
    if (r.kind === "immediate_fail") {
      failed++;
      rows.push({
        jobId,
        appId,
        recipient: r.to,
        body: null,
        provider: null,
        status: "failed",
        reason: "no message body resolved for recipient",
        trackingId: null,
      });
      continue;
    }

    const outcome = dispatchResults[resultIndex];
    resultIndex++;
    if (!outcome) {
      // Invariant: dispatch() returns exactly one result per dispatchable
      // recipient, in order — this would indicate an infra-level bug in the
      // dispatch module, not a data problem, so surface it loudly.
      throw new Error(`dispatch() returned no result for recipient at index ${resultIndex - 1}`);
    }

    if (outcome.accepted) sent++;
    else failed++;

    rows.push({
      jobId,
      appId,
      recipient: r.to,
      body: r.isExplicitOverride || hasTemplate ? r.body : null,
      provider: outcome.provider,
      status: outcome.accepted ? "sent" : "failed",
      reason: outcome.reason ? truncateReason(outcome.reason) : null,
      trackingId: outcome.trackingId ?? null,
    });
  }

  return { rows, sent, failed };
}

/* ------------------------------------------------------------------ */
/* "sms-dlq" — retries exhausted on "sms-jobs"                         */
/* ------------------------------------------------------------------ */

async function processDlqMessage(msg: Message<unknown>, env: Env, db: Db): Promise<void> {
  if (!isChunkQueueMessage(msg.body)) {
    console.error(JSON.stringify({ event: "dlq_message_unparseable", ts: nowSeconds(), messageId: msg.id }));
    msg.ack();
    return;
  }
  const { jobId, chunkIndex } = msg.body;

  const job = await getJob(db, jobId);
  if (!job || job.status === "failed") {
    msg.ack();
    return;
  }

  const chunk = await getJobChunk(db, jobId, chunkIndex);
  if (!chunk || chunk.status !== "pending") {
    console.log(
      JSON.stringify({
        event: "dlq_chunk_already_handled",
        ts: nowSeconds(),
        jobId,
        chunkIndex,
        status: chunk?.status ?? "missing",
      }),
    );
    await cleanupPayloadIfComplete(db, env, jobId);
    msg.ack();
    return;
  }

  const object = await env.PAYLOADS.get(r2JobKey(jobId));
  let payload: JobPayload | undefined;
  if (object) {
    try {
      const parsed = await object.json<JobPayload>();
      assertPayloadMatchesJob(parsed, job);
      payload = parsed;
    } catch (err) {
      // A permanently corrupt body must not exhaust the DLQ's retries and
      // leave job counters pending forever. Recover counts from D1 below.
      console.error(JSON.stringify({ event: "dlq_payload_invalid", jobId, chunkIndex, error: errorMessage(err) }));
    }
  }
  if (payload) {
    const start = chunkIndex * payload.chunkSize;
    const recipients = payload.recipients.slice(start, start + payload.chunkSize);

    // Atomic gate + rollup; if it throws, nothing committed and the outer
    // catch retries with backoff (DLQ max_retries 3, then it drops —
    // accepted; logged loudly by that outer catch).
    const claimed = await completeChunk(db, { jobId, chunkIndex, sent: 0, failed: recipients.length });
    if (!claimed) {
      console.warn(JSON.stringify({ event: "dlq_chunk_claim_lost", ts: nowSeconds(), jobId, chunkIndex }));
      msg.ack();
      return;
    }

    const rows: NewMessageRow[] = recipients.map((r) => {
      const resolved = resolveRecipient(payload, r);
      return {
        jobId,
        appId: payload.appId,
        recipient: r.to,
        body: resolved.kind === "send" && (resolved.isExplicitOverride || payload.templateBody !== undefined) ? resolved.body : null,
        provider: null,
        status: "failed",
        reason: "dead-lettered after retries exhausted",
        trackingId: null,
      };
    });
    // Best-effort per-recipient rows (counters already committed above).
    try {
      await insertMessages(db, rows);
    } catch (err) {
      console.error(
        JSON.stringify({ event: "dlq_history_failed", ts: nowSeconds(), jobId, chunkIndex, error: errorMessage(err) }),
      );
    }
    await cleanupPayloadIfComplete(db, env, jobId);
    msg.ack();
    return;
  }

  // Payload already gone (normal chunk-completion cleanup, or retention).
  // Recover counts from the jobs row: CHUNK_SIZE is the fixed sizing
  // constant every producer slices with (see shared/constants) — the jobs
  // table itself has no per-job chunkSize column, only `total`.
  const remaining = job.total - chunkIndex * CHUNK_SIZE;
  const failed = Math.max(0, Math.min(CHUNK_SIZE, remaining));
  const claimed = await completeChunk(db, { jobId, chunkIndex, sent: 0, failed });
  if (!claimed) {
    console.warn(JSON.stringify({ event: "dlq_chunk_claim_lost", ts: nowSeconds(), jobId, chunkIndex }));
    msg.ack();
    return;
  }
  console.warn(
    JSON.stringify({
      event: "dlq_chunk_payload_missing",
      ts: nowSeconds(),
      jobId,
      chunkIndex,
      failed,
    }),
  );
  await cleanupPayloadIfComplete(db, env, jobId);
  msg.ack();
}
