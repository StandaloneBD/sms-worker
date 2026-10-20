/**
 * Sizing constants. Several are pinned by Workers FREE plan limits
 * (50 D1 queries + 50 subrequests per invocation, 10ms CPU) — see comments
 * before raising them. On Workers Paid these can grow substantially.
 */

/** Recipients per queue chunk. 250 → ~25 batched D1 insert statements. */
export const CHUNK_SIZE = 250;

/** Hard cap on recipients per bulk Job (v1 guardrail, Q21). */
export const MAX_JOB_RECIPIENTS = 50_000;

/** Sync /send cap; bigger sends must use the job path. */
export const MAX_SYNC_RECIPIENTS = 100;

/**
 * Max accepted JSON body for a sync /sms/send request. Derived from the
 * worst legitimate shape: MAX_SYNC_RECIPIENTS (100) recipients, each up to
 * ~1 KB of message text (MAX_MESSAGE_LENGTH) plus its `to` string and a
 * bounded `vars` object (MAX_VARS_KEYS × MAX_VAR_VALUE_LENGTH) — comfortably
 * under 200 KiB with JSON overhead; 256 KiB leaves headroom without opening
 * the door to much larger inline payloads on the synchronous path.
 */
export const MAX_SYNC_BODY_BYTES = 256 * 1024;

/**
 * Max accepted JSON body for job submission (25 MiB). The binding constraint
 * is the Worker isolate's 128 MB total memory, not Cloudflare's own edge
 * limit on request bodies (100 MB on Free/Pro) — the request body must be
 * read, JSON-parsed, and then the same payload written back out via an R2
 * put, all inside that 128 MB alongside everything else the request needs,
 * so the app-level cap is what actually protects the isolate.
 *
 * This does mean the theoretical worst case — MAX_JOB_RECIPIENTS (50,000)
 * recipients each carrying a per-recipient message at MAX_MESSAGE_LENGTH
 * (1,000 chars) — is ~50 MB of message text alone, well over this cap. Such
 * jobs must be split into multiple /sms/jobs submissions; see README.
 */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Message body length cap (matches acadion's contract). */
export const MAX_MESSAGE_LENGTH = 1000;

/** Cap on a stored/returned failure reason. */
export const MAX_REASON_LENGTH = 500;

/** Template name length cap. */
export const MAX_TEMPLATE_NAME_LENGTH = 64;

/** Max distinct keys accepted in one recipient's `vars` object. */
export const MAX_VARS_KEYS = 20;

/** Max length of a single `vars` value; shares the message-body cap since a
 *  rendered template value ends up inline in the message body anyway. */
export const MAX_VAR_VALUE_LENGTH = MAX_MESSAGE_LENGTH;

/** History retention (Q9); enforced by the cron's purge step. */
export const RETENTION_DAYS = 90;

/** Daily-quota usage rows are kept this long (for the admin view), then purged. */
export const USAGE_RETENTION_DAYS = 7;
/** UTC calendar day (YYYY-MM-DD) that daily-quota usage is counted under. */
export const usageDay = (date: Date = new Date()): string => date.toISOString().slice(0, 10);

/** Chunk retry backoff after an infrastructure error (D1/R2 unavailable):
 *  RETRY_BASE_SECONDS * 2^attempt, capped. */
export const RETRY_BASE_SECONDS = 30;
export const RETRY_MAX_SECONDS = 3600;

/** Send rounds per chunk: round 0 plus up to SEND_ROUNDS - 1 retries of the
 *  recipients every provider failed retryably (transport or provider-side,
 *  see FailureKind). Round n ≥ 1 is enqueued with a delay of
 *  SEND_RETRY_BASE_SECONDS * 2^(n-1): 60s, 120s, 240s. */
export const SEND_ROUNDS = 4;
export const SEND_RETRY_BASE_SECONDS = 60;

/** Reaper (cron): a pending chunk with no progress for this long is
 *  re-enqueued. Has to outlast one round's whole queue retry span (≈31 min
 *  of RETRY_* backoff on sms-worker-job, then the DLQ's retries) plus a send-round
 *  delay, so a chunk that is merely slow is never double-enqueued. */
export const CHUNK_STALE_SECONDS = 2 * 60 * 60;
/** Re-enqueues of one chunk before the reaper fails it outright. */
export const CHUNK_MAX_REQUEUES = 3;
/** Chunks re-enqueued / force-failed per cron run (D1 query budget). */
export const REAPER_REQUEUE_BATCH = 50;
export const REAPER_FAIL_BATCH = 5;

/** Retention purge, per table per cron run: up to PURGE_MAX_BATCHES deletes
 *  of PURGE_BATCH_ROWS rows each, so one run stays inside the D1 query and
 *  duration budget and the cron catches up across runs. */
export const PURGE_BATCH_ROWS = 1000;
export const PURGE_MAX_BATCHES = 5;

/** Idempotency-Key: how long a stored response is replayed, and how long a
 *  claim whose request never finished (crashed isolate) blocks a retry
 *  before the retry may take it over. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const IDEMPOTENCY_LOCK_SECONDS = 120;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Provider circuit breaker (per isolate): after this many consecutive
 *  attempts that ended in transport failures only, the provider is tried
 *  last for BREAKER_OPEN_SECONDS. */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_OPEN_SECONDS = 60;

/** Rows per batched INSERT — messages table has 10 bound params/row and D1
 *  caps at 100 bound parameters per statement. */
export const HISTORY_INSERT_ROWS = 10;

/** Permissive phone validation ported from acadion (BD-flavored, not enforced). */
export const PHONE_REGEX = /^\+?[0-9]{11,14}$/;

/** Template placeholder token: %NAME% (uppercase alnum + underscore). */
export const TEMPLATE_TOKEN_REGEX = /%([A-Z0-9_]+)%/g;

/** KV cache keys + TTLs (seconds). D1 is source of truth; ADR 0002 makes the
 *  cache a send-path availability shield, hence the generous TTLs. */
export const KV_TTL_SECONDS = 300;
export const kvAppByKeyHash = (keyHash: string) => `app:key:${keyHash}`;
export const KV_APP_CONFIG_PREFIX = "app:config:";
export const kvAppConfig = (appId: number) => `${KV_APP_CONFIG_PREFIX}${appId}`;

/** R2 keys. Everything a Job writes lives under `jobs/{jobId}/` (deleted when
 *  the Job finishes; a bucket lifecycle rule on `jobs/` is the backstop). */
export const r2JobPrefix = (jobId: string) => `jobs/${jobId}/`;
/** NDJSON, one self-contained ChunkPayload per line (ADR 0005). */
export const r2JobPayloadKey = (jobId: string) => `jobs/${jobId}/payload.ndjson`;
/** Dispatch results of one chunk round, written right after the send so a
 *  redelivery never sends the same round twice (ADR 0005). */
export const r2ChunkResultsKey = (jobId: string, chunkIndex: number, round: number) =>
  `jobs/${jobId}/results/${chunkIndex}-${round}.json`;
/** Single-document payload of Jobs created before NDJSON payloads. */
export const r2LegacyJobKey = (jobId: string) => `jobs/${jobId}.json`;

/** Session cookie name for the admin UI. The __Host- prefix makes browsers
 *  accept it only Secure, host-only, and Path=/, so a sibling subdomain
 *  can't set or shadow it. (http://localhost still works: browsers treat it
 *  as a secure context.) */
export const SESSION_COOKIE = "__Host-sms_admin_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
/** Upper bound on admin password input (PBKDF2 cost grows with it). */
export const MAX_PASSWORD_LENGTH = 1024;
