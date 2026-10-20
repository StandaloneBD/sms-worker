/** Small reusable JSX bits shared across pages — see DESIGN.md "Components". */

import type { Child } from "hono/jsx";
import type { JobStatus, MessageStatus } from "../shared/types";
import type { Flash } from "./flash";
import type { AppTab } from "./paths";
import { Layout } from "./layout";
import { adminPath, appPath, jobPath } from "./paths";
import { formatNum, smsSegments } from "./util";

/* ------------------------------------------------------------------ */
/* Page head                                                           */
/* ------------------------------------------------------------------ */

export function PageHeader({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  actions?: Child;
}) {
  return (
    <div class="page-head">
      <div>
        {eyebrow ? <p class="eyebrow">{eyebrow}</p> : null}
        <h1 class="page-title">{title}</h1>
        {sub ? <p class="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div class="page-actions">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                                */
/* ------------------------------------------------------------------ */

export function Panel({
  id,
  title,
  actions,
  flush,
  children,
}: {
  id?: string;
  title?: string;
  actions?: Child;
  flush?: boolean;
  children?: Child;
}) {
  return (
    <section class="panel" id={id}>
      {title || actions ? (
        <div class="panel-head">
          {title ? <p class="panel-title">{title}</p> : <span />}
          {actions ? <div class="panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div class={flush ? "panel-body panel-flush" : "panel-body"}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Status LED                                                          */
/* ------------------------------------------------------------------ */

type AnyStatus = JobStatus | MessageStatus;

const STATUS_META: Record<AnyStatus, { led: string; label: string }> = {
  sent: { led: "led-accent", label: "Sent" },
  completed: { led: "led-accent", label: "Completed" },
  failed: { led: "led-danger", label: "Failed" },
  completed_with_errors: { led: "led-warn", label: "Completed with errors" },
  queued: { led: "led-amber", label: "Queued" },
  running: { led: "led-accent led-running", label: "Running" },
};

export function Status({ value }: { value: AnyStatus }) {
  const meta = STATUS_META[value];
  return (
    <span class="status">
      <span class={`led ${meta.led}`} />
      {meta.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Chunk progress                                                      */
/* ------------------------------------------------------------------ */

export function ChunkProgress({ done, total }: { done: number; total: number }) {
  const safeTotal = Math.max(0, total);
  const safeDone = Math.max(0, Math.min(done, safeTotal));
  const pct = safeTotal > 0 ? Math.round((safeDone / safeTotal) * 100) : 0;
  // Sync sends have no chunks — a 0/0 track is noise, not information.
  if (safeTotal === 0) return <span class="muted">—</span>;

  return (
    <span style="display:inline-flex;align-items:center;gap:8px">
      {safeTotal > 0 && safeTotal <= 24 ? (
        <span class="chunks chunks-seg">
          {Array.from({ length: safeTotal }, (_, i) => (
            <i class={i < safeDone ? "is-done" : undefined} />
          ))}
        </span>
      ) : (
        <span class="chunks">
          <span class="chunks-fill" style={`width:${pct}%`} />
        </span>
      )}
      <span class="mono num">
        {safeDone}/{safeTotal}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Segment ruler                                                       */
/* ------------------------------------------------------------------ */

export function Segments({ body }: { body: string }) {
  const { chars, units, segments, encoding } = smsSegments(body);
  return (
    <span class="segments mono muted">
      {formatNum(chars)} chars{units !== chars ? <> · {formatNum(units)} units</> : null} · {segments} segment
      {segments === 1 ? "" : "s"} · {encoding}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Message details                                                     */
/* ------------------------------------------------------------------ */

/**
 * The chevron cell that ends a message's summary row; opens the
 * MessageDetailRow with the same `id` (via /admin/expand.js).
 */
export function MessageExpandCell({ id, recipient }: { id: string; recipient: string }) {
  return (
    <td class="msg-expand-cell">
      <button
        type="button"
        class="msg-expand"
        data-expand
        aria-expanded="false"
        aria-controls={id}
        aria-label={`Details for ${recipient}`}
        title="Details"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </td>
  );
}

/**
 * A message's detail row, hidden until its MessageExpandCell opens it: the
 * text it carried, any failure reason, then its job, length and tracking ID.
 * Pass `text` as `message.body ?? job.body`; null only when no body resolved
 * (the send failed before dispatch). Omit `job` on the job's own page.
 */
export function MessageDetailRow({
  id,
  text,
  status,
  reason,
  trackingId,
  job,
  colspan,
}: {
  id: string;
  text: string | null;
  status: MessageStatus;
  reason: string | null;
  trackingId: string | null;
  job?: { appId: number; id: string };
  colspan: number;
}) {
  return (
    <tr class="msg-detail" id={id} hidden>
      <td colspan={colspan}>
        {text === null ? (
          <p class="msg-text-body muted">No text recorded.</p>
        ) : (
          <p class="msg-text-body">{text}</p>
        )}
        {reason ? <p class={status === "failed" ? "msg-reason is-failed" : "msg-reason"}>{reason}</p> : null}
        <dl class="msg-facts">
          {job ? (
            <div>
              <dt>Job</dt>
              <dd>
                <a href={jobPath(job.appId, job.id)}>{job.id}</a>
              </dd>
            </div>
          ) : null}
          {text !== null ? (
            <div>
              <dt>Length</dt>
              <dd>
                <Segments body={text} />
              </dd>
            </div>
          ) : null}
          <div>
            <dt title="The provider's own ID for this SMS. Quote it when asking the provider about it.">Tracking ID</dt>
            <dd>{trackingId ?? <span class="muted">None</span>}</dd>
          </div>
        </dl>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* Template reference                                                  */
/* ------------------------------------------------------------------ */

/** A template by name and id, linked to its edit page; still shows the id once deleted. */
export function TemplateRef({ appId, id, name }: { appId: number; id: number | null; name: string | null }) {
  if (id === null) return <span class="muted">—</span>;
  return name === null ? (
    <span class="muted" title="This template has since been deleted">
      <span class="mono">#{id}</span> deleted
    </span>
  ) : (
    <a class="row-link" href={adminPath(`/apps/${appId}/templates/${id}`)}>
      {name} <span class="mono muted">#{id}</span>
    </a>
  );
}

/* ------------------------------------------------------------------ */
/* App header                                                          */
/* ------------------------------------------------------------------ */

const APP_TABS: { key: AppTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "jobs", label: "Jobs" },
  { key: "messages", label: "Messages" },
  { key: "config", label: "Configuration" },
];

/**
 * Heads every page inside an App: its name and state, then the tabs that
 * scope everything below to it. `trail` names a page deeper than a tab
 * (a job, a template) and turns the active tab into a link back.
 */
export function AppHeader({
  app,
  tab,
  trail,
  actions,
}: {
  app: { id: number; name: string; isActive: boolean };
  tab: AppTab;
  trail?: string;
  actions?: Child;
}) {
  return (
    <header class="app-head">
      <div class="app-head-main">
        <div class="app-head-title">
          <a class="app-head-back" href={adminPath("/apps")}>
            All apps
          </a>
          <h1 class="page-title">
            {app.name}
            {trail ? <span class="app-head-trail"> / {trail}</span> : null}
          </h1>
          {trail ? null : (
            <span class={`badge ${app.isActive ? "badge-on" : "badge-off"}`}>{app.isActive ? "Active" : "Inactive"}</span>
          )}
        </div>
        {actions ? <div class="page-actions">{actions}</div> : null}
      </div>
      <nav class="tabs" aria-label={`${app.name} sections`}>
        {APP_TABS.map((item) =>
          item.key === tab && !trail ? (
            <a href={appPath(app.id, item.key)} class="is-active" aria-current="page">
              {item.label}
            </a>
          ) : (
            <a href={appPath(app.id, item.key)} class={item.key === tab ? "is-active" : undefined}>
              {item.label}
            </a>
          ),
        )}
      </nav>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div class="empty">
      <p>{title}</p>
      {hint ? <p class="mono">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Definition grid                                                     */
/* ------------------------------------------------------------------ */

export function Kv({ items }: { items: { label: string; value: Child }[] }) {
  return (
    <dl class="kv">
      {items.map((item) => (
        <div>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* Breadcrumb                                                          */
/* ------------------------------------------------------------------ */

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav class="breadcrumb">
      {items.map((item, i) => (
        <>
          {i > 0 ? " / " : ""}
          {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
        </>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export function Pagination({
  basePath,
  offset,
  limit,
  hasNext,
}: {
  basePath: string;
  offset: number;
  limit: number;
  hasNext: boolean;
}) {
  const prevOffset = Math.max(0, offset - limit);
  const sep = basePath.includes("?") ? "&" : "?";
  return (
    <div class="pagination">
      {offset > 0 ? (
        <a class="btn btn-quiet btn-sm" href={`${basePath}${sep}offset=${prevOffset}`}>
          ← Newer
        </a>
      ) : (
        <span class="btn btn-quiet btn-sm muted">← Newer</span>
      )}
      {hasNext ? (
        <a class="btn btn-quiet btn-sm" href={`${basePath}${sep}offset=${offset + limit}`}>
          Older →
        </a>
      ) : (
        <span class="btn btn-quiet btn-sm muted">Older →</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Not found                                                           */
/* ------------------------------------------------------------------ */

export function NotFoundPage({ flash, what }: { flash?: Flash; what?: string }) {
  return (
    <Layout title="Not found" flash={flash}>
      <PageHeader eyebrow="ERROR" title="Not found" />
      <Empty title={`${what ?? "The requested resource"} could not be found.`} />
    </Layout>
  );
}
