/**
 * Send/Job routes. ADR 0002 (send-before-record) governs both paths:
 * provider dispatch happens first and its result is what the caller gets
 * back; D1 history writes happen after and are best-effort, wrapped so a
 * D1 failure never turns an accepted send into a failed response.
 */

import { Hono } from "hono";
import { requestBodyLimit } from "../shared/body-limit";
import {
  getDb,
  getJobForApp,
  getTemplate,
  insertJobWithChunks,
  insertMessages,
  jobs,
  listMessagesByJob,
  type NewMessageRow,
} from "../db";
import { buildDispatchPlan } from "../core/plan";
import { enqueueJob } from "../queue/producer";
import { dispatch } from "../sms/dispatch";
import { isValidPhone } from "../sms/phone";
import { renderTemplate } from "../sms/template";
import {
  CHUNK_SIZE,
  MAX_BODY_BYTES,
  MAX_JOB_RECIPIENTS,
  MAX_MESSAGE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SYNC_BODY_BYTES,
  MAX_SYNC_RECIPIENTS,
  r2JobKey,
} from "../shared/constants";
import type {
  AppEnv,
  DispatchInput,
  DispatchResultItem,
  JobPayload,
  JobRecipient,
} from "../shared/types";
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

interface SendFields {
  message?: string;
  templateId?: number;
  maskingProfile?: string;
  recipients: unknown;
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
  if (typeof obj.maskingProfile === "string" && (obj.maskingProfile.length < 1 || obj.maskingProfile.length > 32)) {
    fail(400, `"maskingProfile" must be 1-32 characters`);
  }

  return {
    message: obj.message as string | undefined,
    templateId: obj.templateId as number | undefined,
    maskingProfile: obj.maskingProfile as string | undefined,
    recipients: obj.recipients,
  };
}

/** Body-source rule shared by both routes: an explicit per-recipient message
 *  wins, then a template render, then the request-level uniform message. */
function computeBody(
  recipient: RecipientInput,
  opts: { message: string | undefined; templateBody: string | undefined },
): string | undefined {
  if (recipient.message !== undefined) return recipient.message;
  if (opts.templateBody !== undefined) return renderTemplate(opts.templateBody, recipient.vars);
  return opts.message;
}

function hadOverride(recipient: RecipientInput): boolean {
  return recipient.vars !== undefined || recipient.message !== undefined;
}

/* ------------------------------------------------------------------ */
/* POST /sms/send — sync, inline dispatch                              */
/* ------------------------------------------------------------------ */

smsRoutes.post(
  "/sms/send",
  requestBodyLimit(MAX_SYNC_BODY_BYTES),
  async (c) => {
    const db = getDb(c.env);
    const app = c.var.app;

    const raw = await readJsonBody<unknown>(c);
    const fields = parseSendFields(raw);
    const normalized = normalizeRecipients(fields.recipients);
    assertRecipientCount(normalized.length, MAX_SYNC_RECIPIENTS);

    let templateBody: string | undefined;
    if (fields.templateId !== undefined) {
      const template = await getTemplate(db, app.id, fields.templateId);
      if (!template) return fail(404, "template not found");
      templateBody = template.body;
    }

    // Body-source validation applies to every recipient, regardless of phone
    // validity — an invalid phone still needs a resolvable body to be a valid
    // request at all.
    const bodies: string[] = normalized.map((recipient, index) => {
      const body = computeBody(recipient, { message: fields.message, templateBody });
      if (body === undefined || body.length === 0) {
        return fail(400, `recipients[${index}]: no message body resolved`);
      }
      if (body.length > MAX_MESSAGE_LENGTH) {
        return fail(400, `recipients[${index}]: body exceeds ${MAX_MESSAGE_LENGTH} characters`);
      }
      return body;
    });

    const validIndexes: number[] = [];
    normalized.forEach((recipient, index) => {
      if (isValidPhone(recipient.to)) validIndexes.push(index);
    });
    const validRecipients = validIndexes.map((i) => normalized[i] as RecipientInput);
    const validBodies = validIndexes.map((i) => bodies[i] as string);

    const allSameBody = validBodies.length > 0 && validBodies.every((b) => b === validBodies[0]);
    const anyOverride = validRecipients.some(hadOverride);
    const uniform = allSameBody && !anyOverride;

    const dispatchInput: DispatchInput = uniform
      ? { kind: "uniform", message: validBodies[0] as string, recipients: validRecipients.map((r) => r.to) }
      : {
          kind: "dynamic",
          messages: validRecipients.map((r, i) => ({ to: r.to, message: validBodies[i] as string })),
        };

    const { entries, warnings } = await buildDispatchPlan(c.env, db, app.id, fields.maskingProfile);
    const dispatchResults =
      validRecipients.length > 0 ? await dispatch(entries, dispatchInput) : [];

    const results: DispatchResultItem[] = normalized.map((recipient) => ({
      to: recipient.to,
      accepted: false,
      reason: "invalid phone number",
      provider: null,
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
      fields.templateId !== undefined ? (templateBody ?? null) : (fields.message ?? null);

    // History write is best-effort and happens after the response is already
    // decided (ADR 0002) — never awaited by the request itself. `insertJob`'s
    // NewJobInput intentionally omits sent/failed/completedAt (those are only
    // meaningful once dispatch has happened, which for a sync send is *now*),
    // so this writes the jobs row directly via the schema table rather than
    // through that helper.
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
              body: fields.templateId !== undefined || recipient.message !== undefined ? (bodies[index] ?? null) : null,
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
  requestBodyLimit(MAX_BODY_BYTES),
  async (c) => {
    const db = getDb(c.env);
    const app = c.var.app;

    const raw = await readJsonBody<unknown>(c);
    const fields = parseSendFields(raw);
    const normalized = normalizeRecipients(fields.recipients);
    assertRecipientCount(normalized.length, MAX_JOB_RECIPIENTS);

    let templateBody: string | undefined;
    if (fields.templateId !== undefined) {
      const template = await getTemplate(db, app.id, fields.templateId);
      if (!template) return fail(404, "template not found");
      templateBody = template.body;
    }

    // Strict validation: unlike /sms/send, an invalid phone or missing body
    // rejects the whole request rather than becoming a soft per-recipient
    // failure — a bulk job has no synchronous per-recipient response to carry
    // that information back on.
    const offending: number[] = [];
    normalized.forEach((recipient, index) => {
      const body = computeBody(recipient, { message: fields.message, templateBody });
      const bodyOk = body !== undefined && body.length > 0 && body.length <= MAX_MESSAGE_LENGTH;
      const phoneOk = isValidPhone(recipient.to);
      if (!bodyOk || !phoneOk) offending.push(index);
    });
    if (offending.length > 0) {
      return c.json({ error: "invalid recipients", indexes: offending.slice(0, 10) }, 400);
    }

    const jobId = crypto.randomUUID();
    const chunkCount = Math.ceil(normalized.length / CHUNK_SIZE);

    const payloadRecipients: JobRecipient[] = normalized.map((recipient) => ({
      to: recipient.to,
      ...(recipient.message !== undefined ? { message: recipient.message } : {}),
      ...(recipient.vars !== undefined ? { vars: recipient.vars } : {}),
    }));

    const payload: JobPayload = {
      jobId,
      appId: app.id,
      // Keep the fallback body even when some recipients have overrides/vars.
      ...(fields.templateId === undefined && fields.message !== undefined
        ? { message: fields.message }
        : {}),
      ...(fields.templateId !== undefined
        ? { templateId: fields.templateId, templateBody: templateBody as string }
        : {}),
      ...(fields.maskingProfile !== undefined ? { maskingProfile: fields.maskingProfile } : {}),
      chunkSize: CHUNK_SIZE,
      recipients: payloadRecipients,
    };

    const r2Key = r2JobKey(jobId);
    await c.env.PAYLOADS.put(r2Key, JSON.stringify(payload));

    const jobBody: string | null =
      fields.templateId !== undefined ? (templateBody as string) : (payload.message ?? null);

    try {
      await insertJobWithChunks(db, {
        id: jobId,
        appId: app.id,
        kind: "bulk",
        status: "queued",
        body: jobBody,
        templateId: fields.templateId ?? null,
        maskingProfile: fields.maskingProfile ?? null,
        total: normalized.length,
        chunkCount,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "job_d1_write_failed",
          jobId,
          appId: app.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // A transport error can arrive AFTER D1 committed the atomic batch.
      // Preserve R2 until retention: deleting it could strand a recorded job.
      // Confirm the job when D1 is reachable, then continue publication.
      const recorded = await getJobForApp(db, app.id, jobId).catch((confirmErr: unknown) => {
        console.warn(JSON.stringify({ event: "job_d1_confirmation_failed", jobId, error: String(confirmErr) }));
        return undefined;
      });
      if (!recorded) {
        return c.json({ error: "job acceptance could not be confirmed; poll this job ID before resubmitting", jobId }, 503);
      }
    }

    try {
      await enqueueJob(c.env, db, jobId);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "job_enqueue_failed",
          jobId,
          appId: app.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // D1 + R2 durably accepted the job. Retain both after an ambiguous or
      // partial enqueue; the minute cron resumes pending chunks from D1.
      return c.json({ jobId, total: normalized.length, chunkCount, warnings: ["queue publication delayed; recovery will retry"] }, 202);
    }

    return c.json({ jobId, total: normalized.length, chunkCount }, 202);
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

  const limit = parseQueryInt(c.req.query("limit"), { default: 50, min: 1, max: 200 });
  const offset = parseQueryInt(c.req.query("offset"), { default: 0, min: 0 });
  const messages = await listMessagesByJob(db, id, { limit, offset });
  return c.json({ jobId: id, limit, offset, messages }, 200);
});
