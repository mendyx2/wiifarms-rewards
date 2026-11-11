import { createHash, createHmac } from "node:crypto";

/** Version tag mixed into every hash so a future format change can never collide with this one. */
export const FORMAT_VERSION = "wiifarm-rewards/v1";

export function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]): Buffer {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
}

/**
 * Unambiguous encoding of a list of fields: each field is prefixed with its
 * byte length as a 4-byte big-endian integer. Without this, ("ab","c") and
 * ("a","bc") would hash identically.
 */
export function encodeFields(fields: readonly (string | Uint8Array)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const f of fields) {
    const bytes = typeof f === "string" ? Buffer.from(f, "utf8") : Buffer.from(f);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

export function u64be(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}
