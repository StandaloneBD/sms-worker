DROP INDEX `jobs_status_idx`;--> statement-breakpoint
CREATE INDEX `jobs_unfinished_idx` ON `jobs` (`app_id`,`status`) WHERE status IN ('queued', 'running');--> statement-breakpoint
DROP INDEX `messages_created_idx`;--> statement-breakpoint
CREATE INDEX `messages_app_failed_idx` ON `messages` (`app_id`,`created_at`) WHERE status = 'failed';