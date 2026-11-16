import { ProviderTransportError, failureForStatus } from "./errors";

const MAX_RESPONSE_BYTES = 256 * 1024;
/** How much of an error or unparseable body is kept for the logs. */
const MAX_DETAIL_CHARS = 1000;

const BASE_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

/**
 * Request timeout for a provider call carrying `recipientCount` recipients.
 * A batch of 1000 needs longer than a single send, but an unbounded timeout
 * would stall a dispatch behind a dead provider. A request that times out is
 * ambiguous — it fails over and may duplicate — so the allowance grows with
 * the recipient count rather than staying at the single-send 10s.
 */
export const providerTimeoutFor = (recipientCount: number): number =>
  Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + recipientCount * 25);

export interface ProviderJsonOptions {
  /**
   * Return the JSON object body of a refusal (a non-2xx that
   * `failureForStatus` classes as "provider", e.g. 401/422) instead of
   * throwing, for providers that put their error code on an HTTP error. A
   * refusal whose body isn't a JSON object still throws.
   */
  jsonRefusals?: boolean;
}

/**
 * POSTs to a provider and returns its JSON object response. The deadline
 * covers headers AND body consumption, and the body is capped at
 * MAX_RESPONSE_BYTES.
 *
 * Redirects are never followed, so a provider can't forward the
 * credential-bearing POST to another host. Workers only supports
 * `redirect: "follow" | "manual"` (`"error"` throws a TypeError before any
 * request is made), so this uses "manual" and treats a 3xx as the provider
 * refusing the request.
 *
 * Every thrown error carries `detail` — the start of the provider's error
 * body, the unparseable response, or the underlying network error — so the
 * adapters can log what the provider actually said.
 */
export async function postProviderJson(
  provider: string,
  url: string,
  body: string | URLSearchParams,
  headers: Record<string, string>,
  timeoutMs: number,
  options: ProviderJsonOptions = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ProviderTransportError(`${provider} answered with a redirect (${response.status})`, {
        failure: "provider",
        detail: `location: ${response.headers.get("location") ?? "(none)"}`,
      });
    }
    if (!response.ok) {
      const failure = failureForStatus(response.status);
      // The status is the answer; an unreadable body must not turn it into a
      // generic transport failure.
      const { text } = await readCapped(response.body, MAX_DETAIL_CHARS).catch(() => ({ text: "(body unreadable)" }));
      if (options.jsonRefusals && failure === "provider") {
        const value = parseJsonObject(text);
        if (value) return value;
      }
      throw new ProviderTransportError(`${provider} request failed with status ${response.status}`, {
        failure,
        detail: text,
      });
    }
    if (!response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new ProviderTransportError(`${provider} response body is missing or too large`, {
        detail: `content-length: ${response.headers.get("content-length") ?? "(none)"}`,
      });
    }
    const { text, truncated } = await readCapped(response.body, MAX_RESPONSE_BYTES);
    if (truncated) {
      throw new ProviderTransportError(`${provider} response body too large`, { detail: text.slice(0, MAX_DETAIL_CHARS) });
    }
    const value = parseJsonObject(text);
    if (!value) {
      throw new ProviderTransportError(`${provider} response is not a JSON object`, {
        detail: text.slice(0, MAX_DETAIL_CHARS),
      });
    }
    return value;
  } catch (err) {
    if (err instanceof ProviderTransportError) throw err;
    if (controller.signal.aborted) {
      throw new ProviderTransportError(`${provider} request timed out`, { detail: `after ${timeoutMs}ms` });
    }
    throw new ProviderTransportError(`${provider} request or response failed`, {
      cause: err,
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reads at most `maxBytes` of a body as text, cancelling the rest. A
 * multi-byte character split at the cap decodes as U+FFFD.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const room = maxBytes - bytes;
      if (chunk.value.byteLength > room) {
        text += decoder.decode(chunk.value.subarray(0, room));
        await reader.cancel().catch(() => {});
        return { text, truncated: true };
      }
      bytes += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { text: text + decoder.decode(), truncated: false };
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}
