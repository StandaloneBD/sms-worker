/**
 * Typed query helpers. Every function takes the drizzle db instance
 * returned by `getDb(env)` as its first argument (see ./index.ts).
 *
 * Batched inserts respect D1's 100-bound-params-per-statement hard limit —
 * see HISTORY_INSERT_ROWS in shared/constants and the local per-row-width
 * constants below.
 */

import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { HISTORY_INSERT_ROWS } from "../shared/constants";
import type { JobStatus, ProviderName } from "../shared/types";
import {
  admins,
  appProviders,
  appUsage,
  apps,
  idempotencyKeys,
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
    // must not turn an unrelated D1 error into an apparent name conflict.
    if (/^(?:D1_ERROR:s*)?UNIQUE constraint failed:/i.test(e.message)) return true;
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

/** Saves every provider row in one batch, so a failure can't half-apply. */
export async function upsertGlobalProviders(db: Db, inputs: GlobalProviderInput[]): Promise<void> {
  const [first, ...rest] = inputs.map((input) => globalProviderStatement(db, input));
  if (first) await db.batch([first, ...rest]);
}

/**
 * Per-App dispatch plan: enabled providers in priority order. An App with
 * any appProviders rows uses those exclusively (filtered to enabled,
 * ordered by priority); an App with none inherits the global
 * providerSettings defaults.
 *
 * The global `enabled` flag is a kill switch either way: a provider the
 * admin disabled globally is never in any App's plan, whatever the App's
 * own rows say.
 */
export async function getAppProviderPlan(
  db: Db,
  appId: number,
): Promise<{ provider: ProviderName; priority: number }[]> {
  const [overrides, globals] = await Promise.all([
    db
      .select({ provider: appProviders.provider, priority: appProviders.priority, enabled: appProviders.enabled })
      .from(appProviders)
      .where(eq(appProviders.appId, appId)),
    db
      .select({ provider: providerSettings.provider, priority: providerSettings.priority, enabled: providerSettings.enabled })
      .from(providerSettings)
      .orderBy(asc(providerSettings.priority)),
  ]);

  const globallyEnabled = new Set(globals.filter((row) => row.enabled).map((row) => row.provider));
  const rows = overrides.length > 0 ? [...overrides].sort((a, b) => a.priority - b.priority) : globals;
  return rows
    .filter((row) => row.enabled && globallyEnabled.has(row.provider))
    .map((row) => ({ provider: row.provider, priority: row.priority }));
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

/** Saves an App's whole provider plan in one batch. */
export async function upsertAppProviders(
  db: Db,
  inputs: { appId: number; provider: ProviderName; enabled: boolean; priority: number }[],
): Promise<void> {
  const [first, ...rest] = inputs.map((input) =>
    db
      .insert(appProviders)
      .values(input)
      .onConflictDoUpdate({
        target: [appProviders.appId, appProviders.provider],
        set: { enabled: input.enabled, priority: input.priority },
      }),
  );
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
  "createdAt" | "sent" | "failed" | "chunksDone" | "completedAt" | "error"
>;

const MAX_STATEMENTS_PER_BATCH = 20;

/** One chunk's row data at Job creation: its recipient count and the byte
 *  range of its line in the R2 payload. */
export interface NewChunk {
  total: number;
  offset: number;
  length: number;
}

/**
 * Inserts a bulk Job row and all its chunk rows atomically (one db.batch),
 * so a failure can't leave a 'queued' Job without chunks that nothing would
 * ever finish. The chunk rows go in as ONE statement expanding a JSON array
 * server-side with json_each: a multi-row VALUES insert would hit D1's
 * 100-bound-parameter cap within a handful of rows, because drizzle binds
 * every column default as a parameter too.
 */
export async function insertBulkJob(db: Db, job: NewJobInput, chunks: readonly NewChunk[]): Promise<void> {
  const ts = now();
  const rows = JSON.stringify(chunks.map((chunk) => [chunk.total, chunk.offset, chunk.length]));
  await db.batch([
    db.insert(jobs).values({ ...job, chunkCount: chunks.length, createdAt: ts }),
    // INSERT ... SELECT lists every job_chunks column in schema order, so
    // the SELECT yields them in that order too: job_id, chunk_index, status,
    // sent, failed, completed_at, total, round, retry_indexes,
    // payload_offset, payload_length, claim_token, updated_at, requeues.
    db.insert(jobChunks).select(sql`
      SELECT ${job.id}, CAST(key AS INTEGER), 'pending', 0, 0, NULL,
             json_extract(value, '$[0]'), 0, NULL,
             json_extract(value, '$[1]'), json_extract(value, '$[2]'), NULL, ${ts}, 0
      FROM json_each(${rows})
    `),
  ]);
}

/** Marks a Job's pending chunks in [from, to] (to defaults to the last chunk)
 *  as long idle, so the next reaper run enqueues them — used when
 *  enqueueing them failed. */
export async function markChunksStale(
  db: Db,
  jobId: string,
  range: { from: number; to?: number },
): Promise<void> {
  await db
    .update(jobChunks)
    .set({ updatedAt: 0 })
    .where(
      and(
        eq(jobChunks.jobId, jobId),
        gte(jobChunks.chunkIndex, range.from),
        range.to === undefined ? undefined : lte(jobChunks.chunkIndex, range.to),
        eq(jobChunks.status, "pending"),
      ),
    );
}

export async function getJob(db: Db, id: string) {
  const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0];
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
 * Settles one send round of a chunk: the at-least-once idempotency gate and
 * the job counter rollup in ONE atomic db.batch (D1 batches commit or roll
 * back as a unit), called AFTER the round's dispatch — claiming first would
 * turn a crash mid-send into silent message loss, and ADR 0002 prefers
 * duplicates over loss.
 *
 * Statement 1 claims the chunk, matching only while it is still 'pending' in
 * `round`: it adds this round's settled counts and either finishes the chunk
 * ('done') or, when `retryIndexes` is non-empty, advances it to the next
 * round with those recipients still to send. It stamps a fresh claim token.
 * Statement 2 increments the parent job's counters, guarded on that token so
 * it applies exactly when statement 1 matched, and moves its status
 * (queued → running, or to its terminal status when this was the last chunk
 * to finish). Increments, not aggregates recomputed over every chunk: each
 * call touches O(1) rows however many chunks the job has.
 *
 * `claimed` is false when a concurrent/redelivered handling already settled
 * this round — the caller then skips history writes (the winner wrote them).
 * `jobFinished` is true when this call moved the job to a terminal status.
 */
export async function settleChunkRound(
  db: Db,
  input: {
    jobId: string;
    chunkIndex: number;
    round: number;
    sent: number;
    failed: number;
    retryIndexes: readonly number[];
  },
): Promise<{ claimed: boolean; jobFinished: boolean }> {
  const ts = now();
  const token = crypto.randomUUID();
  const finishing = input.retryIndexes.length === 0;
  const chunkDone = finishing ? 1 : 0;
  const lastChunk = sql`${jobs.chunksDone} + ${chunkDone} >= ${jobs.chunkCount}`;

  const [claim, rollup] = await db.batch([
    db
      .update(jobChunks)
      .set({
        status: finishing ? "done" : "pending",
        round: input.round + 1,
        retryIndexes: finishing ? null : JSON.stringify(input.retryIndexes),
        sent: sql`${jobChunks.sent} + ${input.sent}`,
        failed: sql`${jobChunks.failed} + ${input.failed}`,
        completedAt: finishing ? ts : null,
        claimToken: token,
        updatedAt: ts,
      })
      .where(
        and(
          eq(jobChunks.jobId, input.jobId),
          eq(jobChunks.chunkIndex, input.chunkIndex),
          eq(jobChunks.status, "pending"),
          eq(jobChunks.round, input.round),
        ),
      ),
    db
      .update(jobs)
      .set({
        sent: sql`${jobs.sent} + ${input.sent}`,
        failed: sql`${jobs.failed} + ${input.failed}`,
        chunksDone: sql`${jobs.chunksDone} + ${chunkDone}`,
        status: sql`CASE WHEN ${lastChunk} THEN (CASE WHEN ${jobs.failed} + ${input.failed} > 0 THEN 'completed_with_errors' ELSE 'completed' END) WHEN ${jobs.status} = 'queued' THEN 'running' ELSE ${jobs.status} END`,
        completedAt: sql`CASE WHEN ${lastChunk} THEN ${ts} ELSE ${jobs.completedAt} END`,
      })
      .where(
        and(
          eq(jobs.id, input.jobId),
          sql`EXISTS (SELECT 1 FROM ${jobChunks} WHERE ${jobChunks.jobId} = ${input.jobId} AND ${jobChunks.chunkIndex} = ${input.chunkIndex} AND ${jobChunks.claimToken} = ${token})`,
        ),
      )
      .returning({ status: jobs.status }),
  ]);

  const claimed = claim.meta.changes > 0;
  const status: JobStatus | undefined = rollup[0]?.status;
  return {
    claimed,
    jobFinished: claimed && finishing && (status === "completed" || status === "completed_with_errors"),
  };
}

/**
 * Reaper: claims up to `limit` pending chunks idle since before
 * `staleBefore` that still have re-enqueues left — bumping their requeue
 * count and progress stamp in the same statement, so two overlapping cron
 * runs can't both pick a chunk — and returns them for re-enqueueing.
 */
export async function claimStaleChunks(
  db: Db,
  opts: { staleBefore: number; maxRequeues: number; limit: number },
) {
  return db
    .update(jobChunks)
    .set({ requeues: sql`${jobChunks.requeues} + 1`, updatedAt: now() })
    .where(
      sql`rowid IN (SELECT rowid FROM ${jobChunks} WHERE ${jobChunks.status} = 'pending' AND ${jobChunks.updatedAt} < ${opts.staleBefore} AND ${jobChunks.requeues} < ${opts.maxRequeues} ORDER BY ${jobChunks.updatedAt} LIMIT ${opts.limit})`,
    )
    .returning({ jobId: jobChunks.jobId, chunkIndex: jobChunks.chunkIndex, round: jobChunks.round });
}

/** Reaper: pending chunks idle since before `staleBefore` that have used up
 *  their re-enqueues — to be force-finished. */
export async function listAbandonedChunks(
  db: Db,
  opts: { staleBefore: number; maxRequeues: number; limit: number },
) {
  return db
    .select({ jobId: jobChunks.jobId, chunkIndex: jobChunks.chunkIndex })
    .from(jobChunks)
    .where(
      and(
        eq(jobChunks.status, "pending"),
        lt(jobChunks.updatedAt, opts.staleBefore),
        gte(jobChunks.requeues, opts.maxRequeues),
      ),
    )
    .limit(opts.limit);
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

/** Newest first by id, which within a Job tracks insert time: that order
 *  comes straight off messages_job_idx (its trailing rowid), so a page reads
 *  offset + limit rows rather than sorting every message in the Job.
 *
 *  `before` (a message id) is the keyset cursor: the page starts just below
 *  it on the same index, so any page reads only `limit` rows however deep it
 *  is. When it is given, `offset` is ignored. */
export async function listMessagesByJob(
  db: Db,
  jobId: string,
  opts: { limit: number; offset?: number; before?: number },
) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.jobId, jobId), opts.before === undefined ? undefined : lt(messages.id, opts.before)))
    .orderBy(desc(messages.id))
    .limit(opts.limit)
    .offset(opts.before === undefined ? (opts.offset ?? 0) : 0);
}

/**
 * Each row also carries its job's body: a plain request-level message is
 * stored once on the job, not repeated on every message row, so
 * `body ?? jobBody` is the text that went out. `templateName` is the
 * template's current name, null once it has been deleted.
 *
 * Always scoped to one App: messages_app_created_idx serves the order, and
 * `failedOnly` reads messages_app_failed_idx instead — its predicate is a
 * literal because SQLite only uses a partial index when the query states it.
 */
export async function listRecentMessages(
  db: Db,
  opts: { appId: number; failedOnly?: boolean; limit: number; offset: number },
) {
  const where = and(eq(messages.appId, opts.appId), opts.failedOnly ? sql`${messages.status} = 'failed'` : undefined);
  return db
    .select({
      ...getTableColumns(messages),
      jobBody: jobs.body,
      templateId: jobs.templateId,
      templateName: templates.name,
    })
    .from(messages)
    .leftJoin(jobs, eq(jobs.id, messages.jobId))
    .leftJoin(templates, and(eq(templates.id, jobs.templateId), eq(templates.appId, messages.appId)))
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

/** Sets a new password and bumps the session version, which signs out every
 *  existing session. Returns the new version, or undefined for no such admin. */
export async function updateAdminPassword(db: Db, id: number, passwordHash: string): Promise<number | undefined> {
  const rows = await db
    .update(admins)
    .set({ passwordHash, sessionVersion: sql`${admins.sessionVersion} + 1`, updatedAt: now() })
    .where(eq(admins.id, id))
    .returning({ sessionVersion: admins.sessionVersion });
  return rows[0]?.sessionVersion;
}

/* ------------------------------------------------------------------ */
/* Idempotency keys                                                     */
/* ------------------------------------------------------------------ */

/**
 * Claims `key` for a request. Succeeds for a new key, and takes over an
 * existing one when it has expired (created before `expiredBefore`) or when
 * the same request claimed it but never finished (locked before
 * `lockExpiredBefore`, e.g. a crashed isolate). False means another request
 * holds it — the caller reads the row to replay, reject, or report it busy.
 */
export async function claimIdempotencyKey(
  db: Db,
  input: { appId: number; key: string; requestHash: string; expiredBefore: number; lockExpiredBefore: number },
): Promise<boolean> {
  const ts = now();
  const result = await db
    .insert(idempotencyKeys)
    .values({ appId: input.appId, key: input.key, requestHash: input.requestHash, createdAt: ts, lockedAt: ts })
    .onConflictDoUpdate({
      target: [idempotencyKeys.appId, idempotencyKeys.key],
      set: { requestHash: input.requestHash, responseStatus: null, responseBody: null, createdAt: ts, lockedAt: ts },
      setWhere: sql`${idempotencyKeys.createdAt} < ${input.expiredBefore} OR (${idempotencyKeys.responseStatus} IS NULL AND ${idempotencyKeys.lockedAt} < ${input.lockExpiredBefore} AND ${idempotencyKeys.requestHash} = ${input.requestHash})`,
    });
  return result.meta.changes > 0;
}

export async function getIdempotencyKey(db: Db, appId: number, key: string) {
  const rows = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.appId, appId), eq(idempotencyKeys.key, key)))
    .limit(1);
  return rows[0];
}

export async function completeIdempotencyKey(
  db: Db,
  input: { appId: number; key: string; status: number; body: string },
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ responseStatus: input.status, responseBody: input.body })
    .where(and(eq(idempotencyKeys.appId, input.appId), eq(idempotencyKeys.key, input.key)));
}

/** Drops an unfinished claim so the client can retry the request. */
export async function releaseIdempotencyKey(db: Db, appId: number, key: string): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.appId, appId), eq(idempotencyKeys.key, key), isNull(idempotencyKeys.responseStatus)),
    );
}

/* ------------------------------------------------------------------ */
/* Daily quota                                                          */
/* ------------------------------------------------------------------ */

/**
 * Adds `count` recipients to the App's usage for `day` unless that would
 * take it past `quota` — atomically, so concurrent requests can't both slip
 * under. False means over quota; nothing was added.
 */
export async function consumeDailyQuota(
  db: Db,
  input: { appId: number; day: string; count: number; quota: number },
): Promise<boolean> {
  if (input.count > input.quota) return false;
  const result = await db
    .insert(appUsage)
    .values({ appId: input.appId, day: input.day, recipients: input.count })
    .onConflictDoUpdate({
      target: [appUsage.appId, appUsage.day],
      set: { recipients: sql`${appUsage.recipients} + ${input.count}` },
      setWhere: sql`${appUsage.recipients} + ${input.count} <= ${input.quota}`,
    });
  return result.meta.changes > 0;
}

export async function getAppUsage(db: Db, appId: number, day: string): Promise<number> {
  const rows = await db
    .select({ recipients: appUsage.recipients })
    .from(appUsage)
    .where(and(eq(appUsage.appId, appId), eq(appUsage.day, day)))
    .limit(1);
  return rows[0]?.recipients ?? 0;
}

export async function setAppDailyQuota(db: Db, id: number, quota: number | null): Promise<boolean> {
  const result = await db.update(apps).set({ dailyQuota: quota }).where(eq(apps.id, id));
  return result.meta.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Retention                                                            */
/* ------------------------------------------------------------------ */

/**
 * One cron run's slice of the retention purge (RETENTION_DAYS): finished
 * jobs created before the cutoff, oldest first, with their messages and
 * chunk rows. Messages are found through their job (messages_job_idx), so
 * no index on messages.created_at is paid for on every recipient insert.
 *
 * Each round is one batch (one transaction): up to `batchRows` messages of
 * the oldest purgeable jobs — picked by a LIMITed subquery, since D1's
 * SQLite has no DELETE ... LIMIT — then the chunks and rows of those jobs
 * left with no messages. A job with more messages than one round deletes
 * stays until a later round empties it, so no message outlives its job. At
 * most `maxBatches` rounds keep a run inside its query and duration budget.
 * Unfinished jobs are never purged; the reaper finishes stalled ones.
 */
export async function purgeOlderThan(
  db: Db,
  days: number,
  opts: { batchRows: number; maxBatches: number },
): Promise<{ messages: number; jobChunks: number; jobs: number }> {
  const cutoff = now() - days * 86400;

  let messagesDeleted = 0;
  let jobChunksDeleted = 0;
  let jobsDeleted = 0;
  for (let batch = 0; batch < opts.maxBatches; batch++) {
    // Deterministic, so every statement of the batch agrees on the set.
    const purgeable = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(lt(jobs.createdAt, cutoff), isNotNull(jobs.completedAt)))
      .orderBy(asc(jobs.createdAt), asc(jobs.id))
      .limit(opts.batchRows);
    const messageIds = db
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.jobId, purgeable))
      .limit(opts.batchRows);
    const [messagesResult, chunksResult, jobsResult] = await db.batch([
      db.delete(messages).where(inArray(messages.id, messageIds)),
      db
        .delete(jobChunks)
        .where(
          and(
            inArray(jobChunks.jobId, purgeable),
            sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.jobId} = ${jobChunks.jobId})`,
          ),
        ),
      db
        .delete(jobs)
        .where(
          and(inArray(jobs.id, purgeable), sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.jobId} = ${jobs.id})`),
        ),
    ]);
    messagesDeleted += messagesResult.meta.changes;
    jobChunksDeleted += chunksResult.meta.changes;
    jobsDeleted += jobsResult.meta.changes;
    if (messagesResult.meta.changes < opts.batchRows && jobsResult.meta.changes < opts.batchRows) break;
  }

  return { messages: messagesDeleted, jobChunks: jobChunksDeleted, jobs: jobsDeleted };
}

/** Idempotency keys past their replay window, and usage rows for days
 *  before `beforeDay` (YYYY-MM-DD). */
export async function purgeExpiredKeysAndUsage(
  db: Db,
  opts: { keysCreatedBefore: number; beforeDay: string; batchRows: number; maxBatches: number },
): Promise<{ idempotencyKeys: number; appUsage: number }> {
  let keysDeleted = 0;
  for (let batch = 0; batch < opts.maxBatches; batch++) {
    const result = await db.run(
      sql`DELETE FROM ${idempotencyKeys} WHERE rowid IN (SELECT rowid FROM ${idempotencyKeys} WHERE ${idempotencyKeys.createdAt} < ${opts.keysCreatedBefore} LIMIT ${opts.batchRows})`,
    );
    keysDeleted += result.meta.changes;
    if (result.meta.changes < opts.batchRows) break;
  }
  const usageResult = await db.delete(appUsage).where(lt(appUsage.day, opts.beforeDay));
  return { idempotencyKeys: keysDeleted, appUsage: usageResult.meta.changes };
}
