/**
 * Shared contracts. Vocabulary follows CONTEXT.md; every module codes against
 * these types, so changes here ripple everywhere — extend, don't reshape.
 */

export const PROVIDER_NAMES = ["bulksmsbd", "mimsms"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Why one provider attempt did not accept a recipient (CONTEXT.md "Failure
 * kind"):
 *  - "transport": no definitive answer — network error, timeout, 5xx/408/429,
 *    unparseable body. The SMS may or may not have gone out.
 *  - "provider": the provider answered but refused for a reason on its side
 *    (credentials, balance, sender config, a batch rejection it doesn't
 *    attribute to a recipient). Not sent.
 *  - "recipient": the provider rejected this recipient specifically (e.g. an
 *    invalid number). Not sent, and retrying through it won't help.
 */
export type FailureKind = "transport" | "provider" | "recipient";

/** Per-recipient outcome of one provider attempt (ported from acadion). */
export interface SmsSendOutcome {
  accepted: boolean;
  reason?: string;
  /** Provider's own id for the accepted message, when it reports one. */
  trackingId?: string;
  /** Set on every declined outcome an adapter produces. */
  failure?: FailureKind;
}

export interface SmsDynamicMessage {
  to: string;
  message: string;
}

/**
 * Credentials a provider adapter dispatches with. Resolved per request:
 * masking profile (app-owned, D1) → global provider settings (D1, encrypted).
 */
export interface ProviderCredentials {
  apiKey: string;
  /** bulksmsbd: numeric sender id. */
  senderId?: string;
  /** mimsms only. */
  username?: string;
  /** mimsms only. */
  senderName?: string;
}

/** Transport adapter for one SMS gateway. Stateless; creds via constructor. */
export interface ISmsProvider {
  readonly name: ProviderName | "fake";
  /** One body, many recipients. Returns one outcome per recipient, in order. */
  send(recipients: string[], message: string): Promise<SmsSendOutcome[]>;
  /** Per-recipient bodies. Returns one outcome per message, in order. */
  sendDynamic(messages: SmsDynamicMessage[]): Promise<SmsSendOutcome[]>;
}

/** A provider plus the credentials to use for this dispatch, in priority order. */
export interface DispatchPlanEntry {
  provider: ISmsProvider;
}

export interface DispatchResultItem extends SmsSendOutcome {
  to: string;
  /** Which provider finally accepted (or null when every provider declined). */
  provider: ProviderName | "fake" | null;
  /** A later attempt could still succeed: some provider failed this
   *  recipient for a transport or provider-side reason rather than rejecting
   *  the recipient itself. Always false when accepted. */
  retryable: boolean;
}

/** Input to the failover dispatch loop: uniform or per-recipient bodies. */
export type DispatchInput =
  | { kind: "uniform"; message: string; recipients: string[] }
  | { kind: "dynamic"; messages: SmsDynamicMessage[] };

/** Queue message — payload itself lives in R2 (ADR 0001). `round` names the
 *  send round it acts on; messages enqueued before send rounds existed
 *  carry none, which means round 0. */
export interface ChunkQueueMessage {
  jobId: string;
  chunkIndex: number;
  round?: number;
}

/** One recipient inside a job payload / send request. */
export interface JobRecipient {
  to: string;
  /** Pre-rendered per-recipient body (dynamic sends). */
  message?: string;
  /** Template variables, used when the job references a template. */
  vars?: Record<string, string>;
}

/** Job-level fields every chunk of a Job's payload carries. */
export interface JobPayloadHeader {
  jobId: string;
  appId: number;
  /** Request-level body, used for any recipient without its own message
   *  when no template is referenced. */
  message?: string;
  templateId?: number;
  /** Pre-fetched template body so the consumer never depends on D1 for it. */
  templateBody?: string;
  /** Masking profile label; resolved per provider at dispatch time. */
  maskingProfile?: string;
  /** Only dispatch through providers that have the masking profile. */
  maskingStrict?: boolean;
}

/** One line of jobs/{jobId}/payload.ndjson in R2 — a self-contained chunk,
 *  read with a ranged GET (ADR 0005). */
export interface ChunkPayload extends JobPayloadHeader {
  chunkIndex: number;
  recipients: JobRecipient[];
}

/** The single JSON document jobs/{jobId}.json that Jobs created before
 *  NDJSON payloads used; read only for their chunks. */
export interface LegacyJobPayload extends JobPayloadHeader {
  chunkSize: number;
  recipients: JobRecipient[];
}

export type MessageStatus = "sent" | "failed";
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed";

/** App identity attached to authenticated API requests (KV-cached). */
export interface AuthedApp {
  id: number;
  name: string;
  isActive: boolean;
  /** Max recipients per UTC day; null/absent = unlimited. Absent on cache
   *  entries written before quotas existed. */
  dailyQuota?: number | null;
  /** Addresses/ranges allowed to make write requests; absent = the IP
   *  Allowlist is off and any address may. */
  ipAllowlist?: string[];
}

/** Hono context bindings shared by all routes. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    app: AuthedApp;
    adminId: number;
  };
};
