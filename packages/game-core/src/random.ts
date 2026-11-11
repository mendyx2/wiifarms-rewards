import { hmacSha256, u64be } from "./encoding.ts";

/**
 * Deterministic random stream derived from a 32-byte seed.
 *
 * Block i is HMAC-SHA-256(seed, i). The same seed always yields the same
 * stream, which is what makes a shuffle or draw independently reproducible.
 * The seed itself must come from an approved source (see the game-core spec).
 */
export class SeededStream {
  readonly #seed: Buffer;
  #counter = 0n;
  #block: Buffer = Buffer.alloc(0);
  #offset = 0;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("seed must be 32 bytes");
    this.#seed = Buffer.from(seed);
  }

  #nextUint64(): bigint {
    if (this.#offset + 8 > this.#block.length) {
      this.#block = hmacSha256(this.#seed, u64be(this.#counter++));
      this.#offset = 0;
    }
    const v = this.#block.readBigUInt64BE(this.#offset);
    this.#offset += 8;
    return v;
  }

  /**
   * Uniform integer in [0, n). Uses rejection sampling: values in the uneven
   * tail of the 64-bit range are discarded, so every result is exactly equally
   * likely (a plain `% n` would slightly favour low numbers).
   */
  nextInt(n: number): number {
    if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError("n must be a positive safe integer");
    const range = BigInt(n);
    const limit = (1n << 64n) - ((1n << 64n) % range);
    for (;;) {
      const v = this.#nextUint64();
      if (v < limit) return Number(v % range);
    }
  }
}

/** Fisher–Yates shuffle. Returns a new array; the input is not modified. */
export function shuffle<T>(items: readonly T[], stream: SeededStream): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = stream.nextInt(i + 1);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}
