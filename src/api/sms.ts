/**
 * Send/Job routes. ADR 0002 (send-before-record) governs both paths:
 * provider dispatch happens first and its result is what the caller gets
 * back; D1 history writes happen after and are best-effort, wrapped so a
 * D1 failure never turns an accepted send into a failed response.
 *
 * Both POST routes run behind the per-App rate limit and `Idempotency-Key`
 * support, and charge the App's daily recipient quota before sending.
 */

import { Hono, type Context } from "hono";
import {
  getDb,
  getJobForApp,
  getTemplate,
  insertBulkJob,
  insertMessages,
  jobs,
  listMessagesByJob,
  markChunksStale,
  type Db,
  type NewMessageRow,
} from "../db";
import { buildDispatchPlan, maskingProfileExists } from "../core/plan";
import { deleteJobObjects, encodeJobPayload, writeJobPayload } from "../core/payload";
import { dispatch, toDispatchInput } from "../sms/dispatch";
import { isValidPhone } from "../sms/phone";
import { extractTokens, resolveBody } from "../sms/template";
import {
  CHUNK_SIZE,
  MAX_BODY_BYTES,
  MAX_JOB_RECIPIENTS,
  MAX_MESSAGE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SYNC_BODY_BYTES,
  MAX_SYNC_RECIPIENTS,
  TEMPLATE_TOKEN_NAME_REGEX,
} from "../shared/constants";
import type {
  AppEnv,
  ChunkQueueMessage,
  DispatchResultItem,
  JobPayloadHeader,
  JobRecipient,
} from "../shared/types";
import { requestBodyLimit } from "../shared/body-limit";
import { idempotency } from "./idempotency";
import { chargeDailyQuota, sendRateLimit } from "./limits";
import {
  assertRecipientCount,
  fail,
  normalizeRecipients,
  parseQueryInt,
  readJsonBody,
  truncate,
  type RecipientInput,
} from "./validate";

export const smsRoutes = new Hono<AppEnv>();

/** Cloudflare Queues hard cap on messages per sendBatch() call. */
const QUEUE_SEND_BATCH_LIMIT = 100;
/** Masking profile labels are 1-32 characters (Admin → Apps). */
const MAX_MASKING_LABEL_LENGTH = 32;
const MAX_REQUIRED_TOKENS = 20;

interface SendFields {
  message?: string;
  templateId?: number;
  maskingProfile?: string;
  maskingStrict?: boolean;
  recipients: unknown;
  requiredTemplateTokens?: string[];
}

function parseSendFields(raw: unknown): SendFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(400, "body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.message !== undefined && typeof obj.message !== "string") {
    fail(400, `"message" must be a string`);
  }
  if (typeof obj.message === "string" && obj.message.length > MAX_MESSAGE_LENGTH) {
    fail(400, `"message" exceeds ${MAX_MESSAGE_LENGTH} characters`);
  }
  if (
    obj.templateId !== undefined &&
    (typeof obj.templateId !== "number" || !Number.isSafeInteger(obj.templateId) || obj.templateId <= 0)
  ) {
    fail(400, `"templateId" must be a positive integer`);
  }
  if (obj.maskingProfile !== undefined && typeof obj.maskingProfile !== "string") {
    fail(400, `"maskingProfile" must be a string`);
  }
  if (
    typeof obj.maskingProfile === "string" &&
    (obj.maskingProfile.length < 1 || obj.maskingProfile.length > MAX_MASKING_LABEL_LENGTH)
  ) {
    fail(400, `"maskingProfile" must be 1-${MAX_MASKING_LABEL_LENGTH} characters`);
  }
  if (obj.maskingStrict !== undefined && typeof obj.maskingStrict !== "boolean") {
    fail(400, `"maskingStrict" must be a boolean`);
  }
  if (
    obj.requiredTemplateTokens !== undefined &&
    (!Array.isArray(obj.requiredTemplateTokens) ||
      obj.requiredTemplateTokens.length > MAX_REQUIRED_TOKENS ||
      obj.requiredTemplateTokens.some((token) => typeof token !== "string" || !TEMPLATE_TOKEN_NAME_REGEX.test(token)))
  ) {
    fail(400, `"requiredTemplateTokens" must be an array of at most ${MAX_REQUIRED_TOKENS} token names`);
  }

  return {
    message: obj.message as string | undefined,
    templateId: obj.templateId as number | undefined,
    maskingProfile: obj.maskingProfile as string | undefined,
    maskingStrict: obj.maskingStrict as boolean | undefined,
    recipients: obj.recipients,
    requiredTemplateTokens: obj.requiredTemplateTokens as string[] | undefined,
  };
}

/** `requiredTemplateTokens` (e.g. an OTP's code): each must be a placeholder
 *  of the template as it is now and have a value for every recipient, so an
 *  edited template can never send without it. */
function assertRequiredTokens(
  templateBody: string | undefined,
  tokens: readonly string[] | undefined,
  recipients: readonly RecipientInput[],
): void {
  if (!tokens?.length) return;
  if (templateBody === undefined) fail(400, `"requiredTemplateTokens" needs a "templateId"`);
  const available = new Set(extractTokens(templateBody));
  for (const token of tokens) {
    if (!available.has(token)) fail(400, `required template token "${token}" is not in the template`);
    const index = recipients.findIndex((r) => r.message !== undefined || !r.vars?.[token]?.trim());
    if (index >= 0) fail(400, `recipients[${index}]: required template token "${token}" has no value`);
  }
}

async function loadTemplateBody(db: Db, appId: number, templateId: number | undefined): Promise<string | undefined> {
  if (templateId === undefined) return undefined;
  const template = await getTemplate(db, appId, templateId);
  if (!template) return fail(404, "template not found");
  return template.body;
}

/** A label that matches none of the App's masking profiles is almost always
 *  a typo, and would otherwise send under the global sender identity. */
async function assertMaskingProfile(c: Context<AppEnv>, db: Db, label: string | undefined): Promise<void> {
  if (label === undefined) return;
  if (!(await maskingProfileExists(c.env, db, c.var.app.id, label))) {
    fail(400, `unknown masking profile "${label}"`);
  }
}

/** A resolved body is sendable when non-empty and within MAX_MESSAGE_LENGTH. */
function bodyProblem(body: string | undefined): string | null {
  if (body === undefined || body.length === 0) return "no message body resolved";
  if (body.length > MAX_MESSAGE_LENGTH) return `body exceeds ${MAX_MESSAGE_LENGTH} characters`;
  return null;
}

/* ------------------------------------------------------------------ */
/* POST /sms/send — sync, inline dispatch                              */
/* ------------------------------------------------------------------ */

smsRoutes.post(
  "/sms/send",
  sendRateLimit,
  requestBodyLimit(MAX_SYNC_BODY_BYTES),
  idempotency(),
  async (c) => {
    const db = getDb(c.env);
    const app = c.var.app;

    const raw = await readJsonBody<unknown>(c);
    const fields = parseSendFields(raw);
    const normalized = normalizeRecipients(fields.recipients);
    assertRecipientCount(normalized.length, MAX_SYNC_RECIPIENTS);
    const templateBody = await loadTemplateBody(db, app.id, fields.templateId);

    // Body-source validation applies to every recipient, regardless of phone
    // validity — an invalid phone still needs a resolvable body to be a valid
    // request at all.
    const bodies: string[] = normalized.map((recipient, index) => {
      const body = resolveBody(recipient, { message: fields.message, templateBody });
      const problem = bodyProblem(body);
      return problem === null ? (body as string) : fail(400, `recipients[${index}]: ${problem}`);
    });
    assertRequiredTokens(templateBody, fields.requiredTemplateTokens, normalized);
    await assertMaskingProfile(c, db, fields.maskingProfile);

    const validIndexes: number[] = [];
    normalized.forEach((recipient, index) => {
      if (isValidPhone(recipient.to)) validIndexes.push(index);
    });
    await chargeDailyQuota(c, db, validIndexes.length);

    const dispatchInput = toDispatchInput(
      validIndexes.map((i) => ({ to: (normalized[i] as RecipientInput).to, body: bodies[i] as string })),
    );
    const { entries, warnings } =
      validIndexes.length > 0
        ? await buildDispatchPlan(c.env, db, app.id, fields.maskingProfile, { maskingStrict: fields.maskingStrict })
        : { entries: [], warnings: [] };
    const dispatchResults = validIndexes.length > 0 ? await dispatch(entries, dispatchInput) : [];

    const results: DispatchResultItem[] = normalized.map((recipient) => ({
      to: recipient.to,
      accepted: false,
      reason: "invalid phone number",
      provider: null,
      retryable: false,
    }));
    validIndexes.forEach((originalIndex, vi) => {
      const result = dispatchResults[vi];
      if (result) results[originalIndex] = result;
    });

    const id = crypto.randomUUID();
    const sentCount = results.filter((r) => r.accepted).length;
    const failedCount = results.length - sentCount;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const jobBody: string | null =
      templateBody ?? (dispatchInput.kind === "uniform" && validIndexes.length > 0 ? dispatchInput.message : null);

    // History write is best-effort and happens after the response is already
    // decided (ADR 0002) — never awaited by the request itself. A sync send
    // is complete at insert time, so the jobs row is written whole here
    // rather than through the bulk-job helper.
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await db.insert(jobs).values({
            id,
            appId: app.id,
            kind: "sync",
            status: failedCount > 0 ? "completed_with_errors" : "completed",
            body: jobBody,
            templateId: fields.templateId ?? null,
            maskingProfile: fields.maskingProfile ?? null,
            total: normalized.length,
            sent: sentCount,
            failed: failedCount,
            chunkCount: 0,
            chunksDone: 0,
            completedAt: nowSeconds,
            createdAt: nowSeconds,
          });

          const rows: NewMessageRow[] = normalized.map((recipient, index) => {
            const result = results[index] as DispatchResultItem;
            return {
              jobId: id,
              appId: app.id,
              recipient: recipient.to,
              // The rendered text for template sends too: vars aren't stored,
              // so the history row is the only record of what went out.
              body: templateBody !== undefined || recipient.message !== undefined ? (bodies[index] ?? null) : null,
              provider: result.provider ?? null,
              status: result.accepted ? "sent" : "failed",
              reason: result.reason ? truncate(result.reason, MAX_REASON_LENGTH) : null,
              trackingId: result.trackingId ?? null,
            };
          });
          await insertMessages(db, rows);
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "sync_history_write_failed",
              appId: app.id,
              jobId: id,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })(),
    );

    return c.json({ id, results, warnings }, 200);
  },
);

/* ------------------------------------------------------------------ */
/* POST /sms/jobs — bulk, async via queue                              */
/* ------------------------------------------------------------------ */

smsRoutes.post(
  "/sms/jobs",
  sendRateLimit,
  requestBodyLimit(MAX_BODY_BYTES),
  // Jobs already require D1. Sending without a recorded retry key would let
  // a lost response create a second Job on retry.
  idempotency({ failClosed: true }),
  async (c) => {
    const db = getDb(c.env);
    const app = c.var.app;

    const raw = await readJsonBody<unknown>(c);
    const fields = parseSendFields(raw);
    const normalized = normalizeRecipients(fields.recipients);
    assertRecipientCount(normalized.length, MAX_JOB_RECIPIENTS);
    const templateBody = await loadTemplateBody(db, app.id, fields.templateId);

    // Strict validation: unlike /sms/send, an invalid phone or missing body
    // rejects the whole request rather than becoming a soft per-recipient
    // failure — a bulk job has no synchronous per-recipient response to carry
    // that information back on.
    const offending: number[] = [];
    normalized.forEach((recipient, index) => {
      const body = resolveBody(recipient, { message: fields.message, templateBody });
      if (bodyProblem(body) !== null || !isValidPhone(recipient.to)) offending.push(index);
    });
    if (offending.length > 0) {
      return c.json({ error: "invalid recipients", indexes: offending.slice(0, 10) }, 400);
    }
    assertRequiredTokens(templateBody, fields.requiredTemplateTokens, normalized);
    await assertMaskingProfile(c, db, fields.maskingProfile);
    await chargeDailyQuota(c, db, normalized.length);

    const jobId = crypto.randomUUID();
    // The consumer resolves each body with the same resolveBody() rule, so
    // the header carries exactly the sources validated above: the template
    // when one is referenced, otherwise the request-level message.
    const header: JobPayloadHeader = {
      jobId,
      appId: app.id,
      ...(templateBody !== undefined
        ? { templateId: fields.templateId, templateBody }
        : fields.message !== undefined
          ? { message: fields.message }
          : {}),
      ...(fields.maskingProfile !== undefined ? { maskingProfile: fields.maskingProfile } : {}),
      ...(fields.maskingStrict ? { maskingStrict: true } : {}),
    };
    const payloadRecipients: JobRecipient[] = normalized.map((recipient) => ({
      to: recipient.to,
      ...(recipient.message !== undefined ? { message: recipient.message } : {}),
      ...(recipient.vars !== undefined ? { vars: recipient.vars } : {}),
    }));
    const { body: payload, chunks } = encodeJobPayload(header, payloadRecipients, CHUNK_SIZE);
    await writeJobPayload(c.env, jobId, payload);

    try {
      await insertBulkJob(
        db,
        {
          id: jobId,
          appId: app.id,
          kind: "bulk",
          status: "queued",
          body: templateBody ?? fields.message ?? null,
          templateId: fields.templateId ?? null,
          maskingProfile: fields.maskingProfile ?? null,
          total: normalized.length,
        },
        chunks,
      );
    } catch (err) {
      await deleteJobObjects(c.env, jobId).catch((delErr: unknown) => {
        console.warn(
          JSON.stringify({ event: "job_payload_cleanup_failed", jobId, error: String(delErr) }),
        );
      });
      console.error(
        JSON.stringify({
          event: "job_d1_write_failed",
          jobId,
          appId: app.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return fail(503, "job could not be recorded; try again");
    }

    // From here the Job is durably recorded (D1 + R2), so the request
    // succeeds even if enqueueing fails partway: chunks already enqueued may
    // be sending, and a 503 would invite the client to submit the whole Job
    // again. The chunks that didn't make it are marked idle instead, and the
    // next reaper run (cron, every 15 min) enqueues them.
    const chunkMessages: ChunkQueueMessage[] = chunks.map((_, chunkIndex) => ({ jobId, chunkIndex, round: 0 }));
    for (let offset = 0; offset < chunkMessages.length; offset += QUEUE_SEND_BATCH_LIMIT) {
      const slice = chunkMessages.slice(offset, offset + QUEUE_SEND_BATCH_LIMIT);
      try {
        await c.env.SMS_QUEUE.sendBatch(slice.map((body) => ({ body })));
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "job_enqueue_failed",
            jobId,
            appId: app.id,
            fromChunk: offset,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        await markChunksStale(db, jobId, { from: offset }).catch((markErr: unknown) => {
          console.error(JSON.stringify({ event: "job_mark_stale_failed", jobId, error: String(markErr) }));
        });
        break;
      }
    }

    return c.json({ jobId, total: normalized.length, chunkCount: chunks.length }, 202);
  },
);

/* ------------------------------------------------------------------ */
/* GET /sms/jobs/:id, GET /sms/jobs/:id/messages                       */
/* ------------------------------------------------------------------ */

smsRoutes.get("/sms/jobs/:id", async (c) => {
  const db = getDb(c.env);
  const job = await getJobForApp(db, c.var.app.id, c.req.param("id"));
  if (!job) return fail(404, "job not found");
  return c.json(job, 200);
});

smsRoutes.get("/sms/jobs/:id/messages", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const job = await getJobForApp(db, c.var.app.id, id);
  if (!job) return fail(404, "job not found");

  // `before` is the preferred way to page: pass the previous page's
  // `nextBefore` and each page costs `limit` index rows, where `offset`
  // (kept for older clients, and ignored alongside `before`) costs
  // offset + limit. 0 stands for "absent": a real cursor is clamped to ≥ 1.
  const limit = parseQueryInt(c.req.query("limit"), { default: 50, min: 1, max: 200 });
  const cursor = parseQueryInt(c.req.query("before"), { default: 0, min: 1 });
  const before = cursor > 0 ? cursor : null;
  const offset = before === null ? parseQueryInt(c.req.query("offset"), { default: 0, min: 0 }) : 0;
  const messages = await listMessagesByJob(db, id, { limit, offset, before: before ?? undefined });
  const nextBefore = messages.length === limit ? (messages[messages.length - 1]?.id ?? null) : null;
  return c.json({ jobId: id, limit, offset, before, nextBefore, messages }, 200);
});
