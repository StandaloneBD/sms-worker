import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, insertMessages, listMessagesByJob, listRecentMessages, purgeOlderThan } from "../src/db";
import { jobChunks, jobs, messages } from "../src/db/schema";
import { appBreakdown, dailyVolume, deliveryStats } from "../src/ui/data";
import { resetDatabase } from "./helpers";

beforeEach(resetDatabase);
const db = getDb(env);
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

async function addJob(id: string, opts: { createdAt: number; completed: boolean; recipients: number }) {
  await db.insert(jobs).values({
    id, appId: 1, kind: "bulk", status: opts.completed ? "completed" : "running", total: opts.recipients,
    sent: opts.recipients, chunkCount: 1, chunksDone: opts.completed ? 1 : 0, createdAt: opts.createdAt,
    completedAt: opts.completed ? opts.createdAt + 60 : null,
  });
  await db.insert(jobChunks).values({ jobId: id, chunkIndex: 0, status: opts.completed ? "done" : "pending", total: opts.recipients });
  await insertMessages(db, Array.from({ length: opts.recipients }, (_, i) => ({
    jobId: id, appId: 1, recipient: `0171234567${i}`, status: i === 0 ? "failed" as const : "sent" as const,
  })));
}

const count = async (table: typeof jobs | typeof messages | typeof jobChunks) => (await db.select().from(table)).length;

describe("retention purge", () => {
  it("removes old finished jobs with their messages and chunks, keeping unfinished and recent ones", async () => {
    const old = now() - 100 * DAY;
    await addJob("old-done", { createdAt: old, completed: true, recipients: 3 });
    await addJob("old-running", { createdAt: old, completed: false, recipients: 1 });
    await addJob("recent", { createdAt: now(), completed: true, recipients: 1 });

    // Two-row rounds: the old job's three messages take two rounds to clear.
    const deleted = await purgeOlderThan(db, 90, { batchRows: 2, maxBatches: 5 });

    expect(deleted).toEqual({ messages: 3, jobChunks: 1, jobs: 1 });
    expect((await db.select({ id: jobs.id }).from(jobs)).map((j) => j.id).sort()).toEqual(["old-running", "recent"]);
    expect(await count(messages)).toBe(2);
    expect(await count(jobChunks)).toBe(2);
  });

  it("keeps a job until its last message is gone, so no message is left without one", async () => {
    await addJob("old-done", { createdAt: now() - 100 * DAY, completed: true, recipients: 3 });

    await purgeOlderThan(db, 90, { batchRows: 2, maxBatches: 1 });
    expect(await count(messages)).toBe(1);
    expect(await count(jobs)).toBe(1);

    await purgeOlderThan(db, 90, { batchRows: 2, maxBatches: 1 });
    expect(await count(messages)).toBe(0);
    expect(await count(jobs)).toBe(0);
  });
});

/**
 * D1 bills rows read, so a query that scans a whole table or sorts every
 * matching row grows with history rather than with the page asked for. Each
 * statement the helpers below send is run through EXPLAIN QUERY PLAN with
 * its real bindings.
 */
describe("query plans stay bounded", () => {
  /** One plan (its EXPLAIN detail lines) per statement `run` sends. */
  async function plansOf(run: (recorded: ReturnType<typeof getDb>) => Promise<unknown>): Promise<string[][]> {
    const statements: { sql: string; args: unknown[] }[] = [];
    const recording = new Proxy(env.DB, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop).bind(target);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(s, p) {
              if (p !== "bind") return Reflect.get(s, p).bind(s);
              return (...args: unknown[]) => {
                statements.push({ sql, args });
                return s.bind(...args);
              };
            },
          });
        };
      },
    });
    await run(getDb({ ...env, DB: recording }));
    const plans: string[][] = [];
    for (const { sql, args } of statements) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>();
      plans.push(results.map((r) => r.detail));
    }
    return plans;
  }

  /** A full pass over a history table (bar the partial index of unfinished
   *  jobs), or a sort of every matching row — sorting the groups a GROUP BY
   *  produced is fine. */
  const unbounded = (plan: string[]) =>
    plan.filter(
      (d) =>
        (/^SCAN (messages|jobs|job_chunks)\b/.test(d) && !d.includes("jobs_unfinished_idx")) ||
        (d.includes("TEMP B-TREE FOR ORDER BY") && !plan.some((g) => g.includes("TEMP B-TREE FOR GROUP BY"))),
    );

  it.each([
    ["a job's messages", (d: ReturnType<typeof getDb>) => listMessagesByJob(d, "job", { limit: 50, offset: 0 }), "messages_job_idx"],
    ["a job's messages below a cursor", (d: ReturnType<typeof getDb>) => listMessagesByJob(d, "job", { limit: 50, before: 1000 }), "messages_job_idx"],
    ["an app's messages", (d: ReturnType<typeof getDb>) => listRecentMessages(d, { appId: 1, limit: 21, offset: 0 }), "messages_app_created_idx"],
    ["an app's failed messages", (d: ReturnType<typeof getDb>) => listRecentMessages(d, { appId: 1, failedOnly: true, limit: 21, offset: 0 }), "messages_app_failed_idx"],
    ["overall stats", (d: ReturnType<typeof getDb>) => deliveryStats(d), "jobs_unfinished_idx"],
    ["an app's stats", (d: ReturnType<typeof getDb>) => deliveryStats(d, 1), "jobs_unfinished_idx"],
    ["overall daily volume", (d: ReturnType<typeof getDb>) => dailyVolume(d), "jobs_created_idx"],
    ["an app's daily volume", (d: ReturnType<typeof getDb>) => dailyVolume(d, { appId: 1 }), "jobs_app_created_idx"],
    ["an app's failure reasons", (d: ReturnType<typeof getDb>) => appBreakdown(d, 1, 7), "messages_app_failed_idx"],
    ["the retention purge", (d: ReturnType<typeof getDb>) => purgeOlderThan(d, 90, { batchRows: 10, maxBatches: 1 }), "messages_job_idx"],
  ])("%s", async (_, run, index) => {
    const plans = await plansOf(run);
    expect(plans.flatMap(unbounded)).toEqual([]);
    expect(plans.flat().some((d) => d.includes(index))).toBe(true);
  });
});
