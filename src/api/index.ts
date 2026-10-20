/**
 * App-facing API. Mounted by the orchestrator at `/v1`. Every route below
 * runs behind bearer auth (auth.ts); a single `onError` handler keeps error
 * responses consistently shaped as `{error: string}`, including turning a
 * malformed-JSON-body throw (see validate.ts `readJsonBody`) into 400
 * instead of the framework default 500.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authMiddleware } from "./auth";
import { providersRoutes } from "./providers";
import { smsRoutes } from "./sms";
import { templatesRoutes } from "./templates";
import type { AppEnv } from "../shared/types";

export const apiRoutes = new Hono<AppEnv>();

apiRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
});

apiRoutes.use("*", authMiddleware);

apiRoutes.route("/", smsRoutes);
apiRoutes.route("/", templatesRoutes);
apiRoutes.route("/", providersRoutes);

apiRoutes.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(
    JSON.stringify({
      event: "api_unhandled_error",
      path: c.req.path,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return c.json({ error: "internal error" }, 500);
});
