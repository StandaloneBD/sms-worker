/**
 * Small validation/parsing helpers shared by the api/* route handlers.
 *
 * `fail()` throws `HTTPException`; the single `onError` handler wired in
 * index.ts turns every thrown HTTPException (and malformed-JSON parse
 * failures) into a consistent `{error}` json response, so handlers can just
 * `return fail(...)` (typed `never`, so it composes into any return
 * position) instead of repeating `c.json({error}, status)` everywhere.
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MAX_VARS_KEYS, MAX_VAR_VALUE_LENGTH } from "../shared/constants";
import type { AppEnv } from "../shared/types";

export function fail(status: ContentfulStatusCode, message: string): never {
  throw new HTTPException(status, { message });
}

/** Parses the JSON request body; malformed JSON becomes a 400, not a 500. */
export async function readJsonBody<T>(c: Context<AppEnv>): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    return fail(400, "malformed JSON body");
  }
}

export function jsonObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(400, "body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

export function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** One recipient as accepted in a request body: a bare phone string, or an object. */
export interface RecipientInput {
  to: string;
  vars?: Record<string, string>;
  message?: string;
}

/** Normalizes the raw `recipients` field into `RecipientInput[]`, validating shape only
 *  (phone format and body-length rules are the caller's concern — they differ between
 *  the sync and bulk routes). */
export function normalizeRecipients(raw: unknown): RecipientInput[] {
  if (!Array.isArray(raw)) return fail(400, `"recipients" must be an array`);
  return raw.map((item, index) => {
    if (typeof item === "string") {
      if (item.length === 0) return fail(400, `recipients[${index}]: empty phone number`);
      return { to: item };
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.to !== "string" || obj.to.length === 0) {
        return fail(400, `recipients[${index}]: "to" must be a non-empty string`);
      }
      let vars: Record<string, string> | undefined;
      if (obj.vars !== undefined) {
        if (typeof obj.vars !== "object" || obj.vars === null || Array.isArray(obj.vars)) {
          return fail(400, `recipients[${index}]: "vars" must be an object`);
        }
        const rawVars = obj.vars as Record<string, unknown>;
        const varKeys = Object.keys(rawVars);
        if (varKeys.length > MAX_VARS_KEYS) {
          return fail(400, `recipients[${index}]: "vars" must contain at most ${MAX_VARS_KEYS} keys`);
        }
        for (const key of varKeys) {
          const value = rawVars[key];
          if (typeof value !== "string") {
            return fail(400, `recipients[${index}]: "vars.${key}" must be a string`);
          }
          if (value.length > MAX_VAR_VALUE_LENGTH) {
            return fail(
              400,
              `recipients[${index}]: "vars.${key}" exceeds ${MAX_VAR_VALUE_LENGTH} characters`,
            );
          }
        }
        vars = rawVars as Record<string, string>;
      }
      let message: string | undefined;
      if (obj.message !== undefined) {
        if (typeof obj.message !== "string") {
          return fail(400, `recipients[${index}]: "message" must be a string`);
        }
        message = obj.message;
      }
      return { to: obj.to, vars, message };
    }
    return fail(400, `recipients[${index}]: must be a string or an object`);
  });
}

export function assertRecipientCount(count: number, max: number): void {
  if (count < 1 || count > max) {
    fail(400, `"recipients" must contain between 1 and ${max} entries`);
  }
}

export function parseIdParam(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, "invalid id");
  return id;
}

export function parseQueryInt(
  value: string | undefined,
  opts: { default: number; min?: number; max?: number },
): number {
  if (value === undefined || value === "") return opts.default;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return opts.default;
  let result = n;
  if (opts.min !== undefined) result = Math.max(opts.min, result);
  if (opts.max !== undefined) result = Math.min(opts.max, result);
  return result;
}
