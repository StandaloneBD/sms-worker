/**
 * IP address parsing and matching for an App's IP Allowlist. Entries are
 * single IPv4/IPv6 addresses or CIDR ranges (`203.0.113.0/28`,
 * `2001:db8::/48`). IPv4-mapped IPv6 (`::ffff:203.0.113.7`) is treated as
 * the IPv4 address it carries, on both sides of a match.
 */

const IPV4_OCTET = /^(0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

function parseIpv4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!IPV4_OCTET.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(s: string): Uint8Array | null {
  const bytes = new Uint8Array(16);
  // A trailing dotted IPv4 (`::ffff:1.2.3.4`) fills the last two groups.
  const embedsV4 = s.includes(".");
  if (embedsV4) {
    const lastColon = s.lastIndexOf(":");
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (lastColon < 0 || !v4) return null;
    bytes.set(v4, 12);
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;

  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  // The embedded IPv4's two placeholder groups are already filled in.
  for (let i = 0; i < (embedsV4 ? 6 : 8); i++) {
    const group = groups[i]!;
    if (!IPV6_GROUP.test(group)) return null;
    const n = parseInt(group, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** 4 bytes for IPv4 (including IPv4-mapped IPv6), 16 for IPv6; null if invalid. */
function parseIp(s: string): Uint8Array | null {
  const bytes = s.includes(":") ? parseIpv6(s) : parseIpv4(s);
  if (bytes && isIpv4Mapped(bytes)) return bytes.slice(12);
  return bytes;
}

interface IpRange {
  bytes: Uint8Array;
  prefix: number;
}

function parseEntry(raw: string): IpRange | null {
  const slash = raw.indexOf("/");
  const addr = slash < 0 ? raw : raw.slice(0, slash);
  const parsedFull = addr.includes(":") ? parseIpv6(addr) : parseIpv4(addr);
  if (!parsedFull) return null;
  const mapped = isIpv4Mapped(parsedFull);
  const bytes = mapped ? parsedFull.slice(12) : parsedFull;
  if (slash < 0) return { bytes, prefix: bytes.length * 8 };

  const prefixRaw = raw.slice(slash + 1);
  if (!/^[0-9]{1,3}$/.test(prefixRaw)) return null;
  // A mapped range's prefix counts the 96 bits of the ::ffff: part.
  const prefix = Number(prefixRaw) - (mapped ? 96 : 0);
  if (prefix < 0 || prefix > bytes.length * 8) return null;
  return { bytes, prefix };
}

function inRange(ip: Uint8Array, range: IpRange): boolean {
  if (ip.length !== range.bytes.length) return false;
  const whole = range.prefix >> 3;
  for (let i = 0; i < whole; i++) if (ip[i] !== range.bytes[i]) return false;
  const rest = range.prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (ip[whole]! & mask) === (range.bytes[whole]! & mask);
}

function formatIpv6(bytes: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, i) => (bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
  // RFC 5952: the longest run of two or more zero groups (the first on a tie) becomes "::".
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > runLength && j - i >= 2) {
      runStart = i;
      runLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (runStart < 0) return hex.join(":");
  return `${hex.slice(0, runStart).join(":")}::${hex.slice(runStart + runLength).join(":")}`;
}

/** One spelling per range: host bits cleared, a single address without its
 *  full-length prefix, IPv4-mapped IPv6 as plain IPv4. */
function formatRange(range: IpRange): string {
  const bytes = range.bytes.slice();
  for (let bit = range.prefix; bit < bytes.length * 8; bit++) {
    bytes[bit >> 3]! &= ~(0x80 >> (bit & 7));
  }
  const addr = bytes.length === 4 ? bytes.join(".") : formatIpv6(bytes);
  return range.prefix === bytes.length * 8 ? addr : `${addr}/${range.prefix}`;
}

/** The stored form of one allowlist entry, so equivalent spellings
 *  (`2001:0db8::1` / `2001:db8::1`, `1.2.3.4/32` / `1.2.3.4`) are one entry;
 *  null when it isn't an IPv4/IPv6 address or CIDR range. */
export function normalizeIpEntry(raw: string): string | null {
  const range = parseEntry(raw.trim());
  return range ? formatRange(range) : null;
}

/** Whether `ip` (as Cloudflare reports it in CF-Connecting-IP) is covered by
 *  any entry. An unparseable ip matches nothing. */
export function ipAllowed(ip: string, allowlist: readonly string[]): boolean {
  const addr = parseIp(ip.trim());
  if (!addr) return false;
  return allowlist.some((entry) => {
    const range = parseEntry(entry);
    return range !== null && inRange(addr, range);
  });
}
