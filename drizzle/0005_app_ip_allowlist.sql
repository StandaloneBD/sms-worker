ALTER TABLE `apps` ADD `ip_allowlist_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `ip_allowlist` text DEFAULT '[]' NOT NULL;