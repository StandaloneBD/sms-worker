/**
 * Provider circuit breaker, kept in isolate memory. When a provider's
 * attempts keep ending in transport failures (timeouts, 5xx, network), every
 * dispatch would otherwise wait out its full 10–30 s timeout before failing
 * over. After BREAKER_FAILURE_THRESHOLD such attempts in a row the provider
 * is moved to the back of the order for BREAKER_OPEN_SECONDS — demoted, not
 * removed, so it is still tried when everything ahead of it fails.
 *
 * Isolate-local on purpose: it costs no storage round trip on the send path
 * and each isolate learns within a few requests. A provider that answers at
 * all (accepting or declining) is reachable and resets its streak.
 */

import { BREAKER_FAILURE_THRESHOLD, BREAKER_OPEN_SECONDS } from "../shared/constants";

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

const states = new Map<string, BreakerState>();

export function isBreakerOpen(provider: string, now = Date.now()): boolean {
  const state = states.get(provider);
  return state !== undefined && state.openUntil > now;
}

export function recordTransportFailure(provider: string, now = Date.now()): void {
  const state = states.get(provider) ?? { consecutiveFailures: 0, openUntil: 0 };
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD && state.openUntil <= now) {
    state.openUntil = now + BREAKER_OPEN_SECONDS * 1000;
    console.warn(
      JSON.stringify({
        event: "provider_circuit_open",
        provider,
        consecutiveFailures: state.consecutiveFailures,
        openSeconds: BREAKER_OPEN_SECONDS,
      }),
    );
  }
  states.set(provider, state);
}

export function recordReachable(provider: string): void {
  states.delete(provider);
}

/** Providers with a closed breaker first, open ones after; priority order is
 *  kept within each group. */
export function orderByHealth<T extends { provider: { name: string } }>(entries: T[], now = Date.now()): T[] {
  const closed = entries.filter((entry) => !isBreakerOpen(entry.provider.name, now));
  if (closed.length === entries.length) return entries;
  return [...closed, ...entries.filter((entry) => isBreakerOpen(entry.provider.name, now))];
}
