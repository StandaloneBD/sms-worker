import { ProviderTransportError, failureForStatus } from "./errors";

const MAX_RESPONSE_BYTES = 256 * 1024;

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
 */
export async function postProviderJson(
  provider: string,
  url: string,
  body: string | URLSearchParams,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ProviderTransportError(`${provider} answered with a redirect (${response.status})`, { failure: "provider" });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderTransportError(`${provider} request failed with status ${response.status}`, {
        failure: failureForStatus(response.status),
      });
    }
    if (!response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new ProviderTransportError(`${provider} response body is missing or too large`);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ProviderTransportError(`${provider} response body too large`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderTransportError(`${provider} response must be a JSON object`);
    }
    return value as Record<string, unknown>;
  } catch (err) {
    await reader?.cancel().catch(() => {});
    if (controller.signal.aborted) throw new ProviderTransportError(`${provider} request timed out`);
    if (err instanceof ProviderTransportError) throw err;
    throw new ProviderTransportError(`${provider} request or response failed`, { cause: err });
  } finally {
    clearTimeout(timeout);
    reader?.releaseLock();
  }
}
