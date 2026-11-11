import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

export const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

export const keyedHash = (key: Uint8Array, purpose: string, value: string): Buffer =>
  createHmac("sha256", key).update(purpose).update("\0").update(value).digest();

export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

export const newOtp = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

// --- PIN hashing (scrypt; parameters stored with the hash so they can be raised later) ---

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function scryptAsync(secret: string, salt: Buffer, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, 32, { ...SCRYPT, N }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pin, salt, SCRYPT.N);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !n || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scryptAsync(pin, Buffer.from(salt, "base64"), Number(n));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- Authenticated encryption (AES-256-GCM): iv(12) | tag(16) | ciphertext ---

export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function open(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  const buf = Buffer.from(sealed);
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

/**
 * Key service boundary. In production this is cloud KMS, and only the reveal
 * and draw services are granted unwrap. LocalKeyService exists for simulation.
 */
export interface KeyService {
  readonly ref: string;
  wrap(dataKey: Buffer, context: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: string): Promise<Buffer>;
}

export class LocalKeyService implements KeyService {
  readonly ref = "local-simulation:v1";
  readonly #master: Buffer;
  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
    this.#master = masterKey;
  }
  async wrap(dataKey: Buffer, context: string): Promise<Buffer> {
    return seal(this.#master, dataKey, context);
  }
  async unwrap(wrapped: Buffer, context: string): Promise<Buffer> {
    return open(this.#master, wrapped, context);
  }
}
