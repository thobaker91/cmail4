// Cmail — TOTP (RFC 6238) implementation + vault helpers
import { b64, str } from './util';

// ---------- base32 (RFC 4648) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function randomSecret(bytes = 20): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base32Encode(buf);
}

// ---------- HMAC-based OTP ----------

async function hmac(algo: 'SHA-1' | 'SHA-256' | 'SHA-512', keyBytes: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as unknown as ArrayBuffer, { name: 'HMAC', hash: algo }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, msg as unknown as ArrayBuffer);
  return new Uint8Array(sig);
}

export async function hotp(secretB32: string, counter: number, algo = 'SHA1', digits = 6): Promise<string> {
  const key = base32Decode(secretB32);
  const msg = new Uint8Array(8);
  // big-endian counter
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const map = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' } as const;
  const h = await hmac((map as Record<string, 'SHA-1' | 'SHA-256' | 'SHA-512'>)[algo] ?? 'SHA-1', key, msg);
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  const code = (bin % 10 ** digits).toString().padStart(digits, '0');
  return code;
}

export async function totp(secretB32: string, algo = 'SHA1', digits = 6, period = 30, at = Date.now()): Promise<string> {
  return hotp(secretB32, Math.floor(at / 1000 / period), algo, digits);
}

export async function totpRemaining(period = 30, at = Date.now()): Promise<number> {
  return period - Math.floor(at / 1000) % period;
}

export async function verifyTotp(secretB32: string, code: string, algo = 'SHA1', digits = 6, period = 30, window = 1): Promise<boolean> {
  const counter = Math.floor(Date.now() / 1000 / period);
  for (let i = -window; i <= window; i++) {
    const c = await hotp(secretB32, counter + i, algo, digits);
    if (c === code.trim()) return true;
  }
  return false;
}

// ---------- otpauth:// URI ----------

export type TotpConfig = { secret: string; issuer?: string; name?: string; algo: string; digits: number; period: number };

export function parseOtpauthUri(uri: string): TotpConfig | null {
  try {
    if (!uri.startsWith('otpauth://totp/')) return null;
    const u = new URL(uri);
    const label = decodeURIComponent(u.pathname.replace('/totp/', ''));
    const [issuerFromLabel, name] = label.includes(':') && !label.includes('@')
      ? [label.split(':')[0], label.split(':').slice(1).join(':')]
      : [u.searchParams.get('issuer') ?? undefined, label.includes('@') ? label.split('@')[0] : label];
    const secret = u.searchParams.get('secret');
    if (!secret) return null;
    // validate
    base32Decode(secret);
    return {
      secret: secret.toUpperCase().replace(/\s/g, ''),
      issuer: issuerFromLabel ?? u.searchParams.get('issuer') ?? undefined,
      name: name ?? undefined,
      algo: (u.searchParams.get('algorithm') ?? 'SHA1').toUpperCase(),
      digits: Math.min(10, Math.max(6, parseInt(u.searchParams.get('digits') ?? '6', 10) || 6)),
      period: Math.min(120, Math.max(15, parseInt(u.searchParams.get('period') ?? '30', 10) || 30)),
    };
  } catch {
    return null;
  }
}

export function buildOtpauthUri(cfg: TotpConfig): string {
  const label = `${cfg.issuer ?? 'Cmail'}:${cfg.name ?? 'code'}`;
  const p = new URLSearchParams({ secret: cfg.secret, issuer: cfg.issuer ?? 'Cmail', algorithm: cfg.algo, digits: String(cfg.digits), period: String(cfg.period) });
  return `otpauth://totp/${encodeURIComponent(label)}?${p.toString()}`;
}

// ---------- helpers ----------

export function normalizeSecret(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'L')
    .split('')
    .map((ch) => (B32.includes(ch) ? ch : ''))
    .join('');
}

export function secretToBytes(secret: string): Uint8Array { return base32Decode(secret); }
export { b64, str };
