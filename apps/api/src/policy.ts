/**
 * Company policy for Rewards seasons. Changing a value here affects cycles
 * drafted afterwards; each cycle keeps the values it was drafted with.
 */
export interface Policy { prizeShareBp: number; instantShareBp: number; cardsPerDay: number; winningsTaxBp: number }

export const POLICY: Policy = {
  /** Prizes are paid from this share of full sell-out ticket sales (basis points: 5000 = 50%). */
  prizeShareBp: 5000,
  /** Share of the prize money allocated to instant cash wins (500 = 5%: ₦5,000,000 of the first wave's ₦100,000,000). */
  instantShareBp: 500,
  /** Cards one person may buy per Nigerian calendar day in a cycle. */
  cardsPerDay: 10,
  /**
   * Statutory deduction withheld from each cash prize (basis points). 0 until legal and
   * finance confirm the rate that applies: the admin app warns while it is 0.
   * (Affiliate fees are not set here: they are switched on by two people in the admin app.)
   */
  winningsTaxBp: 0,
};

const bp = (name: string, fallback: number, max = 10_000): number => {
  const v = process.env[name];
  if (v === undefined) return fallback;
  if (!/^\d{1,5}$/.test(v) || Number(v) > max || Number(v) < 0) throw new Error(`${name} must be a whole number from 0 to ${max}`);
  return Number(v);
};

/** Company policy, from settings where management has set them, otherwise the defaults above. */
export function policyFromEnv(): Policy {
  return {
    prizeShareBp: bp("WR_PRIZE_SHARE_BP", POLICY.prizeShareBp),
    instantShareBp: bp("WR_INSTANT_SHARE_BP", POLICY.instantShareBp),
    cardsPerDay: bp("WR_CARDS_PER_DAY", POLICY.cardsPerDay, 1000),
    winningsTaxBp: bp("WR_WINNINGS_TAX_BP", POLICY.winningsTaxBp, 5000),
  };
}

/** Basis-point share of an amount in kobo, rounded down (never in the company's favour against the prize budget: budgets are ceilings). */
export const share = (kobo: number, bp: number): number => Math.floor((kobo * bp) / 10_000);
