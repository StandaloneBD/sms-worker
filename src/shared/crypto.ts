/**
 * Web Crypto only — no Node `crypto`, no `Math.random`. Every function here
 * runs on the Workers runtime's native SubtleCrypto/getRandomValues.
 */

// Sized for the Workers FREE plan's 10ms CPU budget: 100k iterations sits at
// the runtime's own ceiling and can blow that budget, making admin login fail
// in production while passing in `wrangler dev` (which doesn't enforce the
// kill). 40k keeps a few ms of headroom; raise on Workers Paid. Stored hashes
// embed their iteration count, so changing this never breaks existing admins.
const PBKDF2_ITERATIONS = 40_000;
const PBKDF2_SALT_BYTES = 16;
const API_KEY_RANDOM_BYTES = 24; // -> 48 hex chars
const API_KEY_PREFIX_LENGTH = 10; // "sk_" + 7 hex chars
const GCM_IV_BYTES = 12;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time byte compare via the Workers-native
 * `crypto.subtle.timingSafeEqual` (throws on length mismatch), falling back
 * to a manual length-checked XOR compare if it's unavailable or throws for
 * another reason.
 */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  try {
    return crypto.subtle.timingSafeEqual(a, b);
  } catch {
    let diff = 0;
    for (let i = 0; i < a.byteLength; i++) {
      diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
  }
}

/** Compares SHA-256 digests, so neither the content nor the length of the
 *  secret side leaks through timing. */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aHash, bHash);
}

/* ------------------------------------------------------------------ */
/* API keys                                                             */
/* ------------------------------------------------------------------ */

export interface GeneratedApiKey {
  /** Full secret key — shown to the caller once, never persisted. */
  key: string;
  /** First 10 chars of `key`, safe to persist/display for identification. */
  prefix: string;
  /** sha256 hex of the full key — what actually gets persisted. */
  hash: string;
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const bytes = new Uint8Array(API_KEY_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  const key = `sk_${toHex(bytes)}`;
  const prefix = key.slice(0, API_KEY_PREFIX_LENGTH);
  const hash = await sha256Hex(key);
  return { key, prefix, hash };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ */
/* Passwords                                                            */
/* ------------------------------------------------------------------ */

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Format: `pbkdf2$<iterations>$<saltB64>$<hashB64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(PBKDF2_SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const saltB64 = parts[2];
  const hashB64 = parts[3];
  if (!Number.isInteger(iterations) || iterations <= 0 || !saltB64 || !hashB64) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(saltB64);
    expected = fromBase64(hashB64);
  } catch {
    return false;
  }

  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqualBytes(actual, expected);
}

/* ------------------------------------------------------------------ */
/* Worker secrets                                                       */
/* ------------------------------------------------------------------ */

const MIN_SECRET_LENGTH = 16;

/**
 * Reads a required worker secret, refusing a missing or short one. Without
 * this an unset ENCRYPTION_KEY silently derives the AES key from the empty
 * string — SHA-256(""), a public constant — and "encrypts" every provider
 * API key with it.
 */
function requireSecret(env: Env, name: "ENCRYPTION_KEY" | "SESSION_SECRET"): string {
  const value: unknown = env[name];
  if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} is not configured: set it with \`wrangler secret put ${name}\` (at least ${MIN_SECRET_LENGTH} characters)`,
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Secrets at rest (provider + masking profile API keys)               */
/* ------------------------------------------------------------------ */

/** Imported once per isolate (per secret value) rather than per call — the
 *  dispatch plan decrypts a key per provider on every send. */
let aesKeyCache: { secret: string; key: Promise<CryptoKey> } | undefined;

async function getAesKey(env: Env): Promise<CryptoKey> {
  const secret = requireSecret(env, "ENCRYPTION_KEY");
  if (aesKeyCache?.secret !== secret) {
    const key = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(secret))
      .then((digest) => crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]));
    aesKeyCache = { secret, key };
  }
  return aesKeyCache.key;
}

/** Output format: `base64(iv):base64(ciphertext)`. AES-256-GCM. */
export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await getAesKey(env);
  const iv = new Uint8Array(GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(env: Env, ciphertext: string): Promise<string> {
  const [ivB64, ctB64] = ciphertext.split(":");
  if (!ivB64 || !ctB64) throw new Error("decryptSecret: malformed ciphertext");
  const key = await getAesKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) },
    key,
    fromBase64(ctB64),
  );
  return new TextDecoder().decode(plaintext);
}

/* ------------------------------------------------------------------ */
/* Admin sessions                                                       */
/* ------------------------------------------------------------------ */

async function getHmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(requireSecret(env, "SESSION_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface SessionClaims {
  adminId: number;
  /** admins.session_version at sign-in; a password change bumps the row's
   *  version, which invalidates every token signed with an older one. */
  version: number;
}

/** Format: `<adminId>.<version>.<exp>.<base64url(HMAC-SHA256(SESSION_SECRET, adminId.version.exp))>`. */
export async function signSession(
  env: Env,
  claims: SessionClaims,
  expiresAtEpochSeconds: number,
): Promise<string> {
  const payload = `${claims.adminId}.${claims.version}.${expiresAtEpochSeconds}`;
  const key = await getHmacKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verifies the HMAC (timing-safe) and expiry, returning the claims or null.
 *  The caller still checks `version` against the admin row. */
export async function verifySession(env: Env, token: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [adminIdStr, versionStr, expStr, sig] = parts;
  if (!adminIdStr || !versionStr || !expStr || !sig) return null;

  const adminId = Number(adminIdStr);
  const version = Number(versionStr);
  const exp = Number(expStr);
  if (!Number.isSafeInteger(adminId) || adminId <= 0 || !Number.isSafeInteger(version) || !Number.isSafeInteger(exp)) {
    return null;
  }
  if (Math.floor(Date.now() / 1000) >= exp) return null;

  const key = await getHmacKey(env);
  const expectedSig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${adminIdStr}.${versionStr}.${expStr}`),
  );
  const expected = toBase64Url(new Uint8Array(expectedSig));

  return (await timingSafeEqualStr(sig, expected)) ? { adminId, version } : null;
}
