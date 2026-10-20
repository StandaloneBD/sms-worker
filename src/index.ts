import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { apiRoutes } from "./api";
import { adminRoutes } from "./ui";
import { handleQueue } from "./queue/consumer";
import { handleScheduled } from "./queue/scheduled";
import type { AppEnv } from "./shared/types";

// strict: false — /admin and /admin/ are the same page.
export const app = new Hono<AppEnv>({ strict: false });

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
    allowHeaders: ["*"],
    exposeHeaders: ["*"],
    maxAge: 86400,
  }),
);

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
  if (err instanceof HTTPException) {
    return c.req.path.startsWith("/v1") ? c.json({ error: err.message }, err.status) : c.text(err.message, err.status);
  }
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
