import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Workers-runtime test harness: tests in test/**/*.test.ts run inside
// workerd (via Miniflare) with the real bindings declared in
// wrangler.jsonc (D1, KV, R2, Queues). See @cloudflare/vitest-plugin docs:
// https://developers.cloudflare.com/workers/testing/vitest-integration/
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Explicit test values take precedence over local .dev.vars.
      miniflare: { bindings: {
        ENCRYPTION_KEY: "test-encryption-key",
        SESSION_SECRET: "test-session-secret",
        ADMIN_BOOTSTRAP_PASSWORD: "test-bootstrap-password",
        FAKE_SMS: "true",
        TEST_MIGRATIONS: await readD1Migrations("./drizzle"),
      } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
