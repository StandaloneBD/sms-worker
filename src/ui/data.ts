/**
 * Small read helpers the admin UI needs that db/queries.ts doesn't already
 * expose. These query the schema tables directly through the same `Db`
 * handle every other query helper takes — src/db itself is untouched.
 */

import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/queries";
import { getGlobalProviders, listApps } from "../db/queries";
import { admins, appProviders, jobs, messages } from "../db/schema";
import { PROVIDER_NAMES } from "../shared/types";
import type { ProviderName } from "../shared/types";

const DAY_SECONDS = 86400;

/** appId -> app name, for decorating job/message rows with a readable label. */
export async function appNameMap(db: Db): Promise<Map<number, string>> {
  const apps = await listApps(db);
  return new Map(apps.map((a) => [a.id, a.name]));
}

/** Admin row by id. db/queries only exposes lookup by username; the settings
 *  page (change own password) needs the current admin's row by session id. */
export async function getAdminById(db: Db, id: number) {
  const rows = await db.select().from(admins).where(eq(admins.id, id)).limit(1);
  return rows[0];
}

export interface AppProviderRow {
  provider: ProviderName;
  enabled: boolean;
  priority: number;
  /** False when the admin disabled the provider globally — a kill switch
   *  that overrides `enabled` here (see getAppProviderPlan). */
  globallyEnabled: boolean;
  /** True while the App has no plan of its own and so follows the global
   *  order; saving the form creates its plan. Same for every row. */
  inherited: boolean;
}

/**
 * One row per known provider for a given app, merging any app-level override
 * with the global default so a provider with no override yet still shows an
 * editable starting value. getAppProviderPlan (db/queries) isn't enough here
 * — it only returns the already-resolved, enabled-only dispatch order, not
 * the raw (possibly disabled) override rows the edit form needs.
 */
export async function getAppProviderRows(db: Db, appId: number): Promise<AppProviderRow[]> {
  const [overrides, globals] = await Promise.all([
    db
      .select({
        provider: appProviders.provider,
        enabled: appProviders.enabled,
        priority: appProviders.priority,
      })
      .from(appProviders)
      .where(eq(appProviders.appId, appId))
      .orderBy(asc(appProviders.provider)),
    getGlobalProviders(db),
  ]);

  const overrideMap = new Map(overrides.map((o) => [o.provider, o]));
  const globalMap = new Map(globals.map((g) => [g.provider, g]));

  return PROVIDER_NAMES.map((provider) => {
    const global = globalMap.get(provider);
    const globallyEnabled = global?.enabled ?? false;
    const override = overrideMap.get(provider);
    if (override) return { ...override, globallyEnabled, inherited: false };
    // An App with any override rows uses those exclusively, so a provider
    // without a row isn't in its plan.
    return {
      provider,
      enabled: overrides.length === 0 && globallyEnabled,
      priority: global?.priority ?? 100,
      globallyEnabled,
      inherited: overrides.length === 0,
    };
  });
}

/** Days of history the volume charts plot, today (UTC, partial) last. */
export const CHART_DAYS = 14;

/** Sent / failed recipient counts per day, oldest first; aligned with `DailyVolume.days`. */
export interface DailySeries {
  sent: number[];
  failed: number[];
}

export interface DailyVolume {
  /** Unix day numbers (seconds / 86400, UTC), oldest first. */
  days: number[];
  total: DailySeries;
  byApp: Map<number, DailySeries>;
}

function emptySeries(length: number): DailySeries {
  return { sent: new Array<number>(length).fill(0), failed: new Array<number>(length).fill(0) };
}

/**
 * Per-day delivery volume over the last `days` UTC days, overall and per App.
 * Summed from the jobs rollup (one row per Send or Job) rather than counted
 * from messages (one row per recipient), so a chart reads a row per request,
 * not per recipient. A Job's recipients count toward the day it was accepted.
 */
export async function dailyVolume(db: Db, opts: { appId?: number; days?: number } = {}): Promise<DailyVolume> {
  const length = opts.days ?? CHART_DAYS;
  const today = Math.floor(Date.now() / 1000 / DAY_SECONDS);
  const first = today - length + 1;
  const days = Array.from({ length }, (_, i) => first + i);

  // Integer columns, so SQLite divides integrally: the UTC day number.
  const day = sql<number>`${jobs.createdAt} / 86400`;
  const since = gte(jobs.createdAt, first * DAY_SECONDS);
  const rows = await db
    .select({
      appId: jobs.appId,
      day,
      sent: sql<number>`sum(${jobs.sent})`,
      failed: sql<number>`sum(${jobs.failed})`,
    })
    .from(jobs)
    .where(opts.appId !== undefined ? and(eq(jobs.appId, opts.appId), since) : since)
    // Day first: grouping by app_id first lets SQLite walk all of
    // jobs_app_created_idx (every job ever kept) to skip the group sort,
    // instead of seeking the date range on jobs_created_idx.
    .groupBy(day, jobs.appId);

  const total = emptySeries(length);
  const byApp = new Map<number, DailySeries>();
  for (const row of rows) {
    const i = row.day - first;
    if (i < 0 || i >= length) continue;
    let series = byApp.get(row.appId);
    if (!series) byApp.set(row.appId, (series = emptySeries(length)));
    series.sent[i]! += row.sent;
    series.failed[i]! += row.failed;
    total.sent[i]! += row.sent;
    total.failed[i]! += row.failed;
  }
  return { days, total, byApp };
}

export interface InFlight {
  running: number;
  queued: number;
}

export interface DeliveryStats {
  sent24h: number;
  failed24h: number;
  inFlight: InFlight;
  inFlightByApp: Map<number, InFlight>;
}

/**
 * Stat tiles, overall or for one App: recipients sent and failed by the
 * Sends and Jobs accepted in the last 24h (the jobs rollup, one row per
 * request, like dailyVolume), and queued/running jobs per App from the
 * partial jobs_unfinished_idx, which holds only those.
 */
export async function deliveryStats(db: Db, appId?: number): Promise<DeliveryStats> {
  const since = Math.floor(Date.now() / 1000) - DAY_SECONDS;
  const recent = gte(jobs.createdAt, since);
  // Literal, not bound: SQLite only uses a partial index whose predicate the
  // query states outright.
  const unfinished = sql`${jobs.status} IN ('queued', 'running')`;

  const [totals, jobCounts] = await Promise.all([
    db
      .select({ sent: sql<number>`coalesce(sum(${jobs.sent}), 0)`, failed: sql<number>`coalesce(sum(${jobs.failed}), 0)` })
      .from(jobs)
      .where(appId !== undefined ? and(eq(jobs.appId, appId), recent) : recent),
    db
      .select({ appId: jobs.appId, status: jobs.status, count: sql<number>`count(*)` })
      .from(jobs)
      .where(appId !== undefined ? and(eq(jobs.appId, appId), unfinished) : unfinished)
      .groupBy(jobs.appId, jobs.status),
  ]);

  const inFlight: InFlight = { running: 0, queued: 0 };
  const inFlightByApp = new Map<number, InFlight>();
  for (const row of jobCounts) {
    let entry = inFlightByApp.get(row.appId);
    if (!entry) inFlightByApp.set(row.appId, (entry = { running: 0, queued: 0 }));
    const key = row.status === "running" ? "running" : "queued";
    entry[key] += row.count;
    inFlight[key] += row.count;
  }

  return {
    sent24h: totals[0]?.sent ?? 0,
    failed24h: totals[0]?.failed ?? 0,
    inFlight,
    inFlightByApp,
  };
}

export interface ProviderShare {
  /** null when no provider was tried (e.g. none enabled for the App). */
  provider: string | null;
  sent: number;
  failed: number;
}

export interface FailureReason {
  reason: string | null;
  count: number;
}

export interface AppBreakdown {
  providers: ProviderShare[];
  reasons: FailureReason[];
}

/** Over an App's last `days` of messages: which providers carried them
 *  (every message in the messages_app_created_idx range — the one per-view
 *  read that grows with volume), and the most common reasons recipients
 *  failed (failures only, from the partial messages_app_failed_idx). */
export async function appBreakdown(db: Db, appId: number, days: number): Promise<AppBreakdown> {
  const since = Math.floor(Date.now() / 1000) - days * DAY_SECONDS;
  const scope = and(eq(messages.appId, appId), gte(messages.createdAt, since));
  const count = sql<number>`count(*)`;

  const [providerRows, reasonRows] = await Promise.all([
    db
      .select({ provider: messages.provider, status: messages.status, count })
      .from(messages)
      .where(scope)
      .groupBy(messages.provider, messages.status),
    db
      .select({ reason: messages.reason, count })
      .from(messages)
      .where(and(scope, sql`${messages.status} = 'failed'`))
      .groupBy(messages.reason)
      .orderBy(desc(count))
      .limit(5),
  ]);

  const byProvider = new Map<string | null, ProviderShare>();
  for (const row of providerRows) {
    let share = byProvider.get(row.provider);
    if (!share) byProvider.set(row.provider, (share = { provider: row.provider, sent: 0, failed: 0 }));
    share[row.status] += row.count;
  }

  return {
    providers: [...byProvider.values()].sort((a, b) => b.sent + b.failed - (a.sent + a.failed)),
    reasons: reasonRows,
  };
}

export interface GlobalProviderRow {
  provider: ProviderName;
  enabled: boolean;
  priority: number;
  senderId: string | null;
  username: string | null;
  senderName: string | null;
  hasApiKey: boolean;
  updatedAt: number | null;
}

/**
 * One row per known provider, defaulting anything missing from
 * provider_settings (e.g. a fresh install before either row has been saved)
 * so the global settings form always has both providers to edit. The raw
 * apiKeyEnc ciphertext never leaves this function — only a boolean presence
 * flag reaches the view layer.
 */
export async function getGlobalProviderRows(db: Db): Promise<GlobalProviderRow[]> {
  const rows = await getGlobalProviders(db);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return PROVIDER_NAMES.map((provider, index) => {
    const existing = byProvider.get(provider);
    if (existing) {
      return {
        provider: existing.provider,
        enabled: existing.enabled,
        priority: existing.priority,
        senderId: existing.senderId,
        username: existing.username,
        senderName: existing.senderName,
        hasApiKey: existing.apiKeyEnc !== null,
        updatedAt: existing.updatedAt,
      };
    }
    return {
      provider,
      enabled: false,
      priority: (index + 1) * 10,
      senderId: null,
      username: null,
      senderName: null,
      hasApiKey: false,
      updatedAt: null,
    };
  });
}
