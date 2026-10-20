/**
 * Small formatting / parsing helpers shared by the admin pages. Numbers
 * parsed from query strings and form bodies are always parsed defensively —
 * a bad value falls back rather than producing NaN/undefined downstream.
 */

export const PAGE_SIZE = 20;

/** Defensive non-negative integer offset from a query param. */
export function parseOffset(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}

/** Defensive integer with a fallback (used for priority inputs). */
export function parseIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return fallback;
  return n;
}

/** Defensive positive integer id from a route param; null when invalid. */
export function parseId(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/** Unix-second timestamp → "YYYY-MM-DD HH:MM:SS" UTC; "—" for null/undefined. */
export function formatTs(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  const iso = new Date(ts * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** Thousands-separated integer, en-US (e.g. 12,345). */
export function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

/** First 8 characters of an id (job uuids), for compact table/link display. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * GSM 03.38 basic character set (single-septet). Extension-table characters
 * (`^{}\[~]|€`) are reachable via an ESC prefix and cost 2 septets each —
 * see GSM7_EXTENDED below.
 */
const GSM7_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ),
);
const GSM7_EXTENDED = new Set(Array.from("^{}\\[~]|€"));

/**
 * SMS segmentation for a message body (GSM 03.38 vs UCS-2), per the
 * carrier's own per-segment character budget. `chars` is the true
 * human-facing character (code point) count. `units` is the encoding-unit
 * count the SMSC actually segments on: septets for GSM-7 (each
 * extension-table character costs 2), or UTF-16 code units for UCS-2. The
 * two diverge for astral characters (e.g. emoji) — `"😀"` is one `chars` but
 * two UTF-16 code units, so it must count as 2 toward the UCS-2 70/67-unit
 * segment budget, not 1.
 */
export function smsSegments(body: string): {
  chars: number;
  units: number;
  segments: number;
  encoding: "GSM-7" | "UCS-2";
} {
  const chars = Array.from(body);
  let septets = 0;
  let isGsm7 = true;
  for (const ch of chars) {
    if (GSM7_BASIC.has(ch)) {
      septets += 1;
    } else if (GSM7_EXTENDED.has(ch)) {
      septets += 2;
    } else {
      isGsm7 = false;
      break;
    }
  }

  if (isGsm7) {
    const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { chars: chars.length, units: septets, segments, encoding: "GSM-7" };
  }

  const units = body.length;
  const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67);
  return { chars: chars.length, units, segments, encoding: "UCS-2" };
}

/** Pulls a trimmed string out of a parsed form body (parseBody() values may be File). */
export function formStr(value: string | File | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Same as formStr but preserves leading/trailing whitespace (passwords). */
export function formRaw(value: string | File | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Presence check for an HTML checkbox field in parsed form data. */
export function formChecked(value: string | File | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

export function providerCredentialError(fields: { apiKey: string; senderId: string; senderName: string; username: string }): string | null {
  if (fields.apiKey.length > 512 || /\s/.test(fields.apiKey)) return "API key must be at most 512 characters and contain no whitespace.";
  if ([fields.senderId, fields.senderName, fields.username].some((value) => value.length > 128)) return "Sender identity and username must be at most 128 characters.";
  return null;
}
