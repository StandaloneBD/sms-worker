import { createExecutionContext, createMessageBatch, env, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { smsRoutes } from "../src/api/sms";
import { completeChunk, getDb, getJob, insertJobWithChunks, listMessagesByJob, markJobFailed, purgeOlderThan } from "../src/db";
import { handleQueue } from "../src/queue/consumer";
import { recoverUnpublishedJobs } from "../src/queue/producer";
import { purgeOrphanedPayloads } from "../src/queue/retention";
import { CHUNK_SIZE, r2JobKey } from "../src/shared/constants";
import type { AppEnv, ChunkQueueMessage, JobPayload } from "../src/shared/types";
import { resetDatabase } from "./helpers";

const db = getDb(env);
let published: ChunkQueueMessage[];
let sendBatch: ReturnType<typeof vi.fn>;
let testEnv: Env;

beforeEach(async () => {
  await resetDatabase();
  published = [];
  sendBatch = vi.fn(async (rows: MessageSendRequest<ChunkQueueMessage>[]) => { published.push(...rows.map((row) => row.body)); });
  testEnv = { ...env, FAKE_SMS: "true", SMS_QUEUE: { ...env.SMS_QUEUE, sendBatch } } as Env;
});
afterEach(() => vi.restoreAllMocks());

function app() {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => { c.set("app", { id: 1, name: "test", isActive: true }); await next(); });
  router.route("/", smsRoutes);
  router.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    throw err;
  });
  return router;
}

async function submit(path: string, input: unknown) {
  const ctx = createExecutionContext();
  const res = await app().request(path, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } }, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function consume(pointer: ChunkQueueMessage, queue = "sms-jobs") {
  const ctx = createExecutionContext();
  const batch = createMessageBatch(queue, [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: pointer }]);
  await handleQueue(batch, testEnv, ctx);
  return getQueueResult(batch, ctx);
}

describe("bulk delivery", () => {
  it("preserves the uniform fallback alongside recipient overrides and unused vars", async () => {
    const res = await submit("/sms/jobs", { message: "Shared", recipients: ["01712345678", { to: "01712345679", message: "Custom" }, { to: "01712345680", vars: { NAME: "Ignored" } }] });
    expect(res.status).toBe(202);
    const { jobId } = await res.json<{ jobId: string }>();
    expect(await getJob(db, jobId)).toMatchObject({ body: "Shared", enqueuedAt: expect.any(Number), chunkCount: 1 });
    await consume(published[0]!);
    expect(await getJob(db, jobId)).toMatchObject({ status: "completed", sent: 3, failed: 0 });
    const history = await listMessagesByJob(db, jobId, { limit: 10, offset: 0 });
    expect(history.map((row) => row.body).sort()).toEqual(["Custom", null, null]);
    expect(await env.PAYLOADS.get(r2JobKey(jobId))).toBeNull();
  });

  it("stores rendered template history and skips a completed redelivery", async () => {
    const template = await env.DB.prepare("INSERT INTO templates (app_id, name, body, created_at, updated_at) VALUES (1, 'hello', 'Hi %NAME%', 1, 1) RETURNING id").first<{ id: number }>();
    const res = await submit("/sms/jobs", { templateId: template!.id, recipients: [{ to: "01712345678", vars: { NAME: "Rahim" } }] });
    const { jobId } = await res.json<{ jobId: string }>();
    await consume(published[0]!);
    await consume(published[0]!);
    expect(await getJob(db, jobId)).toMatchObject({ sent: 1, chunksDone: 1 });
    expect(await listMessagesByJob(db, jobId, { limit: 10, offset: 0 })).toMatchObject([{ body: "Hi Rahim" }]);
  });

  it("accepts a 50k-recipient job without exceeding D1's 100-parameter statement cap", async () => {
    const original = env.DB.prepare.bind(env.DB);
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      const statement = original(query);
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...values: unknown[]) => {
        expect(values.length).toBeLessThanOrEqual(100);
        return bind(...values);
      });
      return statement;
    });
    const res = await submit("/sms/jobs", { message: "Hi", recipients: Array(50_000).fill("01712345678") });
    expect(res.status).toBe(202);
    expect(prepare.mock.calls.length).toBeLessThan(50);
    expect(sendBatch.mock.calls.map((call) => call[0].length)).toEqual([100, 100]);
    expect(published).toHaveLength(200);
  });

  it("retains a partially enqueued payload, recovers pending pointers, and finishes all recipients", async () => {
    sendBatch.mockImplementationOnce(async (rows: MessageSendRequest<ChunkQueueMessage>[]) => { published.push(...rows.map((row) => row.body)); });
    sendBatch.mockRejectedValueOnce(new Error("queue unavailable"));
    const res = await submit("/sms/jobs", { message: "Hi", recipients: Array(CHUNK_SIZE * 101).fill("01712345678") });
    expect(res.status).toBe(202);
    const { jobId, warnings } = await res.json<{ jobId: string; warnings: string[] }>();
    expect(warnings).toHaveLength(1);
    expect(await getJob(db, jobId)).toMatchObject({ enqueuedAt: null, status: "queued" });
    expect(await env.PAYLOADS.get(r2JobKey(jobId))).not.toBeNull();
    await consume(published[0]!);
    await env.DB.prepare("UPDATE jobs SET created_at = 1 WHERE id = ?").bind(jobId).run();
    published = [];
    await recoverUnpublishedJobs(testEnv, db);
    expect(published).toHaveLength(100);
    expect(published.some((row) => row.chunkIndex === 0)).toBe(false);
    expect(await getJob(db, jobId)).toMatchObject({ enqueuedAt: expect.any(Number) });
    // Finalize without issuing 25k fake sends; the initial real consumer
    // pass above exercised payload resolution, recording, and skip behavior.
    for (const pointer of published) await completeChunk(db, { ...pointer, sent: CHUNK_SIZE, failed: 0 });
    expect(await getJob(db, jobId)).toMatchObject({ sent: CHUNK_SIZE * 101, chunksDone: 101, status: "completed" });
  });

  it("confirms a committed D1 batch after its response fails and keeps the job sendable", async () => {
    const original = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await original(statements);
      throw new Error("response lost after commit");
    });
    const res = await submit("/sms/jobs", { message: "Hi", recipients: ["01712345678"] });
    expect(res.status).toBe(202);
    const { jobId } = await res.json<{ jobId: string }>();
    expect(await env.PAYLOADS.get(r2JobKey(jobId))).not.toBeNull();
    expect(published).toEqual([{ jobId, chunkIndex: 0 }]);
    await consume(published[0]!);
    expect(await getJob(db, jobId)).toMatchObject({ sent: 1, failed: 0, status: "completed" });
  });

  it("returns a pollable job ID and preserves its payload when D1 acceptance is uncertain", async () => {
    vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("D1 unavailable"));
    const res = await submit("/sms/jobs", { message: "Hi", recipients: ["01712345678"] });
    expect(res.status).toBe(503);
    const { jobId } = await res.json<{ jobId: string }>();
    expect(await env.PAYLOADS.get(r2JobKey(jobId))).not.toBeNull();
    expect(await getJob(db, jobId)).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it("dead letters a missing payload with correct tail counts", async () => {
    const jobId = crypto.randomUUID();
    await insertJobWithChunks(db, { id: jobId, appId: 1, kind: "bulk", status: "queued", total: 251, chunkCount: 2 });
    await consume({ jobId, chunkIndex: 0 }, "sms-dlq");
    await consume({ jobId, chunkIndex: 1 }, "sms-dlq");
    expect(await getJob(db, jobId)).toMatchObject({ failed: 251, chunksDone: 2, status: "completed_with_errors" });
  });

  it("finalizes a corrupt dead-letter payload from recorded counts", async () => {
    const id = crypto.randomUUID();
    await insertJobWithChunks(db, { id, appId: 1, kind: "bulk", status: "queued", total: 1, chunkCount: 1 });
    await env.PAYLOADS.put(r2JobKey(id), "invalid JSON");
    await consume({ jobId: id, chunkIndex: 0 }, "sms-dlq");
    expect(await getJob(db, id)).toMatchObject({ failed: 1, chunksDone: 1, status: "completed_with_errors" });
    expect(await env.PAYLOADS.get(r2JobKey(id))).toBeNull();
  });

  it("rolls back all job bookkeeping when a chunk insert fails", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare("CREATE TRIGGER reject_chunk BEFORE INSERT ON job_chunks WHEN NEW.chunk_index = 1 BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
    try {
      await expect(insertJobWithChunks(db, { id, appId: 1, kind: "bulk", status: "queued", total: 251, chunkCount: 2 })).rejects.toThrow();
      expect(await getJob(db, id)).toBeUndefined();
      expect(await env.DB.prepare("SELECT count(*) FROM job_chunks WHERE job_id = ?").bind(id).first("count(*)")).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_chunk").run();
    }
  });

  it("concurrent chunk completion counts once and preserves the first completion timestamp", async () => {
    const id = crypto.randomUUID();
    await insertJobWithChunks(db, { id, appId: 1, kind: "bulk", status: "queued", total: 1, chunkCount: 1 });
    const results = await Promise.all([completeChunk(db, { jobId: id, chunkIndex: 0, sent: 1, failed: 0 }), completeChunk(db, { jobId: id, chunkIndex: 0, sent: 1, failed: 0 })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await env.DB.prepare("UPDATE jobs SET completed_at = 1 WHERE id = ?").bind(id).run();
    await completeChunk(db, { jobId: id, chunkIndex: 0, sent: 1, failed: 0 });
    expect(await getJob(db, id)).toMatchObject({ sent: 1, chunksDone: 1, completedAt: 1 });
  });

  it("does not overwrite a terminal failed status during a late counter rollup", async () => {
    const id = crypto.randomUUID();
    await insertJobWithChunks(db, { id, appId: 1, kind: "bulk", status: "queued", total: 1, chunkCount: 1 });
    await markJobFailed(db, id, "submission failed");
    await completeChunk(db, { jobId: id, chunkIndex: 0, sent: 0, failed: 1 });
    expect(await getJob(db, id)).toMatchObject({ status: "failed", error: "submission failed" });
  });

  it("rejects a payload whose app identity differs from D1 before dispatch", async () => {
    const res = await submit("/sms/jobs", { message: "Hi", recipients: ["01712345678"] });
    const { jobId } = await res.json<{ jobId: string }>();
    const object = await env.PAYLOADS.get(r2JobKey(jobId));
    const payload = await object!.json<JobPayload>();
    await env.PAYLOADS.put(r2JobKey(jobId), JSON.stringify({ ...payload, appId: 99 }));
    const result = await consume(published[0]!);
    expect(result.retryMessages).toHaveLength(1);
    expect(await getJob(db, jobId)).toMatchObject({ sent: 0, chunksDone: 0 });
  });
});

it("stores the resolved body for synchronous personalized history", async () => {
  const template = await env.DB.prepare("INSERT INTO templates (app_id, name, body, created_at, updated_at) VALUES (1, 'welcome', 'Hi %NAME%', 1, 1) RETURNING id").first<{ id: number }>();
  const res = await submit("/sms/send", { templateId: template!.id, recipients: [{ to: "01712345678", vars: { NAME: "Ayesha" } }] });
  expect(res.status).toBe(200);
  const { id } = await res.json<{ id: string }>();
  expect(await listMessagesByJob(db, id, { limit: 10, offset: 0 })).toMatchObject([{ body: "Hi Ayesha" }]);
});

it("keeps stale job rows until their R2 payload cleanup succeeds", async () => {
  const id = crypto.randomUUID();
  await insertJobWithChunks(db, { id, appId: 1, kind: "bulk", status: "queued", total: 1, chunkCount: 1 });
  await markJobFailed(db, id, "failed");
  await env.DB.prepare("UPDATE jobs SET completed_at = 1 WHERE id = ?").bind(id).run();
  await env.PAYLOADS.put(r2JobKey(id), "private payload");
  await expect(purgeOlderThan(db, 90, async () => { throw new Error("R2 unavailable"); })).rejects.toThrow("R2 unavailable");
  expect(await getJob(db, id)).toBeDefined();
  await purgeOlderThan(db, 90, (ids) => env.PAYLOADS.delete(ids.map(r2JobKey)));
  expect(await getJob(db, id)).toBeUndefined();
  expect(await env.PAYLOADS.get(r2JobKey(id))).toBeNull();
});

it("purges old orphan payloads while preserving active jobs and recent objects", async () => {
  const active = crypto.randomUUID();
  const orphan = crypto.randomUUID();
  await insertJobWithChunks(db, { id: active, appId: 1, kind: "bulk", status: "queued", total: 1, chunkCount: 1 });
  await env.PAYLOADS.put(r2JobKey(active), "active");
  await env.PAYLOADS.put(r2JobKey(orphan), "orphan");
  await purgeOrphanedPayloads(env, db);
  expect(await env.PAYLOADS.get(r2JobKey(orphan))).not.toBeNull();
  await purgeOrphanedPayloads(env, db, Date.now() + 91 * 86400 * 1000);
  expect(await env.PAYLOADS.get(r2JobKey(orphan))).toBeNull();
  expect(await env.PAYLOADS.get(r2JobKey(active))).not.toBeNull();
});
