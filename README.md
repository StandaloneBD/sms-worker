# sms-worker

Standalone SMS gateway on Cloudflare Workers. Any backend ("App") registers
once, gets an API key, and sends SMS through a provider-failover pipeline
(BulkSMSBD → MiMSMS by default) with per-recipient history in D1, bulk jobs
via Queues + R2 with retries for provider outages, `%TOKEN%` templating,
per-app provider priorities, per-app masking profiles (custom sender
identity / credentials), idempotency keys, and per-app rate limits and
daily quotas.

Domain language: [CONTEXT.md](./CONTEXT.md). Key decisions:
[docs/adr/](./docs/adr/).

## Architecture

- **Hono** API (`/v1/*`, bearer `sk_...` keys) + server-rendered **admin UI**
  (`/admin`, session cookie).
- **D1** (drizzle-orm) — apps, providers, masking profiles, templates, jobs,
  chunks, per-recipient message history (90-day retention), idempotency
  keys, daily usage counters.
- **Queues + R2** — a bulk job is split into 250-recipient chunks, written
  to R2 as one NDJSON line per chunk; each queue message is
  `{jobId, chunkIndex, round}` and the consumer reads only its chunk's line
  (ranged GET). Recipients that fail for a transport or provider-side reason
  are retried in later send rounds (60 s, 120 s, 240 s); each round's results
  are checkpointed to R2 so a redelivery never sends them twice (ADR 0005).
  Infrastructure errors retry with backoff, then dead-letter to `sms-worker-dlq`.
- **Cron (every 15 min)** — re-enqueues stalled chunks (and fails them after
  3 tries) so every job finishes, then purges a bounded slice of expired
  history, jobs, idempotency keys and usage rows.
- **KV** — cache for app auth + provider config, so sends survive a D1
  outage (ADR 0002: sending outranks record-keeping).

## Setup

### 1. Resources

Created once per Cloudflare account; `wrangler.jsonc` already points at them.

| Binding     | Resource                          | Name                              |
| ----------- | --------------------------------- | --------------------------------- |
| `DB`        | D1 database                       | `sms-worker`                      |
| `CACHE`     | KV namespace                      | `sms-worker`                      |
| `PAYLOADS`  | R2 bucket                         | `sms-worker`                      |
| `SMS_QUEUE` | Queue (producer + consumer)       | `sms-worker-job`                  |
| —           | Dead-letter queue (consumer)      | `sms-worker-dlq`                  |

```sh
npx wrangler d1 create sms-worker            # put database_id into wrangler.jsonc
npx wrangler kv namespace create sms-worker  # put id into wrangler.jsonc
npx wrangler r2 bucket create sms-worker
npx wrangler queues create sms-worker-job
npx wrangler queues create sms-worker-dlq    # keep the "-dlq" suffix if renamed
# Backstop for job objects whose cleanup failed (normally deleted on completion)
npx wrangler r2 bucket lifecycle add sms-worker expire-jobs jobs/ --expire-days 7
```

The Worker is served only on the custom domain `sms.shihabmridha.com`
(`workers_dev` and `preview_urls` are off), so the zone must be on the same
account.

### 2. Migrations

Run before deploying any commit that adds a file under `drizzle/` — new code
expects the new schema. The Git build token has no D1 access, so this is a
manual step.

```sh
npm run db:migrate:remote    # production D1
```

### 3. Secrets

Runtime secrets on the `sms-worker` Worker. Sign-in and provider calls fail
while they're missing; `ENCRYPTION_KEY` and `SESSION_SECRET` must be at least
16 characters (long random strings).

| Secret                     | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `ENCRYPTION_KEY`           | Encrypts provider API keys stored in D1              |
| `SESSION_SECRET`           | Signs admin session cookies                          |
| `ADMIN_BOOTSTRAP_PASSWORD` | First admin sign-in (only while no admin exists)     |

```sh
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD
npx wrangler secret list     # all three names should be listed
```

Or in the dashboard: Workers & Pages → sms-worker → Settings → Variables and
Secrets → Add, type **Secret**, then click **Deploy** — nothing is saved until
you do. Don't use the Build variables section: build variables are not
available to the Worker at runtime. Secrets persist across deploys; changing
`ENCRYPTION_KEY` makes stored provider keys unreadable, and changing
`SESSION_SECRET` signs every admin out.

### 4. Deploy

Deploys run from GitHub through Workers Builds (Worker → Settings → Build):

| Setting                       | Value                               |
| ----------------------------- | ----------------------------------- |
| Build command                 | `npm run typecheck && npm test`     |
| Deploy command                | `npx wrangler deploy`               |
| Root directory                | `/`                                 |
| Non-production branch builds  | Off                                 |

Pushing to `master` deploys. Dependencies are installed from the lockfile
automatically. Branch builds stay off: their Previews would share the
production D1, queues and bucket. To deploy by hand instead:
`npm run deploy`.

First admin login: username `admin` + the `ADMIN_BOOTSTRAP_PASSWORD` value
(only works while no admin exists; change the password in Settings after).
Register an App in the UI — the API key is shown exactly once.

### Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # FAKE_SMS=true: no provider calls
npm run db:migrate:local
npm run dev                      # http://localhost:8787/admin
```

The admin session cookie is `__Host-` prefixed (Secure only); Chrome and
Firefox accept it on `http://localhost`, Safari may not.

### 5. Provider credentials

Provider credentials are not worker secrets — after first login, open
Admin → Providers and enter each provider's API key and sender identity
(sender id for BulkSMSBD; username + sender name for MiMSMS). They're stored
AES-GCM-encrypted in D1 (`ENCRYPTION_KEY`) and changes apply immediately.
Disabling a provider there is a kill switch: no app dispatches through it,
whatever its own provider plan says.
Local dev runs with `FAKE_SMS=true`, so no credentials are needed; to hit
real providers locally, set `FAKE_SMS=false` in `.dev.vars` and enter
credentials in the UI.

### 6. Configuration (`wrangler.jsonc`)

- `CORS_ORIGINS` — browser origins allowed to call `/v1` (comma-separated),
  `*` for any, empty for none. The API is server-to-server; any key used from
  a browser is readable by that page's visitors, so list only origins that
  truly need it.
- `ratelimits` — `SEND_LIMITER` (per app, send/job requests per minute) and
  `LOGIN_LIMITER` (per IP, admin sign-in attempts per minute).
- Queue consumer `max_concurrency` caps parallel chunk sends (provider rate
  limits, D1 write contention).
- `assets` — files in `public/` (admin scripts, favicon) are served as
  Workers Static Assets without invoking the Worker, so they don't count
  toward Worker requests. Their response headers go in `public/_headers`.

## API

`Authorization: Bearer sk_...` on everything.

```sh
# Sync send (OTPs etc., ≤100 recipients, immediate result)
curl -X POST https://sms.shihabmridha.com/v1/sms/send \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: otp-7f3a91" \
  -d '{"message": "Your code is 1234", "recipients": ["01712345678"]}'

# Bulk job (≤50,000 recipients, queued) — returns 202 {jobId}
curl -X POST https://sms.shihabmridha.com/v1/sms/jobs \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: fee-reminder-2026-10" \
  -d '{"templateId": 1, "recipients": [{"to": "01712345678", "vars": {"NAME": "Rahim"}}]}'

curl https://sms.shihabmridha.com/v1/sms/jobs/<jobId>          # progress
curl https://sms.shihabmridha.com/v1/sms/jobs/<jobId>/messages # per-recipient
```

`/messages` pages newest first (`limit` 1-200, default 50). Page with
`?before=<nextBefore>`: each response carries `nextBefore`, the cursor for
the next page, and it is `null` once a page comes back short. Each cursor
page costs only `limit` rows however deep it is. `?offset=` still works,
but each page reads every row before it too, so a large job costs far
more to walk that way. `offset` is ignored when `before` is given.

Each recipient's body is its own `message` if given, else the rendered
template, else the request-level `message`.

Sync results are `{to, accepted, provider, reason, trackingId, retryable}`
per recipient. `retryable: true` means some provider failed it for a
transport or provider-side reason (not a rejected number), so retrying
later may succeed.

Also: `/v1/templates` CRUD (`%NAME%` placeholders; missing vars render
empty), `GET|PUT /v1/providers` (per-app enable/priority, within the
globally enabled providers), `GET /v1/masking-profiles`. Add
`"maskingProfile": "<label>"` to a send/job to dispatch with that profile's
sender identity/credentials — an unknown label is a 400. Providers without
that profile fall back to the global sender identity unless
`"maskingStrict": true`, which leaves them out of the chain.

### Idempotency

Send `Idempotency-Key: <1-255 chars>` on `/sms/send` and `/sms/jobs` to make
retries safe. A repeat with the same key and body within 24 h returns the
original response (header `Idempotent-Replayed: true`) instead of sending
again; 409 while the first request is still running; 422 if the key was used
for a different body. Failed (non-2xx) requests don't keep the key.

### Request limits

- `/sms/send`: body ≤ 256 KiB, ≤ 100 recipients.
- `/sms/jobs`: body ≤ 25 MiB, ≤ 50,000 recipients — a job whose per-recipient
  bodies would exceed 25 MiB combined (e.g. 50,000 recipients each near the
  1,000-char message cap) must be split into multiple `/sms/jobs`
  submissions.
- `vars`: at most 20 keys per recipient, each value a string of at most 1,000
  characters.
- An oversized body is rejected before it's read, as `413 {"error": "request
  body too large"}`.
- Send/job requests per app are rate limited (`429`), and an app with a
  daily quota (Admin → Apps) gets `429` once its recipients for the UTC day
  would exceed it.

## Notes

- Delivery is **at-least-once** end to end (provider failover, send rounds,
  queue redelivery); duplicates are preferred over silent loss, and are
  confined to a crash during a send itself. See CONTEXT.md "Dispatch" and
  ADR 0005.
- Phone numbers: `^\+?[0-9]{11,14}$`, stored as given; MiMSMS 880-prefixing
  happens inside its adapter only.
- Sizing constants (chunk 250, sync cap 100, job cap 50k) are tuned for
  **Workers Free** limits — see `src/shared/constants.ts` before raising.
- API key rotation, app activate/deactivate and quota changes take effect
  immediately (D1 is authoritative for auth — see ADR 0003). Global provider
  credential saves (ADR 0004) and per-app provider/masking changes made
  through the UI/API invalidate app caches (KV) instantly; anything else
  refreshes within 5 minutes.
- Changing an admin password signs out that admin's other sessions.
