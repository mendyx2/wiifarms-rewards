import { timingSafeEqual } from "node:crypto";
import { FORMAT_VERSION, encodeFields, hmacSha256, sha256 } from "./encoding.ts";
import { SeededStream } from "./random.ts";

/**
 * Final draw.
 *
 * 1. Before the cycle closes the operator publishes commitSecret(secret).
 * 2. At close the eligible entries are frozen and entriesHash() is published.
 * 3. A public randomness beacon round, announced in advance, supplies beaconValue.
 * 4. seed = deriveDrawSeed(...) and runDraw() picks the winners.
 *
 * The operator cannot predict the beacon; outsiders do not know the secret; and
 * once both are published anyone can re-run runDraw() and get the same winners.
 */

export interface DrawPrize {
  /** Stable identifier of the prize in the published prize schedule. */
  prizeId: string;
  /** How many of this prize are drawn. */
  quantity: number;
}

export interface DrawWinner {
  prizeId: string;
  /** 1-based position within the prize's quantity. */
  position: number;
  serial: string;
}

export function commitSecret(secret: Uint8Array): Buffer {
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  return sha256(encodeFields([FORMAT_VERSION, "draw-secret", secret]));
}

export function verifySecretCommitment(secret: Uint8Array, commitment: Uint8Array): boolean {
  const c = commitSecret(secret);
  return c.length === commitment.length && timingSafeEqual(c, commitment);
}

/** Entries are sorted so the hash does not depend on database ordering. Duplicates are rejected. */
export function canonicalEntries(serials: readonly string[]): string[] {
  const sorted = [...serials].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) throw new Error(`duplicate entry: ${sorted[i]}`);
  }
  return sorted;
}

export function entriesHash(cycleId: string, serials: readonly string[]): Buffer {
  return sha256(encodeFields([FORMAT_VERSION, "draw-entries", cycleId, ...canonicalEntries(serials)]));
}

export function deriveDrawSeed(args: {
  secret: Uint8Array;
  beaconValue: Uint8Array;
  cycleId: string;
  entriesHash: Uint8Array;
}): Buffer {
  if (args.secret.length !== 32) throw new Error("secret must be 32 bytes");
  if (args.beaconValue.length < 32) throw new Error("beacon value must be at least 32 bytes");
  return hmacSha256(
    args.secret,
    encodeFields([FORMAT_VERSION, "draw-seed", args.cycleId, args.entriesHash, args.beaconValue]),
  );
}

/**
 * Draws winners without replacement: prizes are processed in the published
 * order, and a ticket that wins is removed before the next pick, so one ticket
 * wins at most one final-draw prize. (One account holding several tickets can
 * still win several prizes — each ticket stands on its own.)
 *
 * If there are fewer entries than prizes, the remaining prizes are left
 * undrawn and are handled under the published rules.
 */
export function runDraw(serials: readonly string[], prizes: readonly DrawPrize[], seed: Uint8Array): DrawWinner[] {
  const pool = canonicalEntries(serials);
  const stream = new SeededStream(seed);
  const winners: DrawWinner[] = [];
  let remaining = pool.length;

  for (const prize of prizes) {
    if (!Number.isInteger(prize.quantity) || prize.quantity < 0) throw new RangeError("invalid prize quantity");
    for (let position = 1; position <= prize.quantity; position++) {
      if (remaining === 0) return winners;
      const pick = stream.nextInt(remaining);
      const serial = pool[pick]!;
      // Move the last live entry into the picked slot and shrink the pool.
      pool[pick] = pool[remaining - 1]!;
      remaining--;
      winners.push({ prizeId: prize.prizeId, position, serial });
    }
  }
  return winners;
}
