# Context — SMS Worker

Glossary of the domain language for this service. Terms here are canonical;
code, API fields, and UI labels use these words.

## Terms

- **App** — An external service registered with the worker (e.g. the acadion
  backend). Authenticates with an API Key. Owns its provider preferences,
  templates, masking profiles, and send history.
- **Admin** — A human operator who logs into the worker's UI to manage apps,
  providers, and view history. Changing an Admin's password signs out their
  other sessions.
- **API Key** — Opaque bearer token (`sk_...`) issued once at App
  registration; only its hash is stored. Identifies and authenticates an App.
  Rotation and deactivation take effect immediately when D1 is reachable;
  during a D1 outage the last cached auth verdict (≤ 300 s old) is used.
- **Provider** — An external SMS gateway the worker can dispatch through.
  Currently `bulksmsbd` and `mimsms`. Disabling a Provider globally is a kill
  switch: no App dispatches through it, whatever its own Priority says.
- **Priority** — Per-App ordering of enabled Providers. Dispatch tries
  Providers in priority order.
- **Masking Profile** — A per-App override of a Provider's credentials and
  sender identity (sender id/name, API key), used when an App has bought SMS
  masking from a Provider. Absent a profile, the global Provider credentials
  (encrypted in D1, managed at Admin → Providers) are used — unless the
  request sets `maskingStrict`, which leaves such Providers out instead.
- **Send** — A synchronous dispatch request: one message (or per-recipient
  messages), processed inline in the HTTP request, immediate result.
- **Job** — An asynchronous bulk dispatch. Accepted with `202 + jobId`,
  payload parked in R2, work performed by the queue consumer. Split into
  Chunks.
- **Chunk** — A slice of a Job's recipients; the unit of queue delivery and
  idempotency, processed in Send Rounds. A message for a round the Chunk is
  no longer in (or for a finished Chunk) is skipped.
- **Send Round** — One dispatch pass over a Chunk's still-pending
  recipients. Round 0 covers all of them; recipients that fail retryably are
  carried into the next round after a backoff, up to 4 rounds. Each round's
  results are checkpointed so a redelivery replays rather than re-sends.
- **Dispatch** — The provider-failover loop: try each enabled Provider in
  Priority order until a recipient is accepted. At-least-once by design: an
  ambiguous transport failure falls through to the next Provider. Providers
  that keep failing at the transport level are tried last for a minute.
- **Failure kind** — Why a Provider attempt didn't accept a recipient:
  `transport` (no definitive answer — the SMS may or may not have gone out),
  `provider` (refused for a reason on the Provider's side: account, balance,
  sender config), `recipient` (this recipient rejected, e.g. invalid number).
  A recipient is **retryable** when any Provider failed it with `transport`
  or `provider`.
- **Reaper** — The cron step that re-enqueues Chunks with no progress for
  2 hours and force-finishes them after 3 re-enqueues, so every Job reaches a
  terminal status.
- **Idempotency Key** — Client-chosen `Idempotency-Key` header on a Send or
  Job; a repeat within 24 h replays the original response instead of
  dispatching again.
- **Daily Quota** — Optional per-App cap on recipients per UTC day across
  Sends and Jobs; requests that would exceed it are rejected with 429.
- **Message** — The per-recipient history record of one attempted delivery:
  recipient (as the caller sent it), Provider used, status, reason, tracking
  id, timestamps.
- **Tracking ID** — The Provider's own id for an accepted message
  (`message_id` / `trackingId`), stored when available.
- **Template** — App-owned stored message text containing `%PLACEHOLDER%`
  tokens, rendered per recipient when a Send or Job references it by id. A
  placeholder with no supplied variable renders as an empty string. A
  recipient's own `message` wins over the template, which wins over the
  request-level `message`.
- **Recipient** — A phone number as supplied by the App. Validated with
  `^\+?[0-9]{11,14}$`; never normalized centrally — each Provider adapts the
  number to its own wire format (MimSms requires `880...`).

## Statuses

- **Message status**: `sent` | `failed`.
- **Job status**: `queued` | `running` | `completed` | `completed_with_errors`
  | `failed`.
- **Chunk status**: `pending` (in some Send Round) | `done`.
