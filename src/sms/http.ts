import { ProviderTransportError } from "./errors";

const MAX_RESPONSE_BYTES = 256 * 1024;

/** The deadline covers headers AND body consumption. Reject redirects so a
 * provider cannot forward the credential-bearing POST to another host. */
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
    const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderTransportError(`${provider} request failed with status ${response.status}`);
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
