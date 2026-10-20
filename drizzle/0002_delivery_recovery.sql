ALTER TABLE `jobs` ADD `enqueued_at` integer;--> statement-breakpoint
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_app_created_idx` ON `jobs` (`app_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_completed_idx` ON `jobs` (`completed_at`);--> statement-breakpoint
CREATE INDEX `jobs_enqueue_idx` ON `jobs` (`enqueued_at`,`created_at`);