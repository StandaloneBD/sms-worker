# sms-worker

Standalone SMS gateway on Cloudflare Workers. Any backend ("App") registers
once, gets an API key, and sends SMS through a provider-failover pipeline
(BulkSMSBD → MiMSMS by default) with per-recipient history in D1, bulk jobs
via Queues + R2, `%TOKEN%` templating, per-app provider priorities, and
per-app masking profiles (custom sender identity / credentials).

Domain language: [CONTEXT.md](./CONTEXT.md). Key decisions:
[docs/adr/](./docs/adr/).

## Architecture

- **Hono** API (`/v1/*`, bearer `sk_...` keys) + server-rendered **admin UI**
  (`/admin`, session cookie).
- **D1** (drizzle-orm) — apps, providers, masking profiles, templates, jobs,
  chunks, per-recipient message history (90-day retention via nightly cron).
- **Queues** — a bulk job is split into 250-recipient chunks; each queue
  message is only `{jobId, chunkIndex}`; the payload lives in **R2**
  (ADR 0001). Failed chunks retry with exponential backoff, then dead-letter
  to `sms-dlq` where they're recorded as failed.
- **KV** — fallback cache for app auth + provider config. D1 is read first
  when reachable; warm caches can keep plain-message sends available during
  an outage (template lookup and bulk submission still require D1).
- **Cron** — retries unfinished queue publication every minute, and purges
  retained history and job payloads nightly. A bounded R2 scan also removes
  orphan payloads older than 90 days while protecting active jobs.

## Setup

Use Node.js 22 or newer for the Cloudflare tooling.

```sh
npm ci

# 1. Create resources (once)
npx wrangler d1 create sms-worker           # put database_id into wrangler.jsonc
npx wrangler kv namespace create CACHE      # put id into wrangler.jsonc
npx wrangler r2 bucket create sms-worker-payloads
npx wrangler queues create sms-jobs
npx wrangler queues create sms-dlq

# 2. Migrations
npm run db:migrate:local     # local dev
npm run db:migrate:remote    # production D1

# 3. Secrets (production)
npx wrangler secret put ENCRYPTION_KEY           # any long random string
npx wrangler secret put SESSION_SECRET           # any long random string
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD

# 4. Run / deploy
npm run dev                  # local (FAKE_SMS=true via .dev.vars)
npm run deploy               # deploys to sms.shihabmridha.com
```

First admin login: username `admin` + the `ADMIN_BOOTSTRAP_PASSWORD` value
(only works while no admin exists; change the password in Settings after).
Register an App in the UI — the API key is shown exactly once.

### Updating an existing installation

Apply `drizzle/0002_delivery_recovery.sql` before deploying this version
(`npm run db:migrate:remote`). It adds the durable queue publication marker
and job-list/retention indexes. Existing job data is preserved; unfinished
bulk jobs without a publication marker are recovered by the minute cron.
Publishing again can duplicate in-flight chunks, consistent with the
at-least-once delivery contract. Existing admin sessions require signing in
again because signatures now include the current password hash.

The D1 and KV identifiers in the checked-in config are placeholders: replace
them with the actual resource identifiers before deployment. The login rate
limiter namespace `3184762001` should be reserved for this Worker on the
target account.

### 5. Provider credentials

Provider credentials are not worker secrets — after first login, open
Admin → Providers and enter each provider's API key and sender identity
(sender id for BulkSMSBD; username + sender name for MiMSMS). They're stored
AES-GCM-encrypted in D1 (`ENCRYPTION_KEY`) and changes apply immediately.
Local dev runs with `FAKE_SMS=true`, so no credentials are needed; to hit
real providers locally, set `FAKE_SMS=false` in `.dev.vars` and enter
credentials in the UI.

## API

`Authorization: Bearer sk_...` on everything.

```sh
# Sync send (OTPs etc., ≤100 recipients, immediate result)
curl -X POST https://sms.shihabmridha.com/v1/sms/send \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -d '{"message": "Your code is 1234", "recipients": ["01712345678"]}'

# Bulk job (≤50,000 recipients, queued) — returns 202 {jobId}
curl -X POST https://sms.shihabmridha.com/v1/sms/jobs \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -d '{"templateId": 1, "recipients": [{"to": "01712345678", "vars": {"NAME": "Rahim"}}]}'

curl https://sms.shihabmridha.com/v1/sms/jobs/<jobId>          # progress
curl https://sms.shihabmridha.com/v1/sms/jobs/<jobId>/messages # per-recipient
```

Also: `/v1/templates` CRUD (`%NAME%` placeholders; missing vars render
empty), `GET|PUT /v1/providers` (per-app enable/priority),
`GET /v1/masking-profiles`. Add `"maskingProfile": "<label>"` to a send/job
to dispatch with that profile's sender identity/credentials.

### Request limits

- `/sms/send`: body ≤ 256 KiB, ≤ 100 recipients.
- `/sms/jobs`: body ≤ 25 MiB, ≤ 50,000 recipients — a job whose per-recipient
  bodies would exceed 25 MiB combined (e.g. 50,000 recipients each near the
  1,000-char message cap) must be split into multiple `/sms/jobs`
  submissions.
- `vars`: at most 20 keys per recipient, each value a string of at most 1,000
  characters.
- An oversized body is rejected before it's read, as `413 {"error": "request
  body too large"}` when Content-Length already exceeds the limit; otherwise
  consumed bytes are counted and reading stops at the limit. Missing or
  inaccurate length headers cannot bypass the cap. Recipient and byte limits
  apply independently; rich `vars` can exceed the cap with fewer recipients.
- Template/provider JSON mutations and admin form submissions: ≤ 64 KiB.
- Bulk `202` means the job and every chunk are recorded durably in D1 and
  its payload is stored in R2. If queue publication fails, the response
  includes a warning and recovery retries pending chunks after roughly
  1–2 minutes (up to 10 jobs per cron invocation). Poll the returned job ID;
  a new submission creates a separate job.
- An uncertain D1 write returns `503` with a `jobId`. Poll that ID before
  resubmitting: the write may have committed, in which case cron recovery
  publishes it. Its R2 payload is preserved until acceptance can be resolved
  or orphan retention removes it.

## Checks

```sh
npm run typecheck
npm run typecheck:test
npm test
npx wrangler deploy --dry-run
```

Tests run in workerd with local D1/KV/R2 bindings, explicit fake SMS and
test-only secrets. They cover the real migration chain, large job creation,
partial queue publication, chunk accounting, provider responses, and admin
session revocation. Local checks do not enforce production CPU budgets or
verify provider accounts; no real SMS is sent by the test suite.

The scoped esbuild override patches Drizzle Kit's deprecated
`@esbuild-kit/core-utils` dependency. The sharp override patches Miniflare's
image decoder dependency. Remove these overrides when the upstream tooling
ships patched versions; migration generation and local Worker tests are
checked with them in place.

## Notes

- Delivery is **at-least-once** end to end (queue redelivery + provider
  failover); duplicates are preferred over silent loss. See CONTEXT.md
  "Dispatch".
- Phone numbers: `^\+?[0-9]{11,14}$`, stored as given; MiMSMS 880-prefixing
  happens inside its adapter only.
- Statement batching (chunk 250, sync cap 100, job cap 50k) respects the
  [Workers Free D1 query/parameter limits](https://developers.cloudflare.com/d1/platform/limits/). Production CPU/memory usage
  still needs measurement, especially for large JSON jobs — see
  `src/shared/constants.ts` before raising these caps.
- API key rotation and app activate/deactivate take effect immediately (D1 is
  authoritative for auth — see ADR 0003). Global provider credential saves
  (ADR 0004) and per-app provider/masking changes made through the UI/API
  purge fallback app caches (KV) on a best-effort basis. Provider settings
  also use D1-first reads, so warm stale KV cannot override healthy D1.
  During D1 outages, cached auth/provider values can remain stale until
  their 5-minute expiry; [KV mutations propagate eventually across locations](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
- [Admin login rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) allows approximately 10 attempts/minute per connecting
  IP per Cloudflare location. Changing a password revokes all older sessions
  and renews the session making the change. Admin/API responses use
  `Cache-Control: no-store`; provider response bodies are capped at 256 KiB
  and both headers and body must arrive before the provider timeout.
