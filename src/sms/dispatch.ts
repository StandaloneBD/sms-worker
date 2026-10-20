import type {
  DispatchInput,
  DispatchPlanEntry,
  DispatchResultItem,
  ISmsProvider,
  SmsDynamicMessage,
  SmsSendOutcome,
} from "../shared/types";
import { MAX_REASON_LENGTH } from "../shared/constants";
import { detailOf } from "./errors";
import { orderByHealth, recordReachable, recordTransportFailure } from "./health";

/**
 * Ported from acadion's SmsService.ts (the provider-failover composite),
 * turned from a class into a function over a priority-ordered provider list.
 *
 * Try providers in order until every recipient is accepted, retrying only the
 * recipients still outstanding. Both a soft decline (`accepted: false`) and a
 * thrown transport error fall through to the next provider — at-least-once
 * delivery (see CONTEXT.md "Dispatch"). A thrown error is ambiguous (the SMS
 * may already have been sent), so failover can produce a duplicate; that
 * trade-off is accepted so a flaky primary never silently drops a message.
 * Providers that batch internally confine a throw to the chunk that actually
 * failed, which keeps the duplicate blast radius to that chunk rather than
 * the whole send.
 *
 * Providers whose circuit breaker is open (see health.ts) are tried last.
 *
 * Never throws for provider failures: returns an aggregated soft failure per
 * unresolved recipient so callers decide how loud to be, flagged `retryable`
 * when any provider failed it for a transport or provider-side reason (so a
 * later attempt could succeed) rather than rejecting the recipient itself.
 * The result is always the same length and order as the input recipients.
 */
export async function dispatch(
  entries: DispatchPlanEntry[],
  input: DispatchInput,
): Promise<DispatchResultItem[]> {
  const recipients: string[] =
    input.kind === "uniform" ? input.recipients : input.messages.map((entry) => entry.to);

  if (recipients.length === 0) return [];

  const outcomes: Array<SmsSendOutcome | null> = recipients.map(() => null);
  const acceptedBy: Array<ISmsProvider["name"] | null> = recipients.map(() => null);
  // Reasons are tracked per recipient, not in one shared list: a caller
  // reporting a single failed recipient must not be handed the reasons that
  // belong to everyone else in the batch.
  const reasons: string[][] = recipients.map(() => []);
  const retryable: boolean[] = recipients.map(() => false);
  let pending = recipients.map((_, index) => index);

  for (const entry of orderByHealth(entries)) {
    if (pending.length === 0) break;
    const name = entry.provider.name;

    let results: SmsSendOutcome[];
    try {
      results = await attempt(entry.provider, input, pending);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({ provider: name, event: "provider_threw", recipientCount: pending.length, reason, detail: detailOf(err) }),
      );
      for (const index of pending) {
        reasons[index]?.push(reason.slice(0, MAX_REASON_LENGTH));
        retryable[index] = true;
      }
      recordTransportFailure(name);
      continue;
    }

    const stillPending: number[] = [];
    let answered = false;
    for (const [slot, index] of pending.entries()) {
      // A provider returning fewer outcomes than recipients would otherwise
      // read as `undefined` here and silently drop the recipient because
      // `noUncheckedIndexedAccess` surfaces that as a real possibility.
      const outcome = results.at(slot);
      if (!outcome) {
        reasons[index]?.push("provider returned no outcome");
        retryable[index] = true;
        stillPending.push(index);
        continue;
      }
      if (outcome.accepted || outcome.failure !== "transport") answered = true;
      if (outcome.accepted) {
        outcomes[index] = outcome;
        acceptedBy[index] = name;
        continue;
      }
      reasons[index]?.push((outcome.reason ?? "provider declined").slice(0, MAX_REASON_LENGTH));
      if (outcome.failure !== "recipient") retryable[index] = true;
      stillPending.push(index);
    }
    if (answered) recordReachable(name);
    else recordTransportFailure(name);
    pending = stillPending;
  }

  return outcomes.map((outcome, index) => {
    // Same length as `recipients` by construction (both derived from it at
    // the top of this function), so this index is always in bounds.
    const to = recipients[index] as string;
    if (outcome) {
      return { ...outcome, to, provider: acceptedBy[index] ?? null, retryable: false };
    }
    const failures = reasons[index] ?? [];
    return {
      accepted: false,
      to,
      provider: null,
      reason:
        failures.length > 0
          ? `All SMS providers failed: ${failures.join("; ")}`.slice(0, MAX_REASON_LENGTH)
          : "No SMS providers configured",
      retryable: retryable[index] ?? false,
    };
  });
}

function attempt(
  provider: ISmsProvider,
  input: DispatchInput,
  pending: number[],
): Promise<SmsSendOutcome[]> {
  if (input.kind === "uniform") {
    // Indices in `pending` are always < input.recipients.length: they are
    // seeded from `recipients` (derived from input.recipients for uniform
    // sends) and only ever narrowed, never widened, across rounds.
    const subset = pending.map((index) => input.recipients[index] as string);
    return provider.send(subset, input.message);
  }
  const subset = pending.map((index) => input.messages[index] as SmsDynamicMessage);
  return provider.sendDynamic(subset);
}

/**
 * Builds the dispatch input for a list of resolved sends: "uniform" (one
 * body, one-to-many endpoint) whenever every body is identical, otherwise
 * "dynamic". Shared by the sync route and the queue consumer.
 */
export function toDispatchInput(sends: ReadonlyArray<{ to: string; body: string }>): DispatchInput {
  const first = sends[0];
  if (first && sends.every((send) => send.body === first.body)) {
    return { kind: "uniform", message: first.body, recipients: sends.map((send) => send.to) };
  }
  return { kind: "dynamic", messages: sends.map((send) => ({ to: send.to, message: send.body })) };
}
