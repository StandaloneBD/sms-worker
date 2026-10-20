import type {
  ISmsProvider,
  ProviderCredentials,
  SmsDynamicMessage,
  SmsSendOutcome,
} from "../shared/types";
import { postProviderJson } from "./http";

const ONE_TO_MANY_URL = "https://api.mimsms.com/api/V2/OneToMany";
const DYNAMIC_SMS_URL = "https://api.mimsms.com/api/V2/DSMS";

const BASE_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

/**
 * A batch of 1000 needs longer than a single send, but an unbounded timeout
 * would stall a dispatch behind a dead provider. A chunk that times out is
 * ambiguous — it fails over and may duplicate — so the allowance grows with
 * the recipient count rather than staying at the single-send 10s.
 */
const timeoutFor = (recipientCount: number): number =>
  Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + recipientCount * 25);

/**
 * Provider-documented ceiling on recipients per request. Larger sends are split
 * into sequential chunks whose outcomes are spliced back into caller order.
 */
const MAX_RECIPIENTS_PER_REQUEST = 1000;

/**
 * MiMSMS documents `transactionType` as required on the V2 GET endpoints
 * (`T` transactional / `P` promotional) but omits it from the POST body tables.
 * We send `T` because everything dispatched through this worker — OTPs, fee
 * reminders, notifications — is transactional, and being classified as
 * promotional would subject it to delivery time-window restrictions.
 *
 * The vendor's DSMS example sends `D` instead, but probing the live endpoint
 * showed `T`, `D` and omitting the field entirely all behave identically, so
 * `D` buys nothing. Do not go back around this loop.
 */
const TRANSACTION_TYPE = "T";

/**
 * MiMSMS only accepts E.164-without-plus.
 *
 * `01709280882` comes back as `error: "Invalid Mobile Number"` on every
 * endpoint; `8801709280882` is delivered. Recipients otherwise pass through
 * this worker untouched (see CONTEXT.md "Recipient" — no central
 * normalization), so the conversion belongs to the provider that demands it,
 * done here and nowhere else. BulkSmsBd accepts either form, and normalizing
 * centrally would also change the number an admin is shown in a failure
 * report.
 */
function toInternational(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.startsWith("880")) return digits;
  if (digits.startsWith("0")) return `88${digits}`;
  return digits;
}

/**
 * Comparison key for a recipient: the full international number.
 *
 * Requests are normalized above, but the reply is matched by number rather than
 * by position, so this keeps attribution working whatever form MiMSMS chooses to
 * echo. Exact string matching would risk attributing nothing and failing every
 * recipient of an otherwise successful batch.
 */
function recipientKey(number: string): string {
  return toInternational(number);
}

/**
 * Every published MiMSMS example returns `error_Data: []`, so the element shape
 * is unverified — it may not even be an object. Parsing is deliberately
 * defensive: an entry we cannot read is still accounted for as a failure, and
 * never crashes the dispatch.
 */
/** Best-effort `{ number, reason }` from an `error_Data` element of unknown shape. */
function readErrorEntry(entry: unknown): { number: string; reason: string } | null {
  if (typeof entry === "string") {
    return { number: entry, reason: "provider rejected recipient" };
  }
  if (entry === null || typeof entry !== "object") return null;

  const obj = entry as Record<string, unknown>;
  const number = [obj.mobNumber, obj.mobileNumber, obj.number, obj.to].find((v): v is string => typeof v === "string" && v.length > 0);
  if (!number) return null;

  return {
    number,
    reason:
      [obj.errorMessage, obj.reason, obj.responseResult, obj.message, obj.status].find((v): v is string => typeof v === "string") ??
      "provider rejected recipient",
  };
}

type MimSmsResponse = {
  statusCode?: string | number;
  status?: string;
  trxnId?: string;
  responseResult?: string;
  success_Data?: unknown[];
  error_Data?: unknown[];
};

/** Ported from acadion's MimSms.ts. */
export class MimSms implements ISmsProvider {
  readonly name = "mimsms" as const;
  private readonly apiKey: string;
  private readonly username: string;
  private readonly senderName: string;

  constructor(credentials: ProviderCredentials) {
    if (!credentials.apiKey) throw new Error("MimSms: apiKey is required");
    if (!credentials.username) throw new Error("MimSms: username is required");
    if (!credentials.senderName) throw new Error("MimSms: senderName is required");
    this.apiKey = credentials.apiKey;
    this.username = credentials.username;
    this.senderName = credentials.senderName;
  }

  // Numbers are converted up front rather than inside the payload builder so
  // that the outcome list, which is matched back by number, is keyed off exactly
  // what was put on the wire. The mapping is 1:1, so caller order is preserved.
  async send(recipients: string[], message: string): Promise<SmsSendOutcome[]> {
    return this.dispatchBatches(
      ONE_TO_MANY_URL,
      recipients.map(toInternational),
      (number) => number,
      (chunk) => ({
        ...this.credentials(),
        message,
        smsData: chunk.map((number) => ({ mobNumber: number })),
      }),
    );
  }

  async sendDynamic(messages: SmsDynamicMessage[]): Promise<SmsSendOutcome[]> {
    return this.dispatchBatches(
      DYNAMIC_SMS_URL,
      messages.map((entry) => ({ ...entry, to: toInternational(entry.to) })),
      (entry) => entry.to,
      (chunk) => ({
        ...this.credentials(),
        smsData: chunk.map((entry) => ({ mobNumber: entry.to, message: entry.message })),
      }),
    );
  }

  private credentials(): Record<string, string> {
    return {
      apiKey: this.apiKey,
      userName: this.username,
      senderName: this.senderName,
      transactionType: TRANSACTION_TYPE,
    };
  }

  /**
   * Splits `items` into provider-sized chunks, posts each one, and returns a
   * flat outcome list positionally correlated with `items`.
   *
   * A transport failure is caught per chunk and turned into per-recipient
   * failures rather than being thrown: chunks already delivered must not be
   * re-sent when the composite dispatch loop fails over to the next provider,
   * and only the recipients actually in doubt should be retried.
   */
  private async dispatchBatches<T>(
    url: string,
    items: T[],
    numberOf: (item: T) => string,
    buildPayload: (chunk: T[]) => Record<string, unknown>,
  ): Promise<SmsSendOutcome[]> {
    if (items.length === 0) return [];

    const outcomes: SmsSendOutcome[] = [];
    for (let offset = 0; offset < items.length; offset += MAX_RECIPIENTS_PER_REQUEST) {
      const chunk = items.slice(offset, offset + MAX_RECIPIENTS_PER_REQUEST);
      const numbers = chunk.map(numberOf);

      console.log(
        JSON.stringify({
          provider: "mimsms",
          event: "sending_batch",
          recipientCount: numbers.length,
        }),
      );

      try {
        const body = await this.post(url, buildPayload(chunk), timeoutFor(numbers.length));
        outcomes.push(...this.mapOutcomes(numbers, body));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          JSON.stringify({
            provider: "mimsms",
            event: "batch_transport_failure",
            recipientCount: numbers.length,
            reason,
          }),
        );
        outcomes.push(...numbers.map((): SmsSendOutcome => ({ accepted: false, reason })));
      }
    }

    return outcomes;
  }

  /**
   * Resolves one provider response into per-recipient outcomes.
   *
   * Results come back keyed by mobile number rather than by position, so caller
   * ordering is restored by lookup on {@link recipientKey}. Acceptance is
   * derived from *presence in `success_Data`*; `error_Data` only supplies the
   * reason text. That way an unanticipated `error_Data` shape degrades to a
   * generic decline instead of being mistaken for a success.
   */
  private mapOutcomes(numbers: string[], body: MimSmsResponse): SmsSendOutcome[] {
    const statusCode = String(body.statusCode ?? "");
    const status = body.status?.toLowerCase() ?? "";

    if (statusCode !== "200" || status !== "success") {
      const reason =
        body.responseResult ??
        body.status ??
        (statusCode.length > 0 ? `statusCode=${statusCode}` : "unknown provider response");
      // Without this line a mis-whitelisted key or deactivated account would
      // silently shunt every message to the fallback provider with no trace.
      //
      // The top-level scalars and the body's key list go in too, because a
      // decline reason has already turned up in a field we did not model, and
      // rediscovering that cost a production round trip. Deliberately not the
      // whole body — recipient numbers and message text stay out of the logs,
      // as in the per-recipient warn below.
      console.warn(
        JSON.stringify({
          provider: "mimsms",
          event: "batch_declined",
          recipientCount: numbers.length,
          statusCode,
          reason,
          status: body.status,
          responseResult: body.responseResult,
          trxnId: body.trxnId,
          bodyKeys: Object.keys(body),
        }),
      );
      return numbers.map(() => ({ accepted: false, reason }));
    }

    // A number may legitimately appear twice — two recipients can share a
    // phone and each receive their own rendered message — so tracking ids are
    // held in a per-number FIFO rather than overwritten.
    const trackingIds = new Map<string, string[]>();
    for (const entry of Array.isArray(body.success_Data) ? body.success_Data : []) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as Record<string, unknown>;
      if (typeof obj.mobNumber !== "string") continue;
      const key = recipientKey(obj.mobNumber);
      if (!key) continue;
      const trackingId = typeof obj.trackingId === "string" ? obj.trackingId : "";
      const queue = trackingIds.get(key);
      if (queue) queue.push(trackingId);
      else trackingIds.set(key, [trackingId]);
    }

    const errorEntries = Array.isArray(body.error_Data) ? body.error_Data : [];
    const errorReasons = new Map<string, string>();
    let unreadableErrors = 0;
    for (const entry of errorEntries) {
      const parsed = readErrorEntry(entry);
      if (!parsed) {
        unreadableErrors += 1;
        continue;
      }
      errorReasons.set(recipientKey(parsed.number), parsed.reason);
    }

    if (errorEntries.length > 0) {
      // The element shape is undocumented, so log which keys came back — a real
      // rejection teaches us the schema without putting recipient numbers or
      // message bodies in the log.
      console.warn(
        JSON.stringify({
          provider: "mimsms",
          event: "per_recipient_errors",
          count: errorEntries.length,
          unreadable: unreadableErrors,
          keys: Array.from(
            new Set(
              errorEntries.flatMap((entry) =>
                typeof entry === "object" && entry !== null ? Object.keys(entry) : [typeof entry],
              ),
            ),
          ),
        }),
      );
    }

    let unreported = 0;
    const outcomes = numbers.map((number): SmsSendOutcome => {
      const key = recipientKey(number);

      const successes = trackingIds.get(key);
      if (successes && successes.length > 0) {
        return { accepted: true, trackingId: successes.shift() || undefined };
      }

      const failureReason = errorReasons.get(key);
      if (failureReason !== undefined) {
        return { accepted: false, reason: failureReason };
      }

      unreported += 1;
      if (errorEntries.length === 0) {
        // The provider reported overall success and raised no error for anyone.
        // Trust that over our own attribution: a false decline would fail the
        // recipient *and* re-send the whole batch through the fallback
        // provider, which is worse than accepting a message that was almost
        // certainly sent.
        return { accepted: true };
      }
      return { accepted: false, reason: "provider did not acknowledge recipient" };
    });

    if (unreported > 0) {
      console.warn(
        JSON.stringify({
          provider: "mimsms",
          event: "unreported_recipients",
          recipientCount: numbers.length,
          unreported,
          treatedAsSent: errorEntries.length === 0,
        }),
      );
    }

    return outcomes;
  }

  private async post(url: string, payload: unknown, timeoutMs: number): Promise<MimSmsResponse> {
    const raw = await postProviderJson("MimSms", url, JSON.stringify(payload), { "Content-Type": "application/json", Accept: "application/json" }, timeoutMs);
    return {
      statusCode: typeof raw.statusCode === "string" || typeof raw.statusCode === "number" ? raw.statusCode : undefined,
      status: typeof raw.status === "string" ? raw.status : undefined,
      trxnId: typeof raw.trxnId === "string" ? raw.trxnId : undefined,
      responseResult: typeof raw.responseResult === "string" ? raw.responseResult : undefined,
      success_Data: Array.isArray(raw.success_Data) ? raw.success_Data : undefined,
      error_Data: Array.isArray(raw.error_Data) ? raw.error_Data : undefined,
    };
  }
}
