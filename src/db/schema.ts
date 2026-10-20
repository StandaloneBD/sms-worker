/**
 * Drizzle schema (SQLite / D1). Column names are snake_case in SQL,
 * fields are camelCase in TS — see the explicit column-name argument on
 * every column below. Timestamps are unix seconds everywhere (integer
 * columns, computed via `Math.floor(Date.now() / 1000)` by callers).
 */

import { index, int, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { PROVIDER_NAMES } from "../shared/types";

/** Closed enumerations that don't have a shared/types.ts export of their own. */
const JOB_KINDS = ["sync", "bulk"] as const;
const JOB_STATUSES = ["queued", "running", "completed", "completed_with_errors", "failed"] as const;
const JOB_CHUNK_STATUSES = ["pending", "done", "failed"] as const;
const MESSAGE_STATUSES = ["sent", "failed"] as const;

export const admins = sqliteTable("admins", {
  id: int("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
});

export const apps = sqliteTable("apps", {
  id: int("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  /** sha256 hex of the full API key; the key itself is never stored. */
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  isActive: int("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: int("created_at").notNull(),
});

export const providerSettings = sqliteTable("provider_settings", {
  provider: text("provider", { enum: PROVIDER_NAMES }).primaryKey(),
  enabled: int("enabled", { mode: "boolean" }).notNull().default(true),
  priority: int("priority").notNull(),
  /** Nullable global default sender id. */
  senderId: text("sender_id"),
  /** AES-GCM ciphertext, same format as masking_profiles.api_key_enc. */
  apiKeyEnc: text("api_key_enc"),
  /** mimsms account username. */
  username: text("username"),
  /** mimsms sender name. */
  senderName: text("sender_name"),
  updatedAt: int("updated_at"),
});

export const appProviders = sqliteTable(
  "app_providers",
  {
    appId: int("app_id").notNull(),
    provider: text("provider", { enum: PROVIDER_NAMES }).notNull(),
    enabled: int("enabled", { mode: "boolean" }).notNull().default(true),
    priority: int("priority").notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.provider] })],
);

export const maskingProfiles = sqliteTable(
  "masking_profiles",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    appId: int("app_id").notNull(),
    provider: text("provider", { enum: PROVIDER_NAMES }).notNull(),
    label: text("label").notNull(),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    username: text("username"),
    /** AES-GCM ciphertext; null when the profile only overrides sender identity. */
    apiKeyEnc: text("api_key_enc"),
    createdAt: int("created_at").notNull(),
  },
  (t) => [uniqueIndex("masking_profiles_app_provider_label_unique").on(t.appId, t.provider, t.label)],
);

export const templates = sqliteTable(
  "templates",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    appId: int("app_id").notNull(),
    name: text("name").notNull(),
    body: text("body").notNull(),
    createdAt: int("created_at").notNull(),
    updatedAt: int("updated_at").notNull(),
  },
  (t) => [uniqueIndex("templates_app_name_unique").on(t.appId, t.name)],
);

export const jobs = sqliteTable("jobs", {
  /** uuid */
  id: text("id").primaryKey(),
  appId: int("app_id").notNull(),
  kind: text("kind", { enum: JOB_KINDS }).notNull(),
  status: text("status", { enum: JOB_STATUSES }).notNull(),
  body: text("body"),
  templateId: int("template_id"),
  maskingProfile: text("masking_profile"),
  total: int("total").notNull().default(0),
  sent: int("sent").notNull().default(0),
  failed: int("failed").notNull().default(0),
  chunkCount: int("chunk_count").notNull().default(0),
  chunksDone: int("chunks_done").notNull().default(0),
  error: text("error"),
  createdAt: int("created_at").notNull(),
  completedAt: int("completed_at"),
  /** Durable publication marker; null jobs are retried by the minute cron. */
  enqueuedAt: int("enqueued_at"),
}, (t) => [
  index("jobs_created_idx").on(t.createdAt, t.id),
  index("jobs_app_created_idx").on(t.appId, t.createdAt, t.id),
  index("jobs_completed_idx").on(t.completedAt),
  index("jobs_enqueue_idx").on(t.enqueuedAt, t.createdAt),
]);

export const jobChunks = sqliteTable(
  "job_chunks",
  {
    jobId: text("job_id").notNull(),
    chunkIndex: int("chunk_index").notNull(),
    status: text("status", { enum: JOB_CHUNK_STATUSES }).notNull().default("pending"),
    sent: int("sent").notNull().default(0),
    failed: int("failed").notNull().default(0),
    completedAt: int("completed_at"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.chunkIndex] })],
);

export const messages = sqliteTable(
  "messages",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id").notNull(),
    appId: int("app_id").notNull(),
    recipient: text("recipient").notNull(),
    body: text("body"),
    /** Plain text, not the ProviderName enum: dev/test dispatch may record "fake". */
    provider: text("provider"),
    status: text("status", { enum: MESSAGE_STATUSES }).notNull(),
    reason: text("reason"),
    trackingId: text("tracking_id"),
    createdAt: int("created_at").notNull(),
  },
  (t) => [
    index("messages_app_created_idx").on(t.appId, t.createdAt),
    index("messages_job_idx").on(t.jobId),
    index("messages_created_idx").on(t.createdAt),
  ],
);
