/**
 * Admin UI router. Mounted by the orchestrator at /admin — every path
 * registered below is relative ("/login", "/apps/:id/jobs", ...); links, form
 * actions, and redirects inside the pages go through adminPath() to produce
 * the absolute /admin/... URL.
 *
 * Registration order is load-bearing in Hono: a middleware only applies to
 * routes registered *after* it. csrfMiddleware is registered first so it
 * covers every POST including /login; authMiddleware is registered after
 * the public /login routes so it guards everything else without needing to
 * special-case the login path itself.
 */

import { Hono } from "hono";
import { requestBodyLimit } from "../shared/body-limit";
import type { AppEnv } from "../shared/types";
import { NotFoundPage } from "./components";
import { readFlash } from "./flash";
import {
  appActivePost,
  appConfigGet,
  appIpAllowlistPost,
  appMaskingCreatePost,
  appMaskingDeletePost,
  appProvidersPost,
  appQuotaPost,
  appRotateKeyPost,
  appsCreatePost,
  appsListGet,
  appTemplateCreatePost,
  appTemplateDeletePost,
} from "./pages/apps";
import { appOverviewGet } from "./pages/app-overview";
import { dashboardGet } from "./pages/dashboard";
import { jobDetailGet, jobRedirectGet, jobsListGet } from "./pages/jobs";
import { loginGet, loginPost, logoutPost } from "./pages/login";
import { messagesGet } from "./pages/messages";
import { providersGet, providersPost } from "./pages/providers";
import { settingsGet, settingsPost } from "./pages/settings";
import { templateEditGet, templateEditPost } from "./pages/templates";
import { authMiddleware, csrfMiddleware } from "./session";

export const adminRoutes = new Hono<AppEnv>({ strict: false });

// Pages run no inline script: confirm prompts, row details and provider
// reordering come from public/admin/*.js, served as static assets before the
// Worker runs (see wrangler.jsonc "assets" and public/_headers);
// inline styles stay allowed for the shell's <style> block and style attrs.
const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

adminRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header("Content-Security-Policy", ADMIN_CSP);
  await next();
});
adminRoutes.use("*", requestBodyLimit(64 * 1024));

// CSRF: applies to every route registered below, including /login.
adminRoutes.use("*", csrfMiddleware);

// Public: no session required.
adminRoutes.get("/login", loginGet);
adminRoutes.post("/login", loginPost);

// Auth: applies to every route registered below this point.
adminRoutes.use("*", authMiddleware);

adminRoutes.post("/logout", logoutPost);

adminRoutes.get("/", dashboardGet);

// Jobs and messages belong to an App; a bare job id forwards to its App.
adminRoutes.get("/jobs/:id", jobRedirectGet);

adminRoutes.get("/apps", appsListGet);
adminRoutes.post("/apps", appsCreatePost);
adminRoutes.get("/apps/:id", appOverviewGet);
adminRoutes.get("/apps/:id/jobs", jobsListGet);
adminRoutes.get("/apps/:id/jobs/:jobId", jobDetailGet);
adminRoutes.get("/apps/:id/messages", messagesGet);
adminRoutes.get("/apps/:id/config", appConfigGet);
adminRoutes.post("/apps/:id/active", appActivePost);
adminRoutes.post("/apps/:id/rotate-key", appRotateKeyPost);
adminRoutes.post("/apps/:id/providers", appProvidersPost);
adminRoutes.post("/apps/:id/ip-allowlist", appIpAllowlistPost);
adminRoutes.post("/apps/:id/quota", appQuotaPost);
adminRoutes.post("/apps/:id/masking-profiles", appMaskingCreatePost);
adminRoutes.post("/apps/:id/masking-profiles/:profileId/delete", appMaskingDeletePost);
adminRoutes.post("/apps/:id/templates", appTemplateCreatePost);
adminRoutes.get("/apps/:id/templates/:templateId", templateEditGet);
adminRoutes.post("/apps/:id/templates/:templateId", templateEditPost);
adminRoutes.post("/apps/:id/templates/:templateId/delete", appTemplateDeletePost);

adminRoutes.get("/providers", providersGet);
adminRoutes.post("/providers", providersPost);

adminRoutes.get("/settings", settingsGet);
adminRoutes.post("/settings", settingsPost);

adminRoutes.notFound((c) => c.html(<NotFoundPage flash={readFlash(c)} />, 404));
