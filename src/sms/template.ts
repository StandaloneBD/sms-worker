import { MAX_MESSAGE_LENGTH, MAX_TEMPLATE_NAME_LENGTH, TEMPLATE_TOKEN_REGEX } from "../shared/constants";

/** Why a Template name can't be saved, or null. Shared by the API and the admin UI. */
export function templateNameProblem(name: unknown): string | null {
  return typeof name === "string" && name.length >= 1 && name.length <= MAX_TEMPLATE_NAME_LENGTH
    ? null
    : `"name" must be 1-${MAX_TEMPLATE_NAME_LENGTH} characters`;
}

/** Why a Template body can't be saved, or null. Shared by the API and the admin UI. */
export function templateBodyProblem(body: unknown): string | null {
  return typeof body === "string" && body.length >= 1 && body.length <= MAX_MESSAGE_LENGTH
    ? null
    : `"body" must be 1-${MAX_MESSAGE_LENGTH} characters`;
}

/**
 * Renders `%TOKEN%` placeholders against `vars`. A placeholder with no
 * matching variable (missing key, or `vars` undefined entirely) renders as
 * an empty string rather than being left in place or throwing — see
 * CONTEXT.md "Template".
 */
export function renderTemplate(body: string, vars: Record<string, string> | undefined): string {
  // Own keys only: a token must never resolve to an inherited property.
  return body.replace(TEMPLATE_TOKEN_REGEX, (_match, token: string) =>
    vars && Object.hasOwn(vars, token) ? vars[token] ?? "" : "",
  );
}

/**
 * The body-source rule for one recipient, shared by the sync route, job
 * submission and the queue consumer so they can't disagree: an explicit
 * per-recipient message wins, then a template render, then the request-level
 * message. Undefined when none applies.
 */
export function resolveBody(
  recipient: { message?: string; vars?: Record<string, string> },
  source: { message?: string; templateBody?: string },
): string | undefined {
  if (recipient.message !== undefined) return recipient.message;
  if (source.templateBody !== undefined) return renderTemplate(source.templateBody, recipient.vars);
  return source.message;
}

/** Distinct token names referenced by a template body, in first-seen order. */
export function extractTokens(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(TEMPLATE_TOKEN_REGEX)) {
    const token = match[1];
    if (token) seen.add(token);
  }
  return Array.from(seen);
}
