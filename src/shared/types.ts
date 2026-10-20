/**
 * Shared contracts. Vocabulary follows CONTEXT.md; every module codes against
 * these types, so changes here ripple everywhere — extend, don't reshape.
 */

export const PROVIDER_NAMES = ["bulksmsbd", "mimsms"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Per-recipient outcome of one provider attempt (ported from acadion). */
export interface SmsSendOutcome {
  accepted: boolean;
  reason?: string;
  /** Provider's own id for the accepted message, when it reports one. */
  trackingId?: string;
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
}

/** Input to the failover dispatch loop: uniform or per-recipient bodies. */
export type DispatchInput =
  | { kind: "uniform"; message: string; recipients: string[] }
  | { kind: "dynamic"; messages: SmsDynamicMessage[] };

/** Queue message — payload itself lives in R2 (ADR 0001). */
export interface ChunkQueueMessage {
  jobId: string;
  chunkIndex: number;
}

/** One recipient inside a job payload / send request. */
export interface JobRecipient {
  to: string;
  /** Pre-rendered per-recipient body (dynamic sends). */
  message?: string;
  /** Template variables, used when the job references a template. */
  vars?: Record<string, string>;
}

/** The JSON document parked at jobs/{jobId}.json in R2. */
export interface JobPayload {
  jobId: string;
  appId: number;
  /** Fallback body for recipients without an override; absent when a template is used. */
  message?: string;
  templateId?: number;
  /** Pre-fetched template body so the consumer never depends on D1 for it. */
  templateBody?: string;
  /** Masking profile label; resolved per provider at dispatch time. */
  maskingProfile?: string;
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
}

/** Hono context bindings shared by all routes. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    app: AuthedApp;
    adminId: number;
  };
};
