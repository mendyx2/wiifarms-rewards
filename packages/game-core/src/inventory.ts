import { SeededStream, shuffle } from "./random.ts";

/**
 * Fixed ticket inventory.
 *
 * A prize table gives exact counts, not probabilities: "100 tickets win
 * ₦1,000" means exactly 100, so the instant-prize liability of a cycle is
 * known to the kobo before a single ticket is sold.
 */

export interface PrizeTier {
  /** Canonical outcome code, e.g. "CASH:100000" (kobo). */
  outcome: string;
  count: number;
}

export const NO_WIN = "NONE";

/** Returns one outcome per ticket, in shuffled order. Index i belongs to the i-th serial. */
export function generateOutcomes(totalTickets: number, tiers: readonly PrizeTier[], seed: Uint8Array): string[] {
  if (!Number.isSafeInteger(totalTickets) || totalTickets <= 0) throw new RangeError("totalTickets must be positive");
  const seen = new Set<string>();
  const outcomes: string[] = [];
  for (const tier of tiers) {
    if (tier.outcome === NO_WIN) throw new Error("NONE is implied; do not list it as a tier");
    if (seen.has(tier.outcome)) throw new Error(`duplicate tier: ${tier.outcome}`);
    seen.add(tier.outcome);
    if (!Number.isSafeInteger(tier.count) || tier.count < 0) throw new RangeError("tier count must be a non-negative integer");
    for (let i = 0; i < tier.count; i++) outcomes.push(tier.outcome);
  }
  if (outcomes.length > totalTickets) throw new RangeError("more prizes than tickets");
  while (outcomes.length < totalTickets) outcomes.push(NO_WIN);
  return shuffle(outcomes, new SeededStream(seed));
}

/** Total instant-cash liability of a prize table, in kobo. Only "CASH:<kobo>" outcomes count. */
export function instantCashLiabilityKobo(tiers: readonly PrizeTier[]): bigint {
  let total = 0n;
  for (const tier of tiers) {
    const m = /^CASH:(\d+)$/.exec(tier.outcome);
    if (m) total += BigInt(m[1]!) * BigInt(tier.count);
  }
  return total;
}
