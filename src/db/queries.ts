/**
 * Typed query helpers. Every function takes the drizzle db instance
 * returned by `getDb(env)` as its first argument (see ./index.ts).
 *
 * Batched inserts respect D1's 100-bound-params-per-statement hard limit —
 * see HISTORY_INSERT_ROWS in shared/constants and the local per-row-width
 * constants below.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { HISTORY_INSERT_ROWS } from "../shared/constants";
import type { JobStatus, ProviderName } from "../shared/types";
import {
  admins,
  appProviders,
  apps,
  jobChunks,
  jobs,
  maskingProfiles,
  messages,
  providerSettings,
  templates,
} from "./schema";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

const now = (): number => Math.floor(Date.now() / 1000);

/** D1/SQLite reports a unique-index violation as a plain Error naming the
 *  constraint, but drizzle wraps it in a DrizzleQueryError whose own message
 *  is just "Failed query: ..." — the SQLite text lives on the `cause` chain,
 *  so walk it. */
export function isUniqueConstraintError(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    // Drizzle's outer message includes SQL/parameters: an app named "Unique"
    // must not turn an unrelated D1 outage into an apparent name conflict.
    if (/^(?:D1_ERROR:\s*)?UNIQUE constraint failed:/i.test(e.message)) return true;
  }
  return false;
}

function firstOrThrow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${what}: expected a row, got none`);
  return row;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Runs a non-empty list of batch statements through db.batch(), splitting
 * into multiple sequential batch calls of at most `maxStatements` each so a
 * single call never grows unbounded.
 */
async function runBatched<T extends BatchItem<"sqlite">>(
  db: Db,
  statements: readonly T[],
  maxStatements: number,
): Promise<void> {
  const groups = chunkArray(statements, maxStatements);
  for (const group of groups) {
    const [first, ...rest] = group;
    if (!first) continue;
    // `first` is narrowed to T here, so `[first, ...rest]` is naturally the
    // non-empty tuple db.batch requires — no unsafe cast needed. Batches run
    // sequentially (not Promise.all) since each is an independent D1 call.
    await db.batch([first, ...rest]);
  }
}

/* ------------------------------------------------------------------ */
/* Apps                                                                */
/* ------------------------------------------------------------------ */

export async function createApp(
  db: Db,
  input: { name: string; keyHash: string; keyPrefix: string },
) {
  const rows = await db
    .insert(apps)
    .values({ name: input.name, keyHash: input.keyHash, keyPrefix: input.keyPrefix, createdAt: now() })
    .returning();
  return firstOrThrow(rows, "createApp");
}

export async function getAppByKeyHash(db: Db, keyHash: string) {
  const rows = await db.select().from(apps).where(eq(apps.keyHash, keyHash)).limit(1);
  return rows[0];
}

export async function getAppById(db: Db, id: number) {
  const rows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  return rows[0];
}

export async function listApps(db: Db) {
  return db.select().from(apps).orderBy(asc(apps.id));
}

export async function setAppActive(db: Db, id: number, active: boolean): Promise<boolean> {
  const result = await db.update(apps).set({ isActive: active }).where(eq(apps.id, id));
  return result.meta.changes > 0;
}

export async function rotateAppKey(
  db: Db,
  id: number,
  keyHash: string,
  keyPrefix: string,
): Promise<boolean> {
  const result = await db.update(apps).set({ keyHash, keyPrefix }).where(eq(apps.id, id));
  return result.meta.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export async function getGlobalProviders(db: Db) {
  return db.select().from(providerSettings).orderBy(asc(providerSettings.priority));
}

export interface GlobalProviderInput {
  provider: ProviderName;
  enabled: boolean;
  priority: number;
  /** For each optional field: undefined = keep existing value, null = clear, string = set. */
  senderId?: string | null;
  username?: string | null;
  senderName?: string | null;
  apiKeyEnc?: string | null;
}

function globalProviderStatement(db: Db, input: GlobalProviderInput) {
  const ts = now();
  return db
    .insert(providerSettings)
    .values({
      provider: input.provider,
      enabled: input.enabled,
      priority: input.priority,
      senderId: input.senderId ?? null,
      username: input.username ?? null,
      senderName: input.senderName ?? null,
      apiKeyEnc: input.apiKeyEnc ?? null,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: providerSettings.provider,
      set: {
        enabled: input.enabled,
        priority: input.priority,
        updatedAt: ts,
        ...(input.senderId !== undefined ? { senderId: input.senderId } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.senderName !== undefined ? { senderName: input.senderName } : {}),
        ...(input.apiKeyEnc !== undefined ? { apiKeyEnc: input.apiKeyEnc } : {}),
      },
    })
    .returning();
}

export async function upsertGlobalProvider(db: Db, input: GlobalProviderInput) {
  const rows = await globalProviderStatement(db, input);
  return firstOrThrow(rows, "upsertGlobalProvider");
}

export async function upsertGlobalProviders(db: Db, inputs: GlobalProviderInput[]): Promise<void> {
  const [first, ...rest] = inputs.map((input) => globalProviderStatement(db, input));
  if (first) await db.batch([first, ...rest]);
}

/**
 * Per-App dispatch plan: enabled providers in priority order. An App with
 * any appProviders rows uses those exclusively (filtered to enabled,
 * ordered by priority); an App with none inherits the global
 * providerSettings defaults.
 */
export async function getAppProviderPlan(
  db: Db,
  appId: number,
): Promise<{ provider: ProviderName; priority: number }[]> {
  const overrides = await db
    .select({ provider: appProviders.provider, priority: appProviders.priority, enabled: appProviders.enabled })
    .from(appProviders)
    .where(eq(appProviders.appId, appId));

  if (overrides.length > 0) {
    return overrides
      .filter((row) => row.enabled)
      .sort((a, b) => a.priority - b.priority)
      .map((row) => ({ provider: row.provider, priority: row.priority }));
  }

  const defaults = await db
    .select({ provider: providerSettings.provider, priority: providerSettings.priority })
    .from(providerSettings)
    .where(eq(providerSettings.enabled, true))
    .orderBy(asc(providerSettings.priority));
  return defaults;
}

export async function upsertAppProvider(
  db: Db,
  input: { appId: number; provider: ProviderName; enabled: boolean; priority: number },
) {
  const rows = await db
    .insert(appProviders)
    .values(input)
    .onConflictDoUpdate({
      target: [appProviders.appId, appProviders.provider],
      set: { enabled: input.enabled, priority: input.priority },
    })
    .returning();
  return firstOrThrow(rows, "upsertAppProvider");
}

export async function upsertAppProviders(
  db: Db,
  inputs: { appId: number; provider: ProviderName; enabled: boolean; priority: number }[],
): Promise<void> {
  const [first, ...rest] = inputs.map((input) => db.insert(appProviders).values(input)
    .onConflictDoUpdate({ target: [appProviders.appId, appProviders.provider], set: { enabled: input.enabled, priority: input.priority } }));
  if (first) await db.batch([first, ...rest]);
}

/* ------------------------------------------------------------------ */
/* Masking profiles                                                    */
/* ------------------------------------------------------------------ */

export async function listMaskingProfiles(db: Db, appId: number) {
  return db
    .select()
    .from(maskingProfiles)
    .where(eq(maskingProfiles.appId, appId))
    .orderBy(asc(maskingProfiles.provider), asc(maskingProfiles.label));
}

export async function getMaskingProfiles(db: Db, appId: number, label: string) {
  return db
    .select()
    .from(maskingProfiles)
    .where(and(eq(maskingProfiles.appId, appId), eq(maskingProfiles.label, label)))
    .orderBy(asc(maskingProfiles.provider));
}

export async function createMaskingProfile(
  db: Db,
  input: {
    appId: number;
    provider: ProviderName;
    label: string;
    senderId?: string | null;
    senderName?: string | null;
    username?: string | null;
    apiKeyEnc?: string | null;
  },
) {
  const rows = await db
    .insert(maskingProfiles)
    .values({
      appId: input.appId,
      provider: input.provider,
      label: input.label,
      senderId: input.senderId ?? null,
      senderName: input.senderName ?? null,
      username: input.username ?? null,
      apiKeyEnc: input.apiKeyEnc ?? null,
      createdAt: now(),
    })
    .returning();
  return firstOrThrow(rows, "createMaskingProfile");
}

export async function deleteMaskingProfile(db: Db, appId: number, id: number): Promise<boolean> {
  const result = await db
    .delete(maskingProfiles)
    .where(and(eq(maskingProfiles.appId, appId), eq(maskingProfiles.id, id)));
  return result.meta.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export async function createTemplate(db: Db, input: { appId: number; name: string; body: string }) {
  const ts = now();
  const rows = await db
    .insert(templates)
    .values({ appId: input.appId, name: input.name, body: input.body, createdAt: ts, updatedAt: ts })
    .returning();
  return firstOrThrow(rows, "createTemplate");
}

export async function updateTemplate(
  db: Db,
  appId: number,
  id: number,
  patch: { name?: string; body?: string },
) {
  const rows = await db
    .update(templates)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(templates.appId, appId), eq(templates.id, id)))
    .returning();
  return rows[0];
}

export async function deleteTemplate(db: Db, appId: number, id: number): Promise<boolean> {
  const result = await db.delete(templates).where(and(eq(templates.appId, appId), eq(templates.id, id)));
  return result.meta.changes > 0;
}

export async function getTemplate(db: Db, appId: number, id: number) {
  const rows = await db
    .select()
    .from(templates)
    .where(and(eq(templates.appId, appId), eq(templates.id, id)))
    .limit(1);
  return rows[0];
}

export async function listTemplates(db: Db, appId: number) {
  return db.select().from(templates).where(eq(templates.appId, appId)).orderBy(asc(templates.name));
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                 */
/* ------------------------------------------------------------------ */

export type NewJobInput = Omit<
  typeof jobs.$inferInsert,
  "createdAt" | "sent" | "failed" | "chunksDone" | "completedAt" | "enqueuedAt" | "error"
>;

export async function insertJob(db: Db, job: NewJobInput) {
  const rows = await db
    .insert(jobs)
    .values({ ...job, createdAt: now() })
    .returning();
  return firstOrThrow(rows, "insertJob");
}

/** Drizzle binds status/sent/failed defaults too: 5 params/row, 20 rows = 100. */
const JOB_CHUNK_INSERT_ROWS = 20;
const MAX_STATEMENTS_PER_BATCH = 20;

function jobChunkStatements(db: Db, jobId: string, chunkCount: number) {
  const indexes = Array.from({ length: chunkCount }, (_, i) => i);
  const rowGroups = chunkArray(indexes, JOB_CHUNK_INSERT_ROWS);
  return rowGroups.map((group) =>
    db.insert(jobChunks).values(group.map((chunkIndex) => ({ jobId, chunkIndex }))),
  );
}

export async function insertJobChunks(db: Db, jobId: string, chunkCount: number): Promise<void> {
  await runBatched(db, jobChunkStatements(db, jobId, chunkCount), MAX_STATEMENTS_PER_BATCH);
}

/** Record the job and ALL chunks together. A 50k-recipient job is 11 statements. */
export async function insertJobWithChunks(db: Db, job: NewJobInput): Promise<void> {
  await db.batch([
    db.insert(jobs).values({ ...job, createdAt: now() }),
    ...jobChunkStatements(db, job.id, job.chunkCount ?? 0),
  ]);
}

export async function pendingChunkIndexes(db: Db, jobId: string): Promise<number[]> {
  const rows = await db.select({ index: jobChunks.chunkIndex }).from(jobChunks)
    .where(and(eq(jobChunks.jobId, jobId), eq(jobChunks.status, "pending")))
    .orderBy(asc(jobChunks.chunkIndex));
  return rows.map((row) => row.index);
}

export async function markJobEnqueued(db: Db, jobId: string): Promise<void> {
  await db.update(jobs).set({ enqueuedAt: now() }).where(eq(jobs.id, jobId));
}

export async function jobsAwaitingEnqueue(db: Db, before: number, limit = 10) {
  return db.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.kind, "bulk"), isNull(jobs.enqueuedAt), isNull(jobs.completedAt), lt(jobs.createdAt, before)))
    .orderBy(asc(jobs.createdAt)).limit(limit);
}

export async function getJob(db: Db, id: string) {
  const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0];
}

export async function existingJobIds(db: Db, ids: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const slice of chunkArray(ids, 90)) {
    const rows = await db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, slice));
    for (const row of rows) existing.add(row.id);
  }
  return existing;
}

export async function getJobForApp(db: Db, appId: number, id: string) {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.appId, appId), eq(jobs.id, id)))
    .limit(1);
  return rows[0];
}

export async function listJobs(db: Db, opts: { appId?: number; limit: number; offset: number }) {
  const where = opts.appId !== undefined ? eq(jobs.appId, opts.appId) : undefined;
  return db
    .select()
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

/* ------------------------------------------------------------------ */
/* Chunk processing                                                     */
/* ------------------------------------------------------------------ */

/** Pre-send skip check: a redelivered chunk that is no longer 'pending' was
 *  already handled and must be acked without dispatching. */
export async function getJobChunk(db: Db, jobId: string, chunkIndex: number) {
  return db.query.jobChunks.findFirst({
    where: and(eq(jobChunks.jobId, jobId), eq(jobChunks.chunkIndex, chunkIndex)),
  });
}

/**
 * At-least-once idempotency gate + counter rollup in ONE atomic db.batch
 * (D1 batches commit or roll back as a unit), called AFTER a successful
 * dispatch — claiming first would turn a crash mid-send into silent message
 * loss, and ADR 0002 prefers duplicates over loss.
 *
 * Statement 1 flips this chunk 'pending' → 'done' with its counts; statement
 * 2 recomputes the parent job's sent/failed/chunksDone as AGGREGATES over
 * job_chunks (not increments), so the rollup is idempotent and can never
 * leave a job stranded short of its terminal status: either both statements
 * commit, or neither did and queue redelivery re-runs the whole thing. When
 * every chunk is out of 'pending', status flips to 'completed' /
 * 'completed_with_errors' and completedAt is stamped.
 *
 * Returns false when a concurrent/redelivered handling already finished the
 * chunk — the caller skips history writes (the winner wrote them); the
 * harmless aggregate recompute in statement 2 still ran.
 */
export async function completeChunk(
  db: Db,
  input: { jobId: string; chunkIndex: number; sent: number; failed: number },
): Promise<boolean> {
  const ts = now();
  const doneCount = sql`(SELECT COUNT(*) FROM ${jobChunks} WHERE ${jobChunks.jobId} = ${input.jobId} AND ${jobChunks.status} != 'pending')`;
  const sentSum = sql`(SELECT COALESCE(SUM(${jobChunks.sent}), 0) FROM ${jobChunks} WHERE ${jobChunks.jobId} = ${input.jobId})`;
  const failedSum = sql`(SELECT COALESCE(SUM(${jobChunks.failed}), 0) FROM ${jobChunks} WHERE ${jobChunks.jobId} = ${input.jobId})`;

  const [claim] = await db.batch([
    db
      .update(jobChunks)
      .set({ status: "done", sent: input.sent, failed: input.failed, completedAt: ts })
      .where(
        and(
          eq(jobChunks.jobId, input.jobId),
          eq(jobChunks.chunkIndex, input.chunkIndex),
          eq(jobChunks.status, "pending"),
        ),
      ),
    db
      .update(jobs)
      .set({
        sent: sentSum,
        failed: failedSum,
        chunksDone: doneCount,
        status: sql`CASE WHEN ${jobs.status} = 'failed' THEN 'failed' WHEN ${doneCount} >= ${jobs.chunkCount} THEN CASE WHEN ${failedSum} > 0 THEN 'completed_with_errors' ELSE 'completed' END ELSE ${jobs.status} END`,
        completedAt: sql`CASE WHEN ${jobs.completedAt} IS NOT NULL THEN ${jobs.completedAt} WHEN ${doneCount} >= ${jobs.chunkCount} THEN ${ts} ELSE NULL END`,
      })
      .where(eq(jobs.id, input.jobId)),
  ]);
  return claim.meta.changes > 0;
}

export async function markJobFailed(db: Db, jobId: string, error: string): Promise<void> {
  await db.update(jobs).set({ status: "failed", error, completedAt: now() }).where(eq(jobs.id, jobId));
}

export async function markJobRunning(db: Db, jobId: string): Promise<void> {
  // Guarded on 'queued' so a late-redelivered chunk can never flip a job that
  // already finished back to 'running'.
  await db
    .update(jobs)
    .set({ status: "running" satisfies JobStatus })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued")));
}

/* ------------------------------------------------------------------ */
/* Messages                                                             */
/* ------------------------------------------------------------------ */

export type NewMessageRow = Omit<typeof messages.$inferInsert, "id" | "createdAt">;

export async function insertMessages(db: Db, rows: readonly NewMessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const ts = now();
  const stamped = rows.map((row) => ({ ...row, createdAt: ts }));
  const rowGroups = chunkArray(stamped, HISTORY_INSERT_ROWS);
  const statements = rowGroups.map((group) => db.insert(messages).values(group));
  await runBatched(db, statements, MAX_STATEMENTS_PER_BATCH);
}

/* ------------------------------------------------------------------ */
/* History                                                              */
/* ------------------------------------------------------------------ */

export async function listMessagesByJob(
  db: Db,
  jobId: string,
  opts: { limit: number; offset: number },
) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.jobId, jobId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

export async function listRecentMessages(
  db: Db,
  opts: { appId?: number; limit: number; offset: number },
) {
  const where = opts.appId !== undefined ? eq(messages.appId, opts.appId) : undefined;
  return db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

/* ------------------------------------------------------------------ */
/* Admins                                                               */
/* ------------------------------------------------------------------ */

export async function countAdmins(db: Db): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(admins);
  return rows[0]?.count ?? 0;
}

export async function getAdminByUsername(db: Db, username: string) {
  const rows = await db.select().from(admins).where(eq(admins.username, username)).limit(1);
  return rows[0];
}

export async function createAdmin(db: Db, input: { username: string; passwordHash: string }) {
  const ts = now();
  const rows = await db
    .insert(admins)
    .values({ username: input.username, passwordHash: input.passwordHash, createdAt: ts, updatedAt: ts })
    .returning();
  return firstOrThrow(rows, "createAdmin");
}

export async function updateAdminPassword(db: Db, id: number, passwordHash: string): Promise<boolean> {
  const result = await db
    .update(admins)
    .set({ passwordHash, updatedAt: now() })
    .where(eq(admins.id, id));
  return result.meta.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Retention                                                            */
/* ------------------------------------------------------------------ */

/**
 * Nightly purge (ADR: RETENTION_DAYS). Deletes messages older than the
 * cutoff, then jobChunks/jobs older than the cutoff — jobs only when
 * terminal (completedAt is set, covering completed/completed_with_errors/
 * failed) and completedAt predates the cutoff.
 */
export async function purgeOlderThan(
  db: Db,
  days: number,
  cleanupPayloads?: (jobIds: string[]) => Promise<void>,
): Promise<{ messages: number; jobChunks: number; jobs: number }> {
  const cutoff = now() - days * 86400;

  const messagesResult = await db.delete(messages).where(lt(messages.createdAt, cutoff));

  // Capped per run so id lists never breach D1's 100-bound-param cap and the
  // whole purge stays inside one invocation's query budget; the nightly cron
  // catches up across runs.
  const staleJobs = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(isNotNull(jobs.completedAt), lt(jobs.completedAt, cutoff)))
    .limit(400);
  const staleJobIds = staleJobs.map((row) => row.id);

  let jobChunksDeleted = 0;
  let jobsDeleted = 0;
  for (const idSlice of chunkArray(staleJobIds, 90)) {
    // Clean R2 while D1 still retains the keys. A failure leaves the rows
    // discoverable for the next retention run.
    await cleanupPayloads?.(idSlice);
    const [chunksResult, jobsResult] = await db.batch([
      db.delete(jobChunks).where(inArray(jobChunks.jobId, idSlice)),
      db.delete(jobs).where(inArray(jobs.id, idSlice)),
    ]);
    jobChunksDeleted += chunksResult.meta.changes;
    jobsDeleted += jobsResult.meta.changes;
  }

  return {
    messages: messagesResult.meta.changes,
    jobChunks: jobChunksDeleted,
    jobs: jobsDeleted,
  };
}
