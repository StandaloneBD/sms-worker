/**
 * Server-rendered charts: plain HTML columns sized with inline styles, so
 * they need no client script (the admin CSP allows none inline) and stay
 * crisp at any width. Each column carries a title tooltip, and every chart
 * ships a screen-reader table of the same numbers.
 */

import type { Child } from "hono/jsx";
import type { DailySeries } from "./data";
import { formatNum } from "./util";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayDate(day: number): Date {
  return new Date(day * 86_400_000);
}

/** "Oct 7" for a unix day number (UTC). */
export function formatDay(day: number): string {
  const date = dayDate(day);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** 1,284 → "1.3K", 12,900,000 → "12.9M"; exact below 1,000. */
export function formatCompact(n: number): string {
  if (n < 1000) return formatNum(n);
  const [div, unit] = n >= 1_000_000 ? [1_000_000, "M"] : [1000, "K"];
  const value = n / div;
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
}

/** Smallest 1/2/5 × 10^k at or above `max`, so the axis ticks are round. */
function niceCeil(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude;
  }
  return 10 * magnitude;
}

export function failureRate(sent: number, failed: number): number | null {
  const total = sent + failed;
  return total === 0 ? null : failed / total;
}

export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  if (rate > 0 && rate < 0.001) return "<0.1%";
  return `${Math.round(rate * 1000) / 10}%`;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/* ------------------------------------------------------------------ */
/* Stacked day columns                                                 */
/* ------------------------------------------------------------------ */

function Column({ sent, failed, max, tip }: { sent: number; failed: number; max: number; tip: string }) {
  const total = sent + failed;
  return (
    <li class="vol-col" title={tip}>
      {total > 0 ? (
        <span class="vol-stack" style={`height:${(total / max) * 100}%`}>
          {failed > 0 ? <span class="vol-failed" style={`flex-grow:${failed}`} /> : null}
          {sent > 0 ? <span class="vol-sent" style={`flex-grow:${sent}`} /> : null}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Daily delivery volume: one column per day, failed stacked on sent, today
 * last. The legend doubles as the period's totals.
 */
export function VolumeChart({ days, series, caption }: { days: number[]; series: DailySeries; caption: string }) {
  const totals = days.map((_, i) => series.sent[i]! + series.failed[i]!);
  const max = niceCeil(Math.max(...totals));
  const sentTotal = sum(series.sent);
  const failedTotal = sum(series.failed);
  const lastIndex = days.length - 1;

  return (
    <figure class="vol">
      <figcaption class="vol-legend">
        <span class="vol-key">
          <i class="vol-swatch vol-sent" />
          Sent <strong class="num">{formatNum(sentTotal)}</strong>
        </span>
        <span class="vol-key">
          <i class="vol-swatch vol-failed" />
          Failed <strong class="num">{formatNum(failedTotal)}</strong>
        </span>
        <span class="vol-key muted">{formatRate(failureRate(sentTotal, failedTotal))} failure rate</span>
      </figcaption>

      <div class="vol-frame" aria-hidden="true">
        <div class="vol-axis">
          {[max, max / 2, 0].map((tick) => (
            <span>{formatCompact(tick)}</span>
          ))}
        </div>
        <div class="vol-plot">
          <ol class="vol-cols">
            {days.map((day, i) => (
              <Column
                sent={series.sent[i]!}
                failed={series.failed[i]!}
                max={max}
                tip={`${i === lastIndex ? "Today so far" : formatDay(day)}: ${formatNum(series.sent[i]!)} sent, ${formatNum(series.failed[i]!)} failed`}
              />
            ))}
          </ol>
          <ol class="vol-days">
            {days.map((day, i) => {
              const date = dayDate(day);
              const showMonth = i === 0 || date.getUTCDate() === 1;
              return (
                <li class={i === lastIndex ? "is-today" : undefined}>
                  {i === lastIndex ? "Today" : showMonth ? formatDay(day) : String(date.getUTCDate())}
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <table class="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th>Day (UTC)</th>
            <th>Sent</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day, i) => (
            <tr>
              <td>{formatDay(day)}</td>
              <td>{series.sent[i]}</td>
              <td>{series.failed[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The same columns at sparkline size, for a table cell. Scaled to its own peak. */
export function Spark({ days, series, label }: { days: number[]; series: DailySeries; label: string }) {
  const max = Math.max(1, ...days.map((_, i) => series.sent[i]! + series.failed[i]!));
  return (
    <ol class="vol-cols vol-spark" role="img" aria-label={label}>
      {days.map((day, i) => (
        <Column
          sent={series.sent[i]!}
          failed={series.failed[i]!}
          max={max}
          tip={`${formatDay(day)}: ${formatNum(series.sent[i]!)} sent, ${formatNum(series.failed[i]!)} failed`}
        />
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Share bars                                                          */
/* ------------------------------------------------------------------ */

/** One horizontal sent/failed bar per row, scaled to the largest row. */
export function ShareBars({ rows }: { rows: { label: Child; sent: number; failed: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.sent + r.failed));
  return (
    <ul class="share">
      {rows.map((row) => {
        const total = row.sent + row.failed;
        return (
          <li class="share-row">
            <span class="share-label">{row.label}</span>
            <span class="share-track" title={`${formatNum(row.sent)} sent, ${formatNum(row.failed)} failed`}>
              <span class="share-bar" style={`width:${(total / max) * 100}%`}>
                {row.sent > 0 ? <span class="vol-sent" style={`flex-grow:${row.sent}`} /> : null}
                {row.failed > 0 ? <span class="vol-failed" style={`flex-grow:${row.failed}`} /> : null}
              </span>
            </span>
            <span class="share-value num">
              {formatNum(total)}
              <span class="muted"> {formatRate(failureRate(row.sent, row.failed))} failed</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Stat tile                                                           */
/* ------------------------------------------------------------------ */

export function StatTile({ label, value, sub, children }: { label: string; value: Child; sub?: Child; children?: Child }) {
  return (
    <div class="stat">
      <p class="stat-label">{label}</p>
      <p class="stat-value">{value}</p>
      {sub ? <p class="stat-sub">{sub}</p> : null}
      {children}
    </div>
  );
}
