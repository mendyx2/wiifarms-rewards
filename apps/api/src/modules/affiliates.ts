import { audit, SYSTEM } from "../audit.ts";
import { one, type Db } from "../db.ts";
import { accounts, post } from "../ledger.ts";

/**
 * The former affiliate programme (SRS section 13), replaced by simple player
 * referrals (referrals.ts): every player now earns 10% of friends' card
 * purchases into their wallet, with no application or approval. Affiliate
 * records made under the earlier model are kept unchanged; fees recorded then
 * are still taken back if the purchase they came from is refunded.
 */

/** Takes back the fee on a refunded purchase. If it was already paid out, Compliance is told to recover it. */
export async function reverseAffiliateFee(db: Db, orderId: string): Promise<void> {
  const f = await one<{ affiliate_id: string; cycle_id: string; amount_kobo: number; settlement_id: string | null }>(db,
    "UPDATE affiliate_fees SET status = 'REVERSED', reversed_at = now() WHERE order_id = $1 AND status = 'ACCRUED' RETURNING affiliate_id, cycle_id, amount_kobo, settlement_id", [orderId]);
  if (!f || !Number(f.amount_kobo)) return;
  await post(db, { kind: "AFFILIATE_FEE_REVERSAL", reference: `order:${orderId}:affiliate:reversed`, cycleId: f.cycle_id, memo: "Attributed purchase refunded",
    debit: accounts.affiliatePayable(f.affiliate_id), credit: accounts.affiliateExpense(f.cycle_id), amountKobo: Number(f.amount_kobo) });
  await audit(db, SYSTEM, "affiliate.fee_reversed", "order", orderId, { affiliateId: f.affiliate_id, amountKobo: f.amount_kobo });
  const paid = f.settlement_id ? await one(db, "SELECT 1 FROM affiliate_settlements WHERE id = $1 AND status = 'PAID'", [f.settlement_id]) : null;
  if (paid) {
    await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('AFFILIATE_RECOVERY_REQUIRED', 'WARNING', 'affiliate', $1, $2)",
      [f.affiliate_id, JSON.stringify({ owedKobo: Number(f.amount_kobo), orderId })]);
  }
}

