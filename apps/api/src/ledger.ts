import type { Db } from "./db.ts";

type AccountKind = "ASSET" | "LIABILITY" | "REVENUE" | "EXPENSE";

export interface AccountRef {
  code: string;
  kind: AccountKind;
  userId?: string;
  cycleId?: string;
}

export const accounts = {
  gatewayClearing: (): AccountRef => ({ code: "GATEWAY_CLEARING", kind: "ASSET" }),
  refundsPayable: (): AccountRef => ({ code: "REFUNDS_PAYABLE", kind: "LIABILITY" }),
  payoutsInTransit: (): AccountRef => ({ code: "PAYOUTS_IN_TRANSIT", kind: "LIABILITY" }),
  ticketRevenue: (cycleId: string): AccountRef => ({ code: `TICKET_REVENUE:${cycleId}`, kind: "REVENUE", cycleId }),
  prizeExpense: (cycleId: string): AccountRef => ({ code: `PRIZE_EXPENSE:${cycleId}`, kind: "EXPENSE", cycleId }),
  playerWinnings: (userId: string): AccountRef => ({ code: `PLAYER_WINNINGS:${userId}`, kind: "LIABILITY", userId }),
};

/**
 * Looks an account up, creating it on first use. The common case is a plain
 * read, so busy accounts such as GATEWAY_CLEARING are never locked.
 */
async function accountId(db: Db, a: AccountRef): Promise<string> {
  const find = () => db.query<{ id: string }>("SELECT id FROM ledger_accounts WHERE code = $1", [a.code]);
  const existing = await find();
  if (existing.rows[0]) return existing.rows[0].id;
  await db.query(
    "INSERT INTO ledger_accounts (code, kind, user_id, cycle_id) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING",
    [a.code, a.kind, a.userId ?? null, a.cycleId ?? null]);
  return (await find()).rows[0]!.id;
}

export interface Posting {
  kind: "TICKET_SALE" | "INSTANT_PRIZE" | "DRAW_PRIZE" | "PAYOUT" | "PAYOUT_REVERSAL" | "REFUND" | "ADJUSTMENT";
  /** Unique name of the business event. Posting the same reference twice is rejected by the database. */
  reference: string;
  cycleId?: string | undefined;
  memo?: string;
  /** Money moves from `credit` to `debit`. */
  debit: AccountRef;
  credit: AccountRef;
  amountKobo: number;
}

export async function post(db: Db, p: Posting): Promise<void> {
  if (!Number.isSafeInteger(p.amountKobo) || p.amountKobo <= 0) throw new Error("ledger amount must be a positive integer");
  const tx = await db.query<{ id: string }>(
    "INSERT INTO ledger_transactions (kind, reference, cycle_id, memo) VALUES ($1, $2, $3, $4) RETURNING id",
    [p.kind, p.reference, p.cycleId ?? null, p.memo ?? null],
  );
  // Accounts are resolved in a fixed order so two postings can never wait on each other.
  const ids = new Map<string, string>();
  for (const a of [p.debit, p.credit].sort((x, y) => (x.code < y.code ? -1 : 1))) ids.set(a.code, await accountId(db, a));
  const debitId = ids.get(p.debit.code)!, creditId = ids.get(p.credit.code)!;
  await db.query(
    "INSERT INTO ledger_entries (transaction_id, account_id, amount_kobo) VALUES ($1, $2, $3), ($1, $4, $5)",
    [tx.rows[0]!.id, debitId, p.amountKobo, creditId, -p.amountKobo],
  );
}

/** Raw signed balance: positive = net debit. */
export async function balance(db: Db, code: string): Promise<number> {
  const r = await db.query<{ b: number }>(
    `SELECT coalesce(sum(e.amount_kobo), 0)::bigint AS b
     FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id WHERE a.code = $1`,
    [code],
  );
  return r.rows[0]!.b;
}
