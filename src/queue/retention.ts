import { existingJobIds, type Db } from "../db/queries";
import { RETENTION_DAYS } from "../shared/constants";

const CURSOR_KEY = "retention:payload-cursor";

/** Failed submission cleanup can leave R2 objects with no D1 row. Scan a
 * bounded page nightly, keeping active jobs and objects inside retention. */
export async function purgeOrphanedPayloads(env: Env, db: Db, currentTimeMs = Date.now()): Promise<number> {
  const cursor = await env.CACHE.get(CURSOR_KEY);
  const page = await env.PAYLOADS.list({ prefix: "jobs/", limit: 100, ...(cursor ? { cursor } : {}) });
  const cutoffMs = currentTimeMs - RETENTION_DAYS * 86400 * 1000;
  const candidates = page.objects.flatMap((object) => {
    const match = /^jobs\/([^/]+)\.json$/.exec(object.key);
    return match?.[1] && object.uploaded.getTime() < cutoffMs ? [{ jobId: match[1], key: object.key }] : [];
  });
  const existing = await existingJobIds(db, candidates.map((item) => item.jobId));
  const orphanKeys = candidates.filter((item) => !existing.has(item.jobId)).map((item) => item.key);
  if (orphanKeys.length > 0) await env.PAYLOADS.delete(orphanKeys);
  if (page.truncated) await env.CACHE.put(CURSOR_KEY, page.cursor);
  else await env.CACHE.delete(CURSOR_KEY);
  return orphanKeys.length;
}
