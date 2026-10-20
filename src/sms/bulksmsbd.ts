import type {
  ISmsProvider,
  ProviderCredentials,
  SmsDynamicMessage,
  SmsSendOutcome,
} from "../shared/types";
import { ProviderTransportError, failureForStatus, failureOf } from "./errors";

const SMS_URL = "https://bulksmsbd.net/api/smsapi";
const SMS_MANY_URL = "https://bulksmsbd.net/api/smsapimany";
const ACCEPTED_CODE = 202;
/**
 * The provider's "Invalid Number" code. It is the only decline that is about
 * a recipient rather than the account/sender (balance, sender id, IP
 * whitelist, ...), but the provider answers once per request, so it can only
 * be pinned on a recipient when the request carried exactly one. In a batch
 * it is unattributable and counts as a provider-side refusal: the batch
 * fails over to a provider that reports per recipient.
 */
const INVALID_NUMBER_CODE = 1001;

const JSON_CONTENT_TYPE = "application/json";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Undocumented by the provider; kept conservative and in step with MimSms. */
const MAX_RECIPIENTS_PER_REQUEST = 1000;

const BASE_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const timeoutFor = (recipientCount: number): number =>
  Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + recipientCount * 25);

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "AbortError";
}

type BulkSmsBdResponse = {
  response_code?: number;
  error_message?: string;
  message_id?: string;
};

/** Ported from acadion's BulkSmsBd.ts. */
export class BulkSmsBd implements ISmsProvider {
  readonly name = "bulksmsbd" as const;
  private readonly apiKey: string;
  private readonly senderId: string;

  constructor(credentials: ProviderCredentials) {
    if (!credentials.apiKey) {
      throw new Error("BulkSmsBd: apiKey is required");
    }
    // Unlike acadion (which hardcoded a fallback sender id), this worker
    // serves multiple apps/masking-profiles and must not silently send under
    // the wrong identity — a missing senderId is a construction-time error.
    if (!credentials.senderId) {
      throw new Error("BulkSmsBd: senderId is required");
    }
    this.apiKey = credentials.apiKey;
    this.senderId = credentials.senderId;
  }

  // Left on JSON although the vendor documents form encoding here too: this is
  // the path that carries OTP and login, it is known-good in production, and
  // paper evidence is not enough to justify changing it in a hotfix.
  async send(recipients: string[], message: string): Promise<SmsSendOutcome[]> {
    return this.dispatchBatches(SMS_URL, recipients, (chunk) => ({
      contentType: JSON_CONTENT_TYPE,
      body: JSON.stringify({
        api_key: this.apiKey,
        senderid: this.senderId,
        number: chunk.join(","),
        message,
      }),
      messageLength: message.length,
    }));
  }

  /**
   * `smsapimany` takes form fields, and `messages` must be a JSON-encoded
   * *string* rather than a nested array.
   *
   * Sent as a JSON body the provider's own handler never populates its
   * `$smsarray` and answers `error_message: "Undefined variable $smsarray"`,
   * which is what rejected every dynamic send in production.
   */
  async sendDynamic(messages: SmsDynamicMessage[]): Promise<SmsSendOutcome[]> {
    return this.dispatchBatches(SMS_MANY_URL, messages, (chunk) => ({
      contentType: FORM_CONTENT_TYPE,
      body: new URLSearchParams({
        api_key: this.apiKey,
        senderid: this.senderId,
        messages: JSON.stringify(chunk.map((entry) => ({ to: entry.to, message: entry.message }))),
      }),
      messageLength: chunk.reduce((total, entry) => total + entry.message.length, 0),
    }));
  }

  /**
   * Splits `items` into provider-sized chunks and returns a flat outcome list
   * positionally correlated with `items`.
   *
   * Unlike MimSms, BulkSmsBd reports a single result for the whole request —
   * there is no per-recipient breakdown — so one outcome is replicated across
   * every index in the chunk. A transport failure is confined to its own chunk
   * rather than thrown, so chunks already delivered are not re-sent when the
   * composite dispatch loop fails over.
   */
  private async dispatchBatches<T>(
    url: string,
    items: T[],
    build: (chunk: T[]) => {
      contentType: string;
      body: string | URLSearchParams;
      messageLength: number;
    },
  ): Promise<SmsSendOutcome[]> {
    if (items.length === 0) return [];

    const outcomes: SmsSendOutcome[] = [];
    for (let offset = 0; offset < items.length; offset += MAX_RECIPIENTS_PER_REQUEST) {
      const chunk = items.slice(offset, offset + MAX_RECIPIENTS_PER_REQUEST);
      const { contentType, body, messageLength } = build(chunk);

      let outcome: SmsSendOutcome;
      try {
        outcome = await this.sendPost(url, contentType, body, timeoutFor(chunk.length), {
          recipientCount: chunk.length,
          messageLength,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          JSON.stringify({
            provider: "bulksmsbd",
            event: "batch_transport_failure",
            recipientCount: chunk.length,
            reason,
          }),
        );
        outcome = { accepted: false, reason, failure: failureOf(err) };
      }

      for (let index = 0; index < chunk.length; index++) {
        // The provider returns one `message_id` for the whole request, so
        // claiming it as a per-recipient id would imply an identity that does
        // not exist. Only a single-recipient request can honestly carry one.
        outcomes.push(chunk.length === 1 ? outcome : this.withoutTrackingId(outcome));
      }
    }

    return outcomes;
  }

  private withoutTrackingId(outcome: SmsSendOutcome): SmsSendOutcome {
    return outcome.accepted ? { accepted: true } : outcome;
  }

  private async sendPost(
    url: string,
    contentType: string,
    requestBody: string | URLSearchParams,
    timeoutMs: number,
    metadata: { recipientCount: number; messageLength: number },
  ): Promise<SmsSendOutcome> {
    console.log(JSON.stringify({ provider: "bulksmsbd", event: "sending", ...metadata }));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new ProviderTransportError("BulkSmsBd request timed out");
      }
      throw new ProviderTransportError(
        `BulkSmsBd request failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new ProviderTransportError(`SMS request failed with status ${response.status}`, {
        failure: failureForStatus(response.status),
      });
    }

    let body: BulkSmsBdResponse;
    try {
      body = (await response.json()) as BulkSmsBdResponse;
    } catch (err) {
      throw new ProviderTransportError(
        `SMS response body could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const responseCode = Number(body.response_code);
    if (responseCode === ACCEPTED_CODE) {
      console.log(
        JSON.stringify({
          provider: "bulksmsbd",
          event: "accepted",
          responseCode: body.response_code,
        }),
      );
      return { accepted: true, trackingId: body.message_id };
    }

    const reason = body.error_message ?? `response_code=${String(body.response_code)}`;
    console.warn(
      JSON.stringify({
        provider: "bulksmsbd",
        event: "declined",
        responseCode: body.response_code,
        reason,
        ...metadata,
      }),
    );
    const failure =
      responseCode === INVALID_NUMBER_CODE && metadata.recipientCount === 1 ? "recipient" : "provider";
    return { accepted: false, reason, failure };
  }
}
