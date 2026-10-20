CREATE TABLE `app_usage` (
	`app_id` integer NOT NULL,
	`day` text NOT NULL,
	`recipients` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`app_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`app_id` integer NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer,
	`response_body` text,
	`created_at` integer NOT NULL,
	`locked_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created_idx` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
DROP INDEX `jobs_completed_idx`;--> statement-breakpoint
DROP INDEX `jobs_enqueue_idx`;--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `enqueued_at`;--> statement-breakpoint
ALTER TABLE `admins` ADD `session_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `daily_quota` integer;--> statement-breakpoint
ALTER TABLE `job_chunks` ADD `total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_chunks` ADD `round` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_chunks` ADD `retry_indexes` text;--> statement-breakpoint
ALTER TABLE `job_chunks` ADD `payload_offset` integer;--> statement-breakpoint
ALTER TABLE `job_chunks` ADD `payload_length` integer;--> statement-breakpoint
ALTER TABLE `job_chunks` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `job_chunks` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_chunks` ADD `requeues` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `job_chunks_status_updated_idx` ON `job_chunks` (`status`,`updated_at`);--> statement-breakpoint
-- Hand-written backfill for chunks created before this migration: give
-- pending chunks a fresh progress stamp (so the reaper doesn't treat every
-- in-flight chunk as stale on deploy) and their recipient count, derived
-- the same way the old producer sliced (fixed 250-recipient chunks).
UPDATE `job_chunks` SET `updated_at` = COALESCE(`completed_at`, unixepoch());--> statement-breakpoint
UPDATE `job_chunks` SET `total` = MAX(0, MIN(250, (SELECT `total` FROM `jobs` WHERE `jobs`.`id` = `job_chunks`.`job_id`) - `chunk_index` * 250));
