/** GET /apps/:id — one App's delivery: today against its quota, its daily
 *  volume, which providers carried it, why recipients failed, latest jobs. */

import type { Context } from "hono";
import { getDb } from "../../db";
import { getAppById, getAppUsage, listJobs } from "../../db/queries";
import { usageDay } from "../../shared/constants";
import type { AppEnv } from "../../shared/types";
import { failureRate, formatRate, ShareBars, StatTile, VolumeChart } from "../charts";
import { AppHeader, ChunkProgress, Empty, NotFoundPage, Panel, Status } from "../components";
import { appBreakdown, CHART_DAYS, dailyVolume, deliveryStats } from "../data";
import { readFlash } from "../flash";
import { Layout } from "../layout";
import { appPath, jobPath } from "../paths";
import { PROVIDER_LABELS } from "../provider-order";
import type { ProviderName } from "../../shared/types";
import { formatNum, formatTs, parseId, shortId } from "../util";

const BREAKDOWN_DAYS = 7;
const RECENT_JOBS_LIMIT = 5;

function providerLabel(provider: string | null): string {
  if (provider === null) return "No provider";
  return PROVIDER_LABELS[provider as ProviderName] ?? provider;
}

export async function appOverviewGet(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  const db = getDb(c.env);
  const app = id === null ? undefined : await getAppById(db, id);
  if (!app) return c.html(<NotFoundPage flash={readFlash(c)} what="App" />, 404);

  const [stats, volume, breakdown, usedToday, jobs] = await Promise.all([
    deliveryStats(db, app.id),
    dailyVolume(db, { appId: app.id }),
    appBreakdown(db, app.id, BREAKDOWN_DAYS),
    getAppUsage(db, app.id, usageDay()),
    listJobs(db, { appId: app.id, limit: RECENT_JOBS_LIMIT, offset: 0 }),
  ]);
  const flash = readFlash(c);
  const series = volume.byApp.get(app.id) ?? volume.total;
  const quotaUse = app.dailyQuota === null ? null : Math.min(1, usedToday / app.dailyQuota);

  return c.html(
    <Layout title={app.name} active="apps" flash={flash}>
      <AppHeader app={app} tab="overview" />

      <div class="stat-row">
        <StatTile label="Sent, last 24h" value={formatNum(stats.sent24h)}>
          <div class="ratio">
            <span style={`flex:${stats.sent24h}`} />
            <span style={`flex:${stats.failed24h}`} />
          </div>
        </StatTile>
        <StatTile
          label="Failed, last 24h"
          value={formatNum(stats.failed24h)}
          sub={
            stats.sent24h + stats.failed24h > 0
              ? `${formatRate(failureRate(stats.sent24h, stats.failed24h))} of recipients`
              : "No recipients yet"
          }
        />
        <StatTile
          label="Recipients today"
          value={formatNum(usedToday)}
          sub={
            app.dailyQuota === null ? (
              <a href={`${appPath(app.id, "config")}#quota`}>No daily quota</a>
            ) : (
              `of ${formatNum(app.dailyQuota)} daily quota (UTC)`
            )
          }
        >
          {quotaUse === null ? null : (
            <div class={quotaUse >= 0.9 ? "meter is-high" : "meter"}>
              <span style={`width:${quotaUse * 100}%`} />
            </div>
          )}
        </StatTile>
        <StatTile
          label="Jobs in progress"
          value={formatNum(stats.inFlight.running + stats.inFlight.queued)}
          sub={`${formatNum(stats.inFlight.running)} running, ${formatNum(stats.inFlight.queued)} queued`}
        />
      </div>

      <Panel title={`Recipients per day, last ${CHART_DAYS} days`}>
        <VolumeChart days={volume.days} series={series} caption={`${app.name}: recipients per day`} />
      </Panel>

      <div class="panel-pair">
        <Panel title={`Providers, last ${BREAKDOWN_DAYS} days`}>
          {breakdown.providers.length === 0 ? (
            <p class="muted panel-note">Nothing sent in the last {BREAKDOWN_DAYS} days.</p>
          ) : (
            <ShareBars
              rows={breakdown.providers.map((share) => ({
                label: providerLabel(share.provider),
                sent: share.sent,
                failed: share.failed,
              }))}
            />
          )}
        </Panel>

        <Panel
          title={`Why recipients failed, last ${BREAKDOWN_DAYS} days`}
          actions={
            breakdown.reasons.length > 0 ? (
              <a class="btn btn-quiet btn-sm" href={`${appPath(app.id, "messages")}?status=failed`}>
                Failed messages
              </a>
            ) : undefined
          }
        >
          {breakdown.reasons.length === 0 ? (
            <p class="muted panel-note">No failures in the last {BREAKDOWN_DAYS} days.</p>
          ) : (
            <ol class="reasons">
              {breakdown.reasons.map((row) => (
                <li>
                  <span class="reasons-count num">{formatNum(row.count)}</span>
                  <span class="reasons-text">{row.reason ?? <span class="muted">No reason recorded</span>}</span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      <Panel
        title="Latest jobs"
        flush
        actions={
          jobs.length > 0 ? (
            <a class="btn btn-quiet btn-sm" href={appPath(app.id, "jobs")}>
              All jobs
            </a>
          ) : undefined
        }
      >
        {jobs.length === 0 ? (
          <Empty title="No jobs yet. They appear here once this app sends." hint="POST /v1/sms/send or /v1/sms/jobs" />
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th class="num">Sent</th>
                  <th class="num">Failed</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr>
                    <td>
                      <a class="mono row-link" href={jobPath(app.id, job.id)} title={job.id}>
                        {shortId(job.id)}…
                      </a>
                    </td>
                    <td>{job.kind}</td>
                    <td>
                      <Status value={job.status} />
                    </td>
                    <td>
                      <ChunkProgress done={job.chunksDone} total={job.chunkCount} />
                    </td>
                    <td class="num">{formatNum(job.sent)}</td>
                    <td class="num">{formatNum(job.failed)}</td>
                    <td class="mono">{formatTs(job.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Layout>,
  );
}
