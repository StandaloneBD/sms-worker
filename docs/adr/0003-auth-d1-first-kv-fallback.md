# 0003: Auth reads are D1-first, KV-fallback

Status: accepted (2026-08-31)

Note: ADR 0001 and 0002 exist in this repo only as inline code comments
(`src/shared/types.ts`, `src/shared/constants.ts`, `src/core/plan.ts`,
`src/queue/consumer.ts`, `src/api/sms.ts`), which README links to as
`docs/adr/`. This is the first ADR written to disk; 0001/0002 are referenced
below by their one-line intent as quoted in those comments, not reproduced
in full.

## Context

`authMiddleware` (`src/api/auth.ts`) was KV-cache-first: on a warm
`app:key:<sha256>` entry it never consulted D1, so a rotated or deactivated
key kept authenticating for up to `KV_TTL_SECONDS` (300s). Neither the
key-rotation nor the deactivate/activate admin action touched KV, so nothing
purged a warm entry either — the staleness window was unconditional, not
just an outage fallback.

This traded a real security property (immediate revocation) for a benefit
that ADR 0002 (`src/core/plan.ts`: "the cache is an availability shield — a
warm cache lets sends proceed through a D1 outage") never asked for on the
*auth* path: dispatch-config caching exists so sends survive a D1 outage,
but there is no requirement that stale credentials keep authenticating
during normal operation.

## Decision

Invert the read order for `authMiddleware`: D1 is authoritative whenever
it's reachable; KV is only the outage fallback.

- Hash the bearer token, read the KV entry once (swallow KV errors, same as
  before), then query D1 by key hash regardless of whether KV was warm.
- D1 responds → that row wins: no row is 401, otherwise `{id, name,
  isActive}` is the verdict. Refresh KV only when the cached value is
  missing or differs from the fresh verdict, via `waitUntil`, to keep writes
  rare (Workers Free: 1,000 KV writes/day).
- D1 throws → fall back to the warm KV value if present (same shape as ADR
  0002's shield); no warm value → 503, unchanged from before.
- `appRotateKeyPost` invalidates the *old* key hash's cache entry, awaited,
  so the response implies completion.
- `appActivePost` overwrites (not deletes) the cache entry with the new
  `isActive`, so a request landing during a D1 outage right after
  deactivation gets 403 (correct) instead of a stale 200 or an unrelated 503.

Cost: +1 D1 point read per API request. Within the existing per-request D1
budget (`src/shared/constants.ts`); D1 read capacity is not the constrained
resource here, KV write count is.

## Consequences

- Key rotation and app activate/deactivate take effect on the very next
  request whenever D1 is reachable — no more 300s revocation window.
- The D1-outage shield from ADR 0002 is preserved unchanged: a warm cache
  still lets previously-authenticated apps through when D1 is down.
- A D1 outage immediately after a rotation/deactivation still serves the
  *old* cached verdict for the deactivate case only if the overwrite/delete
  itself raced the outage; the delete-then-outage case correctly fails to
  503 rather than resurrecting the old key.
- One extra KV read remains on every request (to know whether a refresh is
  needed); KV writes stay bounded to actual changes instead of every
  request.

## Amendment (2026-11-16): refresh before expiry

Entries carry a TTL (`AUTH_CACHE_TTL_SECONDS`), and the KV read moved off
the request path: each isolate re-reads an entry at most every half TTL.
Trusting an entry for half a TTL after merely reading it left the shield
missing for up to that long whenever the read happened near expiry. Each
write now stores `writtenAt` as KV metadata; the refresh rewrites an entry
that is missing, differs, or expires within a sixth of the TTL, and trusts
it only until that point. Cost: about one KV write per key per
five-sixths of a TTL while the key is in use.
