import type {
  DispatchInput,
  DispatchPlanEntry,
  DispatchResultItem,
  ISmsProvider,
  SmsDynamicMessage,
  SmsSendOutcome,
} from "../shared/types";
import { MAX_REASON_LENGTH } from "../shared/constants";

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
 * Never throws for provider failures: returns an aggregated soft failure per
 * unresolved recipient so callers decide how loud to be. The result is
 * always the same length and order as the input recipients.
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
  let pending = recipients.map((_, index) => index);

  for (const entry of entries) {
    if (pending.length === 0) break;

    let results: SmsSendOutcome[];
    try {
      results = await attempt(entry.provider, input, pending);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const index of pending) {
        reasons[index]?.push(reason.slice(0, MAX_REASON_LENGTH));
      }
      continue;
    }

    const stillPending: number[] = [];
    for (const [slot, index] of pending.entries()) {
      // A provider returning fewer outcomes than recipients would otherwise
      // read as `undefined` here and silently drop the recipient because
      // `noUncheckedIndexedAccess` surfaces that as a real possibility.
      const outcome = results.at(slot);
      if (!outcome) {
        reasons[index]?.push("provider returned no outcome");
        stillPending.push(index);
        continue;
      }
      if (outcome.accepted) {
        outcomes[index] = outcome;
        acceptedBy[index] = entry.provider.name;
        continue;
      }
      reasons[index]?.push((outcome.reason ?? "provider declined").slice(0, MAX_REASON_LENGTH));
      stillPending.push(index);
    }
    pending = stillPending;
  }

  return outcomes.map((outcome, index) => {
    // Same length as `recipients` by construction (both derived from it at
    // the top of this function), so this index is always in bounds.
    const to = recipients[index] as string;
    if (outcome) {
      return { ...outcome, to, provider: acceptedBy[index] ?? null };
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
