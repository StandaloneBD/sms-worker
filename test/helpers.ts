import { applyD1Migrations, env } from "cloudflare:test";

/** Integration tests use the actual migration chain rather than copied DDL. */
export async function resetDatabase() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(["idempotency_keys", "app_usage", "messages", "job_chunks", "jobs", "templates", "app_providers", "masking_profiles", "provider_settings", "apps", "admins"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}
