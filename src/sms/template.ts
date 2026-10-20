import { TEMPLATE_TOKEN_REGEX } from "../shared/constants";

/**
 * Renders `%TOKEN%` placeholders against `vars`. A placeholder with no
 * matching variable (missing key, or `vars` undefined entirely) renders as
 * an empty string rather than being left in place or throwing — see
 * CONTEXT.md "Template".
 */
export function renderTemplate(body: string, vars: Record<string, string> | undefined): string {
  return body.replace(TEMPLATE_TOKEN_REGEX, (_match, token: string) =>
    vars && Object.hasOwn(vars, token) ? vars[token] ?? "" : "",
  );
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
