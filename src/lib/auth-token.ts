export const AUTH_COOKIE_NAME = "tj_auth_session";

function getSecretKeyString(): string {
  return (
    process.env.AUTH_SECRET ||
    process.env.MASTER_PASSWORD ||
    process.env.BINANCE_API_SECRET ||
    "trading-journal-fallback-secret-key-2026"
  );
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(sig);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 서명된 세션 토큰 생성 (Edge & Node 공용)
 * 포맷: `${expTimestamp}.${nonce}.${signatureHex}`
 */
export async function signSessionToken(ttlMs: number): Promise<string> {
  const exp = Date.now() + ttlMs;
  const nonceBytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(nonceBytes);
  const nonce = toHex(nonceBytes.buffer);
  const payload = `${exp}.${nonce}`;
  const sig = await hmacSha256Hex(payload, getSecretKeyString());
  return `${payload}.${sig}`;
}

/**
 * 세션 토큰 검증 (Edge & Node 공용)
 */
export async function verifySessionToken(token?: string | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) {
    return false;
  }

  const payload = `${expStr}.${nonce}`;
  const expectedSig = await hmacSha256Hex(payload, getSecretKeyString());
  return timingSafeEqualStr(sig, expectedSig);
}
