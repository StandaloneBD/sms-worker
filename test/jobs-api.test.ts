import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, expect, it } from "vitest";
import { smsRoutes } from "../src/api/sms";
import { getDb, insertMessages } from "../src/db";
import { jobs } from "../src/db/schema";
import type { AppEnv } from "../src/shared/types";
import { resetDatabase } from "./helpers";

beforeEach(resetDatabase);
const db = getDb(env);

interface MessagesPage {
  offset: number;
  nextBefore: number | null;
  messages: { id: number; recipient: string }[];
}

async function getPage(query: string): Promise<MessagesPage> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("app", { id: 1, name: "test", isActive: true }); await next(); });
  app.route("/", smsRoutes);
  const res = await app.request(`/sms/jobs/job/messages?${query}`, {}, env);
  expect(res.status).toBe(200);
  return res.json();
}

async function addJob(recipients: number) {
  await db.insert(jobs).values({ id: "job", appId: 1, kind: "bulk", status: "completed", total: recipients, chunkCount: 1, createdAt: 0 });
  await insertMessages(db, Array.from({ length: recipients }, (_, i) => ({
    jobId: "job", appId: 1, recipient: `017123456${String(i).padStart(2, "0")}`, status: "sent" as const,
  })));
}

// 7 ends on a short page; 6 ends on a full one, so one empty page follows.
it.each([7, 6])("following nextBefore walks all %i of a job's messages exactly once, newest first", async (total) => {
  await addJob(total);
  const seen: number[] = [];
  let page = await getPage("limit=3");
  seen.push(...page.messages.map((m) => m.id));
  while (page.nextBefore !== null) {
    page = await getPage(`limit=3&before=${page.nextBefore}&offset=99`);
    expect(page.offset).toBe(0);
    seen.push(...page.messages.map((m) => m.id));
  }
  expect(seen).toHaveLength(total);
  expect(seen).toEqual([...seen].sort((a, b) => b - a));
  expect(new Set(seen).size).toBe(total);
});

it("offset paging still works without a cursor", async () => {
  await addJob(5);
  const first = await getPage("limit=2");
  const second = await getPage("limit=2&offset=2");
  expect(second.offset).toBe(2);
  expect(second.messages[0]!.id).toBeLessThan(first.messages[1]!.id);
  expect(second.nextBefore).toBe(second.messages[1]!.id);
});
