/**
 * Per-App provider priority (`/providers`) and masking-profile listing
 * (`/masking-profiles`). Masking profiles never expose key material — only
 * whether one is configured (`hasApiKey`).
 */

import { Hono } from "hono";
import { getAppProviderPlan, getDb, listMaskingProfiles, upsertAppProviders } from "../db";
import { requestBodyLimit } from "../shared/body-limit";
import { invalidateAppConfig } from "../core/plan";
import { PROVIDER_NAMES } from "../shared/types";
import type { AppEnv, ProviderName } from "../shared/types";
import { fail, readJsonBody } from "./validate";

export const providersRoutes = new Hono<AppEnv>();
providersRoutes.use("*", requestBodyLimit(64 * 1024));

interface ProviderRowInput {
  provider: ProviderName;
  enabled: boolean;
  priority: number;
}

const PROVIDER_NAME_SET: readonly string[] = PROVIDER_NAMES;

function parseProviderRows(raw: unknown): ProviderRowInput[] {
  if (!Array.isArray(raw)) return fail(400, "body must be an array");
  if (raw.length > PROVIDER_NAMES.length) return fail(400, "too many provider entries");
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") return fail(400, `[${index}]: must be an object`);
    const obj = item as Record<string, unknown>;

    const provider = obj.provider;
    if (typeof provider !== "string" || !PROVIDER_NAME_SET.includes(provider)) {
      return fail(400, `[${index}]: "provider" must be one of ${PROVIDER_NAMES.join(", ")}`);
    }
    if (seen.has(provider)) return fail(400, `[${index}]: duplicate provider`);
    seen.add(provider);

    const enabled = obj.enabled;
    if (typeof enabled !== "boolean") return fail(400, `[${index}]: "enabled" must be a boolean`);

    const priority = obj.priority;
    if (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < 1) {
      return fail(400, `[${index}]: "priority" must be an integer >= 1`);
    }

    return { provider: provider as ProviderName, enabled, priority };
  });
}

providersRoutes.get("/providers", async (c) => {
  const db = getDb(c.env);
  const plan = await getAppProviderPlan(db, c.var.app.id);
  return c.json({ plan, providers: PROVIDER_NAMES }, 200);
});

providersRoutes.put("/providers", async (c) => {
  const db = getDb(c.env);
  const raw = await readJsonBody<unknown>(c);
  const rows = parseProviderRows(raw);

  await upsertAppProviders(db, rows.map((row) => ({ ...row, appId: c.var.app.id })));
  await invalidateAppConfig(c.env, c.var.app.id);

  const plan = await getAppProviderPlan(db, c.var.app.id);
  return c.json({ plan }, 200);
});

providersRoutes.get("/masking-profiles", async (c) => {
  const db = getDb(c.env);
  const rows = await listMaskingProfiles(db, c.var.app.id);
  const profiles = rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    senderId: row.senderId,
    senderName: row.senderName,
    username: row.username,
    hasApiKey: row.apiKeyEnc !== null,
  }));
  return c.json(profiles, 200);
});
