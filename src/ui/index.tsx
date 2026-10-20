/**
 * Admin UI router. Mounted by the orchestrator at /admin — every path
 * registered below is relative ("/login", "/jobs/:id", ...); links, form
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
import type { AppEnv } from "../shared/types";
import { NotFoundPage } from "./components";
import { readFlash } from "./flash";
import {
  appActivePost,
  appDetailGet,
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
import { dashboardGet } from "./pages/dashboard";
import { jobDetailGet, jobsListGet } from "./pages/jobs";
import { loginGet, loginPost, logoutPost } from "./pages/login";
import { messagesGet } from "./pages/messages";
import { providersGet, providersPost } from "./pages/providers";
import { settingsGet, settingsPost } from "./pages/settings";
import { templateEditGet, templateEditPost } from "./pages/templates";
import { authMiddleware, csrfMiddleware } from "./session";

export const adminRoutes = new Hono<AppEnv>({ strict: false });

// CSRF: applies to every route registered below, including /login.
adminRoutes.use("*", csrfMiddleware);

// Public: no session required.
adminRoutes.get("/login", loginGet);
adminRoutes.post("/login", loginPost);

// Auth: applies to every route registered below this point.
adminRoutes.use("*", authMiddleware);

adminRoutes.post("/logout", logoutPost);

adminRoutes.get("/", dashboardGet);

adminRoutes.get("/jobs", jobsListGet);
adminRoutes.get("/jobs/:id", jobDetailGet);

adminRoutes.get("/messages", messagesGet);

adminRoutes.get("/apps", appsListGet);
adminRoutes.post("/apps", appsCreatePost);
adminRoutes.get("/apps/:id", appDetailGet);
adminRoutes.post("/apps/:id/active", appActivePost);
adminRoutes.post("/apps/:id/rotate-key", appRotateKeyPost);
adminRoutes.post("/apps/:id/providers", appProvidersPost);
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
