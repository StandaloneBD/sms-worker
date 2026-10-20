/**
 * Absolute /admin/... URL helpers. Route registration inside adminRoutes
 * stays relative ("/apps/:id", "/apps/:id/jobs"); every link, form action,
 * and server-side redirect goes through here so it resolves correctly at the
 * orchestrator's mount point (spec: mounted at /admin).
 */

export const ADMIN_BASE = "/admin";

/** Builds an absolute admin URL. `adminPath("/")` intentionally yields
 *  ADMIN_BASE with no trailing slash — Hono's router treats "/admin" and
 *  "/admin/" as distinct paths, and only the former matches `.get("/")`. */
export function adminPath(path: string): string {
  return path === "/" ? ADMIN_BASE : `${ADMIN_BASE}${path}`;
}

/** The sections every App page sits under. */
export type AppTab = "overview" | "jobs" | "messages" | "config";

/** An App's section: /admin/apps/:id for its overview, /admin/apps/:id/<tab> otherwise. */
export function appPath(appId: number, tab: AppTab = "overview"): string {
  return adminPath(tab === "overview" ? `/apps/${appId}` : `/apps/${appId}/${tab}`);
}

export function jobPath(appId: number, jobId: string): string {
  return adminPath(`/apps/${appId}/jobs/${jobId}`);
}
