/** GET / — delivery across every App, and each App's share of it. Jobs and
 *  messages live under their App (see ./app-overview, ./jobs, ./messages). */

import type { Context } from "hono";
import { getDb } from "../../db";
import { listApps } from "../../db/queries";
import type { AppEnv } from "../../shared/types";
import { failureRate, formatRate, Spark, StatTile, VolumeChart } from "../charts";
import { Empty, PageHeader, Panel } from "../components";
import { CHART_DAYS, dailyVolume, deliveryStats } from "../data";
import type { DailySeries } from "../data";
import { readFlash } from "../flash";
import { Layout } from "../layout";
import { adminPath, appPath } from "../paths";
import { formatNum } from "../util";

/** The apps table totals the most recent week of the chart's days. */
const WEEK = 7;

const lastWeek = (values: number[]) => values.slice(-WEEK).reduce((a, b) => a + b, 0);

export async function dashboardGet(c: Context<AppEnv>): Promise<Response> {
  const db = getDb(c.env);
  const [apps, stats, volume] = await Promise.all([listApps(db), deliveryStats(db), dailyVolume(db)]);
  const flash = readFlash(c);

  const totalToday = stats.sent24h + stats.failed24h;
  const activeApps = apps.filter((app) => app.isActive).length;
  const none: DailySeries = { sent: volume.days.map(() => 0), failed: volume.days.map(() => 0) };

  const rows = apps
    .map((app) => {
      const series = volume.byApp.get(app.id) ?? none;
      return {
        app,
        series,
        sent: lastWeek(series.sent),
        failed: lastWeek(series.failed),
        inFlight: stats.inFlightByApp.get(app.id) ?? { running: 0, queued: 0 },
      };
    })
    // Busiest first; idle apps keep their alphabetical order (listApps).
    .sort((a, b) => b.sent + b.failed - (a.sent + a.failed));

  return c.html(
    <Layout title="Overview" active="dashboard" flash={flash}>
      <PageHeader title="Overview" sub="Delivery across every app. Days are UTC." />

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
          sub={totalToday > 0 ? `${formatRate(failureRate(stats.sent24h, stats.failed24h))} of recipients` : "No recipients yet"}
        />
        <StatTile
          label="Jobs in progress"
          value={formatNum(stats.inFlight.running + stats.inFlight.queued)}
          sub={`${formatNum(stats.inFlight.running)} running, ${formatNum(stats.inFlight.queued)} queued`}
        />
        <StatTile label="Active apps" value={formatNum(activeApps)} sub={`of ${formatNum(apps.length)} registered`} />
      </div>

      <Panel title={`Recipients per day, last ${CHART_DAYS} days`}>
        <VolumeChart days={volume.days} series={volume.total} caption="Recipients per day across every app" />
      </Panel>

      <Panel
        title="Apps"
        flush
        actions={
          <a class="btn btn-quiet btn-sm" href={adminPath("/apps")}>
            Manage apps
          </a>
        }
      >
        {rows.length === 0 ? (
          <Empty title="No apps yet. Register one to get an API key." />
        ) : (
          <div class="table-wrap">
            <table class="data app-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Last {CHART_DAYS} days</th>
                  <th class="num">Sent, 7 days</th>
                  <th class="num">Failed, 7 days</th>
                  <th class="num">Failure rate</th>
                  <th class="num">Jobs in progress</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ app, series, sent, failed, inFlight }) => (
                  <tr>
                    <td>
                      <a class="app-link" href={appPath(app.id)}>
                        {app.name}
                      </a>
                      {app.isActive ? null : <span class="badge badge-off badge-inline">Inactive</span>}
                    </td>
                    <td>
                      <Spark days={volume.days} series={series} label={`${app.name}, recipients per day`} />
                    </td>
                    <td class="num">{formatNum(sent)}</td>
                    <td class="num">{formatNum(failed)}</td>
                    <td class="num">{formatRate(failureRate(sent, failed))}</td>
                    <td class="num">
                      {inFlight.running + inFlight.queued === 0 ? (
                        <span class="muted">—</span>
                      ) : (
                        formatNum(inFlight.running + inFlight.queued)
                      )}
                    </td>
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
