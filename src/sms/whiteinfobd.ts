import type {
  ISmsProvider,
  ProviderCredentials,
  SmsDynamicMessage,
  SmsSendOutcome,
} from "../shared/types";
import { MAX_PROVIDER_REQUESTS_PER_DISPATCH } from "../shared/constants";
import { detailOf, failureOf } from "./errors";
import { postProviderJson, providerTimeoutFor } from "./http";

/** https://sms.whiteinfobd.com/docs — "Send SMS (JSON POST)". */
const SMS_URL = "https://sms.whiteinfobd.com/api/v1/messages";
const ACCEPTED_CODE = 1000;
/**
 * "Invalid Mobile Number". Like BulkSMSBD, the provider answers once per
 * request, so this is pinned on a recipient only when the request carried
 * exactly one; in a batch it counts as a provider-side refusal.
 *
 * Every other code is about the account or request (2000/2002 invalid key —
 * the live API answers 2000 although the docs list 2002 —, 2001 missing key,
 * 2003 IP not whitelisted, 2004 missing parameter, 2005 invalid sender id,
 * 3000 insufficient balance).
 */
const INVALID_NUMBER_CODE = 2006;

/** Undocumented by the provider; kept in step with the other adapters. */
const MAX_RECIPIENTS_PER_REQUEST = 1000;

/**
 * Requests in flight at once on a dynamic send. Sequential requests would
 * keep a 40-recipient sync send waiting tens of seconds; the provider's rate
 * limits are undocumented, so this stays small.
 */
const CONCURRENCY = 4;

/** One body for every recipient at `indexes` (positions in the caller's list). */
interface Group {
  message: string;
  indexes: number[];
}

/** One HTTP request: a body and the caller positions it is sent to. */
interface Batch {
  message: string;
  indexes: number[];
  numbers: string[];
}

/**
 * WhiteInfoBD sends one body to one or more comma-separated numbers per
 * request and has no many-to-many endpoint. A dynamic send therefore costs a
 * request per distinct body (recipients sharing a body still share a
 * request), bounded by MAX_PROVIDER_REQUESTS_PER_DISPATCH (ADR 0007).
 *
 * Numbers pass through untouched: the provider normalizes `01…`, `8801…` and
 * `+8801…` itself.
 */
export class WhiteInfoBd implements ISmsProvider {
  readonly name = "whiteinfobd" as const;
  private readonly apiKey: string;
  private readonly senderId: string;

  constructor(credentials: ProviderCredentials) {
    if (!credentials.apiKey) throw new Error("WhiteInfoBd: apiKey is required");
    // As with BulkSMSBD: never fall back to some default sender identity.
    if (!credentials.senderId) throw new Error("WhiteInfoBd: senderId is required");
    this.apiKey = credentials.apiKey;
    this.senderId = credentials.senderId;
  }

  async send(recipients: string[], message: string): Promise<SmsSendOutcome[]> {
    return this.dispatchGroups(recipients, [{ message, indexes: recipients.map((_, index) => index) }]);
  }

  async sendDynamic(messages: SmsDynamicMessage[]): Promise<SmsSendOutcome[]> {
    const groups = new Map<string, number[]>();
    messages.forEach((entry, index) => {
      const indexes = groups.get(entry.message);
      if (indexes) indexes.push(index);
      else groups.set(entry.message, [index]);
    });
    return this.dispatchGroups(
      messages.map((entry) => entry.to),
      Array.from(groups, ([message, indexes]) => ({ message, indexes })),
    );
  }

  /**
   * Sends each group in provider-sized requests and returns outcomes
   * positionally correlated with `numbers`.
   *
   * Requests past the budget are never sent. Once a request fails for any
   * reason other than its recipient (bad key, no balance, provider down) the
   * rest aren't started either: they would most likely fail the same way, and
   * a dead provider would otherwise hold the dispatch for a timeout per
   * request. Either way those recipients are declined as "provider" — not
   * sent, retryable — so dispatch fails them over to the next provider.
   */
  private async dispatchGroups(numbers: string[], groups: Group[]): Promise<SmsSendOutcome[]> {
    if (numbers.length === 0) return [];

    const requests: Batch[] = groups.flatMap((group) => {
      const parts: Batch[] = [];
      for (let offset = 0; offset < group.indexes.length; offset += MAX_RECIPIENTS_PER_REQUEST) {
        const indexes = group.indexes.slice(offset, offset + MAX_RECIPIENTS_PER_REQUEST);
        parts.push({ message: group.message, indexes, numbers: indexes.map((index) => numbers[index] as string) });
      }
      return parts;
    });

    const outcomes: Array<SmsSendOutcome | undefined> = numbers.map(() => undefined);
    let next = 0;
    let stopReason: string | undefined;
    const worker = async (): Promise<void> => {
      while (stopReason === undefined && next < requests.length && next < MAX_PROVIDER_REQUESTS_PER_DISPATCH) {
        const request = requests[next++] as Batch;
        const outcome = await this.sendRequest(request);
        if (!outcome.accepted && outcome.failure !== "recipient") stopReason ??= outcome.reason;
        // The provider returns one `message_id` per request, so only a
        // single-recipient request can honestly carry it as a tracking id.
        const perRecipient = outcome.accepted && request.indexes.length > 1 ? { accepted: true } : outcome;
        for (const index of request.indexes) outcomes[index] = perRecipient;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, worker));

    const unsent = outcomes.filter((outcome) => outcome === undefined).length;
    if (unsent > 0) {
      console.warn(
        JSON.stringify({
          provider: "whiteinfobd",
          event: "recipients_not_attempted",
          recipientCount: numbers.length,
          requests: requests.length,
          unsent,
          stopReason,
        }),
      );
    }
    const notAttempted: SmsSendOutcome = {
      accepted: false,
      reason:
        stopReason === undefined
          ? `WhiteInfoBd request budget (${MAX_PROVIDER_REQUESTS_PER_DISPATCH}) used up; not attempted`
          : `WhiteInfoBd not attempted after an earlier failure: ${stopReason}`,
      failure: "provider",
    };
    return outcomes.map((outcome) => outcome ?? notAttempted);
  }

  /** Never throws: a transport failure becomes a declined outcome. */
  private async sendRequest(request: Batch): Promise<SmsSendOutcome> {
    const recipientCount = request.numbers.length;
    console.log(
      JSON.stringify({ provider: "whiteinfobd", event: "sending", recipientCount, messageLength: request.message.length }),
    );

    let raw: Record<string, unknown>;
    try {
      raw = await postProviderJson(
        "WhiteInfoBd",
        SMS_URL,
        JSON.stringify({ sender_id: this.senderId, numbers: request.numbers.join(","), body: request.message }),
        {
          "Content-Type": "application/json",
          Accept: "application/json",
          // Header rather than the documented `api_key` field, so the key
          // never ends up in a URL or request-body log.
          Authorization: `Bearer ${this.apiKey}`,
        },
        providerTimeoutFor(recipientCount),
        // Refusals arrive as 4xx with `{status, code, message}`; the code
        // decides whether the recipient or the account is at fault.
        { jsonRefusals: true },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        JSON.stringify({
          provider: "whiteinfobd",
          event: "request_failed",
          recipientCount,
          reason,
          detail: detailOf(err),
        }),
      );
      return { accepted: false, reason, failure: failureOf(err) };
    }

    const code = Number(raw.code);
    if (code === ACCEPTED_CODE) {
      const trackingId =
        typeof raw.message_id === "string"
          ? raw.message_id
          : typeof raw.batch_id === "number" || typeof raw.batch_id === "string"
            ? String(raw.batch_id)
            : undefined;
      console.log(
        JSON.stringify({ provider: "whiteinfobd", event: "accepted", recipientCount, trackingId, status: raw.status }),
      );
      return { accepted: true, trackingId };
    }

    const reason = typeof raw.message === "string" && raw.message ? raw.message : `code=${String(raw.code)}`;
    console.warn(
      JSON.stringify({
        provider: "whiteinfobd",
        event: "declined",
        code: raw.code,
        reason,
        recipientCount,
        // A reason in a field we don't model would otherwise leave no trace.
        bodyKeys: Object.keys(raw),
      }),
    );
    return {
      accepted: false,
      reason,
      failure: code === INVALID_NUMBER_CODE && recipientCount === 1 ? "recipient" : "provider",
    };
  }
}
