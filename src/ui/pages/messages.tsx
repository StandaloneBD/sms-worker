/** GET /apps/:id/messages?status=&offset= — an App's recent messages, all or failed only. */

import type { Context } from "hono";
import { getDb } from "../../db";
import { getAppById, listRecentMessages } from "../../db/queries";
import type { AppEnv } from "../../shared/types";
import { AppHeader, Empty, MessageDetailRow, MessageExpandCell, NotFoundPage, Pagination, Panel, Status, TemplateRef } from "../components";
import { readFlash } from "../flash";
import { Layout } from "../layout";
import { appPath } from "../paths";
import { formatTs, PAGE_SIZE, parseId, parseOffset } from "../util";

export async function messagesGet(c: Context<AppEnv>): Promise<Response> {
  const id = parseId(c.req.param("id"));
  const db = getDb(c.env);
  const app = id === null ? undefined : await getAppById(db, id);
  if (!app) return c.html(<NotFoundPage flash={readFlash(c)} what="App" />, 404);

  const status = c.req.query("status") === "failed" ? "failed" : undefined;
  const offset = parseOffset(c.req.query("offset"));
  const rows = await listRecentMessages(db, { appId: app.id, failedOnly: status === "failed", limit: PAGE_SIZE + 1, offset });
  const hasNext = rows.length > PAGE_SIZE;
  const messages = rows.slice(0, PAGE_SIZE);
  const flash = readFlash(c);

  const base = appPath(app.id, "messages");
  const listPath = status ? `${base}?status=failed` : base;

  return c.html(
    <Layout title={`Messages · ${app.name}`} active="apps" flash={flash}>
      <AppHeader app={app} tab="messages" />

      <Panel
        flush
        actions={
          <nav class="seg" aria-label="Filter messages">
            <a href={base} class={status ? undefined : "is-active"} aria-current={status ? undefined : "page"}>
              All
            </a>
            <a href={`${base}?status=failed`} class={status ? "is-active" : undefined} aria-current={status ? "page" : undefined}>
              Failed
            </a>
          </nav>
        }
      >
        {messages.length === 0 ? (
          <Empty
            title={
              offset > 0 ? "No older messages." : status ? "No failed messages." : "No messages yet. Each recipient this app sends to is listed here."
            }
          />
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Template</th>
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
                      <td>
                        <TemplateRef appId={msg.appId} id={msg.templateId} name={msg.templateName} />
                      </td>
                      <td>{msg.provider ?? "—"}</td>
                      <td class="mono">{formatTs(msg.createdAt)}</td>
                      <td>
                        <Status value={msg.status} />
                      </td>
                      <MessageExpandCell id={detailId} recipient={msg.recipient} />
                    </tr>
                    <MessageDetailRow
                      id={detailId}
                      text={msg.body ?? msg.jobBody}
                      status={msg.status}
                      reason={msg.reason}
                      trackingId={msg.trackingId}
                      job={{ appId: msg.appId, id: msg.jobId }}
                      colspan={6}
                    />
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
      </Panel>
      <Pagination basePath={listPath} offset={offset} limit={PAGE_SIZE} hasNext={hasNext} />
    </Layout>,
  );
}
