/**
 * `Idempotency-Key` support for the send routes. A client that times out
 * and retries with the same key gets the original response replayed instead
 * of a second send (or a second bulk Job).
 *
 *  - The first request with a key claims it in D1 (idempotency_keys), runs,
 *    and stores a 2xx response; a non-2xx releases the claim so the client
 *    can retry.
 *  - A retry with the same key and the same request (method, path, raw body)
 *    gets the stored response with `Idempotent-Replayed: true`, or 409 while
 *    the first request is still running.
 *  - The same key with a different request is a 422.
 *  - Keys are kept for IDEMPOTENCY_TTL_SECONDS. A claim whose request never
 *    finished (crashed isolate), or whose response couldn't be stored even
 *    on a second try, can be taken over by a retry after
 *    IDEMPOTENCY_LOCK_SECONDS — at-least-once, as everywhere else.
 *
 * If D1 is unreachable the request proceeds without idempotency (logged):
 * ADR 0002, sending outranks record-keeping. Bulk Jobs opt out with
 * `failClosed`; the route gives the reason.
 */

import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  getDb,
  getIdempotencyKey,
  releaseIdempotencyKey,
} from "../db";
import { IDEMPOTENCY_LOCK_SECONDS, IDEMPOTENCY_TTL_SECONDS, MAX_IDEMPOTENCY_KEY_LENGTH } from "../shared/constants";
import { sha256Hex } from "../shared/crypto";
import type { AppEnv } from "../shared/types";
import { fail } from "./validate";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const idempotency = ({ failClosed = false } = {}) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (key === undefined) {
      await next();
      return;
    }
    if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return fail(400, `"Idempotency-Key" must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }

    const appId = c.var.app.id;
    const requestHash = await sha256Hex(`${c.req.method} ${c.req.path}\n${await c.req.text()}`);
    const db = getDb(c.env);
    const now = Math.floor(Date.now() / 1000);

    let claimed: boolean;
    try {
      claimed = await claimIdempotencyKey(db, {
        appId,
        key,
        requestHash,
        expiredBefore: now - IDEMPOTENCY_TTL_SECONDS,
        lockExpiredBefore: now - IDEMPOTENCY_LOCK_SECONDS,
      });
    } catch (err) {
      console.error(JSON.stringify({ event: "idempotency_claim_failed", appId, error: errorMessage(err) }));
      if (failClosed) return fail(503, "Idempotency-Key could not be recorded; try again");
      await next();
      return;
    }

    if (!claimed) {
      const row = await getIdempotencyKey(db, appId, key);
      if (row && row.requestHash !== requestHash) {
        return fail(422, "Idempotency-Key was already used for a different request");
      }
      if (!row || row.responseStatus === null || row.responseBody === null) {
        return fail(409, "a request with this Idempotency-Key is still in progress");
      }
      return c.body(row.responseBody, row.responseStatus as ContentfulStatusCode, {
        "content-type": "application/json; charset=UTF-8",
        "idempotent-replayed": "true",
      });
    }

    try {
      await next();
    } finally {
      // An exception thrown past the route's error handler leaves no
      // response to store, same as a non-2xx: release so the client can retry.
      const succeeded = !c.error && c.res.status >= 200 && c.res.status < 300;
      // Tried twice: a response that is never stored leaves the key claimed
      // but empty, and once the claim expires a retry runs the request again
      // (a second Send, or a second Job even under failClosed).
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (succeeded) {
            const body = await c.res.clone().text();
            await completeIdempotencyKey(db, { appId, key, status: c.res.status, body });
          } else {
            await releaseIdempotencyKey(db, appId, key);
          }
          break;
        } catch (err) {
          console.error(
            JSON.stringify({ event: "idempotency_store_failed", appId, attempt, error: errorMessage(err) }),
          );
        }
      }
    }
  });
