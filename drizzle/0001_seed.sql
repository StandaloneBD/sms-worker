-- Seed default global provider settings (priority order: bulksmsbd, mimsms).
-- Data-only seed. Its journal entry and unchanged schema snapshot keep
-- subsequent drizzle-kit migration numbering aligned with Wrangler.
INSERT OR IGNORE INTO provider_settings (provider, enabled, priority, sender_id) VALUES ('bulksmsbd', 1, 1, NULL), ('mimsms', 1, 2, NULL);
