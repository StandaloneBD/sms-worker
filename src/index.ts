import { Hono } from "hono";
import { cors } from "hono/cors";
import { apiRoutes } from "./api";
import { adminRoutes } from "./ui";
import { handleQueue } from "./queue/consumer";
import { handleScheduled } from "./queue/scheduled";
import type { AppEnv } from "./shared/types";

// strict: false — /admin and /admin/ are the same page.
export const app = new Hono<AppEnv>({ strict: false });

/**
 * The CORS origin to allow for a request, from the CORS_ORIGINS var: a
 * comma-separated allowlist, "*" for any origin, empty for none (no CORS
 * headers, so browsers block cross-origin calls).
 */
export function corsOriginFor(requestOrigin: string, configured: string | undefined): string | null {
  const allowed = (configured ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (allowed.includes("*")) return "*";
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

// API + health only: the admin UI is same-origin, cookie-authenticated
// forms and has no business answering cross-origin requests.
const apiCors = cors({
  origin: (origin, c) => corsOriginFor(origin, (c.env as Env | undefined)?.CORS_ORIGINS),
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
  allowHeaders: ["*"],
  exposeHeaders: ["*"],
  maxAge: 86400,
});
app.use("/v1/*", apiCors);
app.use("/health", apiCors);

app.get("/", (c) => c.redirect("/admin"));
app.get("/health", (c) => c.json({ ok: true }));

app.route("/v1", apiRoutes);
app.route("/admin", adminRoutes);

app.notFound((c) =>
  c.req.path.startsWith("/v1")
    ? c.json({ error: "not found" }, 404)
    : c.text("Not found", 404),
);

app.onError((err, c) => {
  // Explicit structured handling — never passThroughOnException, never leak
  // stack traces to callers.
  console.error(
    JSON.stringify({
      event: "unhandled_error",
      path: c.req.path,
      method: c.req.method,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return c.req.path.startsWith("/v1")
    ? c.json({ error: "internal error" }, 500)
    : c.text("Internal error", 500);
});

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
