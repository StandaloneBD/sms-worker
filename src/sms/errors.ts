/**
 * Thrown by a provider adapter when its transport call itself fails: network
 * error, request timeout, a non-2xx HTTP status, or a response body that
 * cannot be parsed. Distinguished from a soft decline (`SmsSendOutcome`
 * `{ accepted: false }`), which means the provider was reached and answered.
 *
 * Each provider adapter catches this per chunk internally and turns it into
 * per-recipient outcomes carrying `failure`, so a transport failure in one
 * chunk never causes chunks that already succeeded to be re-sent. A
 * "transport" failure is ambiguous — the message may already have been sent
 * — while a "provider" failure (a non-2xx the provider chose to return, like
 * 401/403) means it was refused.
 */
export class ProviderTransportError extends Error {
  readonly failure: "transport" | "provider";
  /**
   * What the provider (or the runtime) actually said: a truncated error body,
   * an unparseable response, or the underlying network error. For logs only —
   * it stays out of `message`, which becomes the stored, client-visible
   * failure reason.
   */
  readonly detail: string | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; failure?: "transport" | "provider"; detail?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderTransportError";
    this.failure = options?.failure ?? "transport";
    this.detail = options?.detail;
  }
}

/** Log detail of an error caught around a provider request, if it has one. */
export function detailOf(err: unknown): string | undefined {
  return err instanceof ProviderTransportError ? err.detail : undefined;
}

/** 5xx, 408 and 429 are the provider being unavailable or overloaded; any
 *  other non-2xx is the provider refusing the request itself. */
export function failureForStatus(status: number): "transport" | "provider" {
  return status >= 500 || status === 408 || status === 429 ? "transport" : "provider";
}

/** Failure kind of an error caught around a provider request. Anything that
 *  isn't a classified ProviderTransportError gave no definitive answer. */
export function failureOf(err: unknown): "transport" | "provider" {
  return err instanceof ProviderTransportError ? err.failure : "transport";
}
