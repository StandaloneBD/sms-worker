/** GET /apps/:id/jobs (an App's jobs, paginated) and /apps/:id/jobs/:jobId
 *  (detail + its messages, paginated). /jobs/:id redirects to the latter. */

import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { getDb } from "../../db";
import { getAppById, getJob, getJobForApp, getTemplate, listJobs, listMessagesByJob } from "../../db/queries";
import type { AppEnv } from "../../shared/types";
import { AppHeader, ChunkProgress, Empty, Kv, MessageDetailRow, MessageExpandCell, NotFoundPage, Pagination, Panel, Status, TemplateRef } from "../components";
import { readFlash } from "../flash";
import { Layout } from "../layout";
import { appPath, jobPath } from "../paths";
import { formatNum, formatTs, PAGE_SIZE, parseId, parseOffset, shortId } from "../util";

export async function jobsListGet(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  const db = getDb(c.env);
  const app = id === null ? undefined : await getAppById(db, id);
  if (!app) return c.html(<NotFoundPage flash={readFlash(c)} what="App" />, 404);

  const offset = parseOffset(c.req.query("offset"));
  const rows = await listJobs(db, { appId: app.id, limit: PAGE_SIZE + 1, offset });
  const hasNext = rows.length > PAGE_SIZE;
  const jobs = rows.slice(0, PAGE_SIZE);
  const flash = readFlash(c);

  return c.html(
    <Layout title={`Jobs · ${app.name}`} active="apps" flash={flash}>
      <AppHeader app={app} tab="jobs" />

      <Panel flush>
        {jobs.length === 0 ? (
          <Empty
            title={offset > 0 ? "No older jobs." : "No jobs yet. Every send and bulk job this app makes is listed here."}
            hint="POST /v1/sms/send or /v1/sms/jobs"
          />
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th class="num">Recipients</th>
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
                    <td class="num">{formatNum(job.total)}</td>
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
      <Pagination basePath={appPath(app.id, "jobs")} offset={offset} limit={PAGE_SIZE} hasNext={hasNext} />
    </Layout>,
  );
}

export async function jobDetailGet(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  const jobId = c.req.param("jobId");
  const db = getDb(c.env);
  const [app, job] = id === null || !jobId ? [] : await Promise.all([getAppById(db, id), getJobForApp(db, id, jobId)]);
  if (!app) return c.html(<NotFoundPage flash={readFlash(c)} what="App" />, 404);
  if (!job) return c.html(<NotFoundPage flash={readFlash(c)} what="Job" />, 404);

  const offset = parseOffset(c.req.query("offset"));
  const templateId = job.templateId ?? null;
  const [rows, template] = await Promise.all([
    listMessagesByJob(db, job.id, { limit: PAGE_SIZE + 1, offset }),
    templateId !== null ? getTemplate(db, job.appId, templateId) : undefined,
  ]);
  const hasNext = rows.length > PAGE_SIZE;
  const messages = rows.slice(0, PAGE_SIZE);
  const flash = readFlash(c);

  const kvItems: { label: string; value: Child }[] = [
    { label: "Job ID", value: <span class="mono">{job.id}</span> },
    { label: "Kind", value: job.kind },
    { label: "Status", value: <Status value={job.status} /> },
    { label: "Progress", value: <ChunkProgress done={job.chunksDone} total={job.chunkCount} /> },
    {
      label: "Total / Sent / Failed",
      value: (
        <span class="mono num">
          {formatNum(job.total)} / {formatNum(job.sent)} / {formatNum(job.failed)}
        </span>
      ),
    },
    { label: "Created", value: <span class="mono">{formatTs(job.createdAt)}</span> },
    { label: "Completed", value: <span class="mono">{formatTs(job.completedAt)}</span> },
  ];
  if (job.error) {
    kvItems.push({ label: "Error", value: job.error });
  }
  if (templateId !== null) {
    kvItems.push({
      label: "Template",
      value: <TemplateRef appId={job.appId} id={templateId} name={template?.name ?? null} />,
    });
  }

  return c.html(
    <Layout title={`Job ${shortId(job.id)} · ${app.name}`} active="apps" flash={flash}>
      <AppHeader app={app} tab="jobs" trail={`Job ${shortId(job.id)}`} />

      <Panel>
        <Kv items={kvItems} />
      </Panel>

      <Panel title="Messages" flush>
        {messages.length === 0 ? (
          <Empty title="No messages recorded for this job yet." />
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Provider</th>
                  <th>Time</th>
                  <th>Status</th>
                  <th>
                    <span class="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              {messages.map((msg) => {
                const detailId = `msg-${msg.id}`;
                return (
                  <tbody class="msg">
                    <tr class="msg-summary">
                      <td class="mono">{msg.recipient}</td>
                      <td>{msg.provider ?? "—"}</td>
                      <td class="mono">{formatTs(msg.createdAt)}</td>
                      <td>
                        <Status value={msg.status} />
                      </td>
                      <MessageExpandCell id={detailId} recipient={msg.recipient} />
                    </tr>
                    <MessageDetailRow
                      id={detailId}
                      text={msg.body ?? job.body}
                      status={msg.status}
                      reason={msg.reason}
                      trackingId={msg.trackingId}
                      colspan={5}
                    />
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
      </Panel>
      <Pagination basePath={jobPath(app.id, job.id)} offset={offset} limit={PAGE_SIZE} hasNext={hasNext} />
    </Layout>,
  );
}

/** GET /jobs/:id — a job by id alone (an id from logs or an API response)
 *  forwards to its page under its App. */
export async function jobRedirectGet(c: Context<AppEnv>): Promise<Response> {
  const jobId = c.req.param("id");
  const job = jobId ? await getJob(getDb(c.env), jobId) : undefined;
  if (!job) return c.html(<NotFoundPage flash={readFlash(c)} what="Job" />, 404);
  return c.redirect(jobPath(job.appId, job.id), 302);
}
