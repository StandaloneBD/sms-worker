# 0006: Per-App IP Allowlist on Write Requests

Status: accepted (2026-10-22)

## Context

A leaked API Key can send SMS on the App's account from anywhere, bounded
only by the rate limit and the Daily Quota. Most Apps call the worker from a
few fixed servers, so tying the key to their addresses shrinks what a leak
can do. The original ask was an IPv4 allowlist on the send API only, with an
on/off switch.

## Decision

**Scope: Write Requests, not just sends.** The IP Allowlist applies to
every non-`GET`/`HEAD` request under `/v1`: `POST /sms/send`,
`POST /sms/jobs`, Template create/update/delete and `PUT /providers`.
Editing a Template changes what a template Send delivers, and the provider
plan decides who carries it, so leaving those open would let a leaked key
change sends from outside the list. Reads stay open, so dashboards and
monitoring on other hosts keep working.

**Caller address: `CF-Connecting-IP`.** Cloudflare sets it and clients
can't override it. `X-Forwarded-For` is client-controlled and never
consulted. A request without the header is refused.

**IPv4, IPv6 and CIDR ranges.** A dual-stack server usually reaches
Cloudflare over IPv6, so an IPv4-only list would block servers the admin
believes are listed. Entries are saved in one standard form (host bits
cleared, `/32` and `/128` dropped, `::ffff:a.b.c.d` as `a.b.c.d`) so
equivalent spellings are one entry. An IPv6 range never matches an IPv4
caller: `::/0` is not allow-all.

**Checked before the rate limit and `Idempotency-Key`.** The middleware
runs right after auth. A refused caller can't spend the App's rate limit
(locking out its real servers) or claim or replay an Idempotency Key.

**Stored on the `apps` row and carried in the auth verdict.** Two columns,
`ip_allowlist_enabled` and `ip_allowlist` (JSON). Auth already reads that
row on every request (ADR 0003), so the check costs no extra D1 read. The
effective list, present only while the switch is on, is part of the
`AuthedApp` verdict cached in KV, so the allowlist still holds during a D1
outage. Saving it in the admin UI overwrites the cache entry, like a Daily
Quota change.

**Refusal: `403 {"error": "ip not allowed", "ip": "<caller address>"}`.**
Echoing the caller's own address leaks nothing and tells them what to add.

## Considered options

- **Allowlist on reads too.** Rejected for now: it would break read-only
  callers on other hosts. The cost is that a leaked key can still read
  Message history, including rendered template bodies such as OTP codes,
  from anywhere. Covering `GET /sms/jobs/:id/messages` is the obvious next
  step if that matters.
- **A separate `app_allowed_ips` table.** Rejected: one more D1 read on
  every Write Request, and nothing per entry (labels, audit trail) is needed
  yet.

## Consequences

- An App whose egress address changes (cloud NAT, autoscaling) is refused
  until the list is updated; the 403 names the address it saw.
- Auth cache entries written before this change carry no list, so they read
  as "off" until the next successful auth rewrites them. That only matters
  if D1 is down right after the deploy.
- Jobs accepted before the allowlist is switched on still dispatch: the
  check happens at acceptance, not in the queue consumer.
- Each list is capped at `MAX_IP_ALLOWLIST_ENTRIES` (100) entries, all of
  which are checked on every Write Request.
