# 0007: Providers without a many-to-many endpoint

Status: accepted (2026-11-16)

## Context

BulkSMSBD and MiMSMS each take a list of `{number, message}` pairs in one
request, so a dynamic send (per-recipient bodies, e.g. a rendered template)
costs one request per 1,000 recipients. WhiteInfoBD only sends one body to
one or more comma-separated numbers per request. A dynamic send through it
needs a request per distinct body: up to 250 for a Job Chunk, up to 100 for a
sync Send. Workers Free allows 50 subrequests per invocation, and a request
that dies on that limit is indistinguishable from a transport failure.

## Decision

- The adapter groups recipients by body: recipients that share a body share
  a request (split at 1,000 numbers), so uniform sends stay one request.
- One dispatch call makes at most `MAX_PROVIDER_REQUESTS_PER_DISPATCH` (40)
  requests, leaving room for the rest of the failover chain within 50.
  Requests run 4 at a time so a sync Send doesn't wait out 40 round trips in
  series.
- After the first request that fails for a reason other than its recipient
  (bad key, no balance, IP not whitelisted, timeout, 5xx), no further
  requests are started: they would fail the same way, and against a dead
  provider each would wait out its own timeout.
- Recipients not attempted for either reason are declined with failure kind
  `provider`: definitely not sent, and retryable. Dispatch hands them to the
  next Provider in the plan; in a Job, those still unresolved go into the
  next Send Round (ADR 0005), which runs in a new invocation with a fresh
  budget.

## Consequences

- With WhiteInfoBD ahead of a provider that has a dynamic endpoint, a large
  templated send mostly goes out through the other provider. That is
  intended: it costs one request there instead of hundreds here.
- With WhiteInfoBD as an App's only provider, a templated Chunk delivers at
  most 40 distinct bodies per Send Round, 160 over the 4 rounds; the rest of
  a 250-recipient Chunk fails as retryable. Apps that rely on it alone for
  templated bulk need a provider with a dynamic endpoint behind it, or a
  Workers Paid plan with the constant raised.
- A sync Send's per-recipient `reason` names the budget or the earlier
  failure, so a caller can tell "not attempted" from "refused".
