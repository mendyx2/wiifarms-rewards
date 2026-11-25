import { randomBytes } from "node:crypto";
import { audit, SYSTEM, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { lockKey, one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { share } from "../policy.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { onExclusionRegister, type User } from "./identity.ts";
import { notify } from "./notify.ts";

/**
 * Digital affiliates (SRS section 13), replacing customer referral commissions.
 *
 * - Separate application: verified identity with the liveness check, contact
 *   details, territory, a bank account in the applicant's own verified name,
 *   the affiliate agreement and the compliance training.
 * - Compliance approves or rejects, and can suspend, reinstate or end an
 *   approval. Every change is kept (affiliate_history and the audit log).
 * - An approved affiliate gets a unique 8-character attribution code. Players
 *   who open an account with it are attributed to the affiliate for good.
 * - Fees: a percentage of the attributed players' purchases in the
 *   affiliate's territory, from the operator's share, and only while the fee
 *   programme is switched on. Switching it on (or changing the rate) takes two
 *   people and the reference of the legal approval. While it is off, sales are
 *   still recorded against the affiliate with a fee of 0.
 * - No downlines and no recruitment bonuses: fees come only from purchases
 *   by the players an affiliate brought, never from other affiliates.
 * - Settlements: Finance prepares one for an affiliate's unpaid fees; a
 *   payout approver (a different person) approves it, and it is paid to the
 *   affiliate's verified bank account (simulated).
 */

export const AFFILIATE_AGREEMENT_VERSION = "2026-11-25-draft";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;

function newCode(): string {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i]! & 31];
  return s;
}

function dbRule(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "affiliates_user_id_key") throw conflict("ALREADY_APPLIED", "You have already applied to be an affiliate.");
  if (e.code === "23505" && e.constraint === "affiliate_programme_one_open") throw conflict("ALREADY_REQUESTED", "A change to the fee programme is already waiting for a decision.");
  if (e.code === "23505" && e.constraint === "affiliate_settlements_one_open") throw conflict("SETTLEMENT_OPEN", "A settlement for this affiliate is already waiting for approval.");
  if (e.code === "23000") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  if (e.code === "23514") throw conflict("RULE_VIOLATION", "That is not allowed (for example, deciding your own request).");
  throw err;
}

/** An approved affiliate's code, for a new sign-up. Codes are typed by people: case and spaces do not matter. */
export async function findAffiliateByCode(db: Db, normalisedCode: string): Promise<string | null> {
  if (!CODE.test(normalisedCode)) return null;
  const a = await one<{ id: string }>(db, "SELECT id FROM affiliates WHERE attribution_code = $1 AND status = 'APPROVED'", [normalisedCode]);
  return a?.id ?? null;
}
export const isAffiliateCode = (normalisedCode: string): boolean => CODE.test(normalisedCode);

// --- Applying ----------------------------------------------------------------------------------

export interface AffiliateApplication {
  businessName: string; contactEmail: string; territoryArea?: string; channels: string; bankAccountId: string;
  acceptAgreement: boolean; trainingCompleted: boolean;
}

export async function applyAsAffiliate(ctx: Ctx, actor: Actor, user: User, input: AffiliateApplication): Promise<{ reference: string }> {
  if (user.kyc_tier < 2) throw forbidden("LIVENESS_REQUIRED", "Affiliates are paid, so complete the liveness check first.");
  if (!input.acceptAgreement) throw badRequest("AGREEMENT_REQUIRED", "Read and accept the affiliate agreement.");
  if (!input.trainingCompleted) throw badRequest("TRAINING_REQUIRED", "Complete the compliance training first.");
  return withTx(ctx.pool, async (db) => {
    if (await onExclusionRegister(db, user)) throw forbidden("NOT_ELIGIBLE", "You cannot be an affiliate. Please contact support if you think this is wrong.");
    const bank = await one<{ name_match: boolean; status: string }>(db, "SELECT name_match, status FROM bank_accounts WHERE id = $1 AND user_id = $2", [input.bankAccountId, user.id]);
    if (!bank || bank.status !== "ACTIVE" || !bank.name_match) {
      throw badRequest("BANK_ACCOUNT_REQUIRED", "Choose a bank account in your own verified name. Add one on the Wallet page first.");
    }
    const seq = (await one<{ n: string }>(db, "SELECT nextval('affiliate_reference_seq')::text AS n"))!.n;
    const reference = `AFF-${seq.padStart(6, "0")}`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO affiliates (user_id, reference, business_name, contact_email, contact_phone, territory_state, territory_area, channels,
                               bank_account_id, agreement_version, agreement_accepted_at, training_completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now()) RETURNING id`,
      [user.id, reference, input.businessName.trim(), input.contactEmail.trim(), user.phone_e164, user.state_code, input.territoryArea?.trim() || null,
        input.channels.trim(), input.bankAccountId, AFFILIATE_AGREEMENT_VERSION]).catch(dbRule);
    await db.query("INSERT INTO affiliate_history (affiliate_id, status) VALUES ($1, 'APPLIED')", [r.rows[0]!.id]);
    await audit(db, actor, "affiliate.applied", "affiliate", r.rows[0]!.id, { reference, territory: user.state_code });
    return { reference };
  });
}

/** What an affiliate (or applicant) sees. Never who the attributed players are: only counts and amounts. */
export async function affiliateDashboard(ctx: Ctx, userId: string): Promise<unknown> {
  const a = await one<{ id: string; reference: string; attribution_code: string | null; business_name: string; territory_state: string; territory_area: string | null;
    status: string; created_at: Date; decided_at: Date | null; agreement_version: string }>(ctx.pool,
    `SELECT id, reference, attribution_code, business_name, territory_state, territory_area, status, created_at, decided_at, agreement_version
     FROM affiliates WHERE user_id = $1`, [userId]);
  const programme = await programmeState(ctx.pool);
  if (!a) return { affiliate: null, agreementVersion: AFFILIATE_AGREEMENT_VERSION, programme };
  const s = (await one<{ signups: number; buyers: number; cards: number; sales: string; accrued: string; pending: string; paid: string }>(ctx.pool,
    `SELECT (SELECT count(*) FROM users WHERE affiliate_id = $1)::int AS signups,
            count(DISTINCT f.buyer_id) FILTER (WHERE f.status = 'ACCRUED')::int AS buyers,
            coalesce(sum(f.cards) FILTER (WHERE f.status = 'ACCRUED'), 0)::int AS cards,
            coalesce(sum(f.sales_kobo) FILTER (WHERE f.status = 'ACCRUED'), 0)::bigint AS sales,
            coalesce(sum(f.amount_kobo) FILTER (WHERE f.status = 'ACCRUED'), 0)::bigint AS accrued,
            coalesce(sum(f.amount_kobo) FILTER (WHERE f.status = 'ACCRUED' AND (f.settlement_id IS NULL OR st.status <> 'PAID')), 0)::bigint AS pending,
            coalesce(sum(f.amount_kobo) FILTER (WHERE f.status = 'ACCRUED' AND st.status = 'PAID'), 0)::bigint AS paid
     FROM affiliate_fees f LEFT JOIN affiliate_settlements st ON st.id = f.settlement_id WHERE f.affiliate_id = $1`, [a.id]))!;
  const statements = (await ctx.pool.query(
    "SELECT id, amount_kobo, fees_count, status, payment_ref, created_at, decided_at FROM affiliate_settlements WHERE affiliate_id = $1 AND status <> 'REJECTED' ORDER BY created_at DESC LIMIT 24",
    [a.id])).rows.map((r) => ({ ...r, amount_kobo: Number(r.amount_kobo) }));
  return {
    affiliate: { reference: a.reference, status: a.status, businessName: a.business_name, territory: a.territory_state, territoryArea: a.territory_area,
      appliedAt: a.created_at, decidedAt: a.decided_at, code: a.status === "APPROVED" ? a.attribution_code : null,
      link: a.status === "APPROVED" ? `/r/${a.attribution_code}` : null, agreementVersion: a.agreement_version },
    stats: { signUps: s.signups, buyers: s.buyers, cards: s.cards, salesKobo: Number(s.sales), earnedKobo: Number(s.accrued), pendingKobo: Number(s.pending), paidKobo: Number(s.paid) },
    statements, programme, agreementVersion: AFFILIATE_AGREEMENT_VERSION,
  };
}

// --- Fees on purchases ------------------------------------------------------------------------

async function programmeState(db: Db | Ctx["pool"]): Promise<{ enabled: boolean; ratePercent: number }> {
  const p = (await one<{ remuneration_enabled: boolean; rate_bp: number }>(db, "SELECT remuneration_enabled, rate_bp FROM affiliate_programme"))!;
  return { enabled: p.remuneration_enabled, ratePercent: p.rate_bp / 100 };
}

/**
 * Records the affiliate's fee on a completed purchase, in the purchase's
 * transaction. Nothing is earned by an affiliate that is not approved, on
 * purchases outside their territory, or by someone now on the exclusion register.
 */
export async function creditAffiliateFee(db: Db, order: { id: string; user_id: string; cycle_id: string; quantity: number; amount_kobo: number }): Promise<void> {
  const a = await one<User & { affiliate_id: string; affiliate_status: string; territory_state: string; buyer_state: string | null }>(db,
    `SELECT af.id AS affiliate_id, af.status AS affiliate_status, af.territory_state, b.state_code AS buyer_state,
            u.id, u.phone_e164, u.full_name, u.date_of_birth::text, u.kyc_tier, u.identity_hash, u.state_code, u.status, u.language
     FROM users b JOIN affiliates af ON af.id = b.affiliate_id JOIN users u ON u.id = af.user_id WHERE b.id = $1`, [order.user_id]);
  if (!a || a.affiliate_status !== "APPROVED" || a.id === order.user_id || a.buyer_state !== a.territory_state) return;
  if (a.status === "CLOSED" || (await onExclusionRegister(db, a))) return;
  const p = (await one<{ remuneration_enabled: boolean; rate_bp: number }>(db, "SELECT remuneration_enabled, rate_bp FROM affiliate_programme"))!;
  const rateBp = p.remuneration_enabled ? p.rate_bp : 0;
  const amount = share(Number(order.amount_kobo), rateBp);
  const row = await db.query(
    `INSERT INTO affiliate_fees (order_id, affiliate_id, buyer_id, cycle_id, cards, sales_kobo, rate_bp, amount_kobo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (order_id) DO NOTHING`,
    [order.id, a.affiliate_id, order.user_id, order.cycle_id, order.quantity, order.amount_kobo, rateBp, amount]);
  if (!row.rowCount || amount <= 0) return;
  await post(db, { kind: "AFFILIATE_FEE", reference: `order:${order.id}:affiliate`, cycleId: order.cycle_id,
    debit: accounts.affiliateExpense(order.cycle_id), credit: accounts.affiliatePayable(a.affiliate_id), amountKobo: amount });
}

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

// --- Administration ---------------------------------------------------------------------------

const VIEWERS = ["COMPLIANCE", "FINANCE", "PAYOUT_APPROVER", "AUDITOR"] as const;

export async function listAffiliates(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, ...VIEWERS);
  const rows = (await ctx.pool.query(
    `SELECT a.id, a.reference, a.business_name, a.contact_email, a.territory_state, a.territory_area, a.channels, a.status, a.attribution_code,
            a.agreement_version, a.created_at, a.decided_at, u.full_name, u.kyc_tier, b.name_match AS bank_name_match,
            (SELECT count(*) FROM users x WHERE x.affiliate_id = a.id)::int AS sign_ups,
            (SELECT coalesce(sum(f.sales_kobo), 0) FROM affiliate_fees f WHERE f.affiliate_id = a.id AND f.status = 'ACCRUED')::bigint AS sales_kobo,
            (SELECT coalesce(sum(f.amount_kobo), 0) FROM affiliate_fees f WHERE f.affiliate_id = a.id AND f.status = 'ACCRUED' AND f.settlement_id IS NULL)::bigint AS unsettled_kobo,
            (SELECT row_to_json(s) FROM (SELECT id, amount_kobo, fees_count, prepared_by, created_at FROM affiliate_settlements WHERE affiliate_id = a.id AND status = 'PROPOSED') s) AS open_settlement
     FROM affiliates a JOIN users u ON u.id = a.user_id JOIN bank_accounts b ON b.id = a.bank_account_id
     ORDER BY (a.status = 'APPLIED') DESC, a.created_at DESC LIMIT 500`)).rows
    .map((r) => ({ ...r, sales_kobo: Number(r.sales_kobo), unsettled_kobo: Number(r.unsettled_kobo) }));
  const changes = (await ctx.pool.query(
    `SELECT c.id, c.enable, c.rate_bp, c.legal_reference, c.reason, c.status, c.created_at, c.decided_at, c.requested_by, r.full_name AS requested_by_name, d.full_name AS decided_by_name
     FROM affiliate_programme_changes c JOIN admin_users r ON r.id = c.requested_by LEFT JOIN admin_users d ON d.id = c.decided_by ORDER BY c.created_at DESC LIMIT 20`)).rows;
  const p = (await one<Record<string, unknown>>(ctx.pool, "SELECT remuneration_enabled, rate_bp, legal_reference, updated_at FROM affiliate_programme"))!;
  return { affiliates: rows, programme: p, programmeChanges: changes, agreementVersion: AFFILIATE_AGREEMENT_VERSION };
}

type Decision = "APPROVE" | "REJECT" | "SUSPEND" | "REINSTATE" | "TERMINATE";
const MOVES: Record<Decision, { from: string[]; to: string; verb: string }> = {
  APPROVE: { from: ["APPLIED"], to: "APPROVED", verb: "approved" },
  REJECT: { from: ["APPLIED"], to: "REJECTED", verb: "rejected" },
  SUSPEND: { from: ["APPROVED"], to: "SUSPENDED", verb: "suspended" },
  REINSTATE: { from: ["SUSPENDED"], to: "APPROVED", verb: "reinstated" },
  TERMINATE: { from: ["APPROVED", "SUSPENDED"], to: "TERMINATED", verb: "ended" },
};

const NOTICES: Record<string, { title: string; body: string; ha: { title: string; body: string } }> = {
  APPROVED: { title: "Affiliate application approved", body: "You are now an authorised WiiFarm Rewards affiliate. Your attribution code is on your affiliate page.",
    ha: { title: "An amince da neman zama wakili", body: "Yanzu kai wakilin WiiFarm Rewards ne da aka amince da shi. Lambar wakilcinka tana shafin wakili." } },
  REJECTED: { title: "Affiliate application not approved", body: "Your affiliate application was not approved. Contact support if you have questions.",
    ha: { title: "Ba a amince da neman zama wakili ba", body: "Ba a amince da neman zama wakilinka ba. Tuntuɓi masu taimako idan kana da tambaya." } },
  SUSPENDED: { title: "Affiliate account suspended", body: "Your affiliate account is suspended while Compliance reviews it. New sign-ups will not be attributed to you meanwhile.",
    ha: { title: "An dakatar da asusun wakili", body: "An dakatar da asusun wakilinka yayin da ake bincike. Ba za a danganta sababbin masu rajista da kai ba a wannan lokacin." } },
  TERMINATED: { title: "Affiliate agreement ended", body: "Your affiliate agreement has ended. Fees already earned will still be settled.",
    ha: { title: "An kawo ƙarshen yarjejeniyar wakili", body: "Yarjejeniyar wakilcinka ta ƙare. Za a biya kuɗin da ka riga ka samu." } },
};

export async function decideAffiliate(ctx: Ctx, admin: Admin, affiliateId: string, decision: Decision, reason?: string): Promise<{ status: string; code?: string }> {
  requireRole(admin, "COMPLIANCE");
  const move = MOVES[decision];
  if (decision !== "APPROVE" && !reason?.trim()) throw badRequest("REASON_REQUIRED", "Give the reason.");
  return withTx(ctx.pool, async (db) => {
    const a = await one<{ id: string; user_id: string; status: string; attribution_code: string | null; reference: string }>(db,
      "SELECT id, user_id, status, attribution_code, reference FROM affiliates WHERE id = $1 FOR UPDATE", [affiliateId]);
    if (!a) throw notFound("Affiliate not found.");
    if (!move.from.includes(a.status)) throw conflict("INVALID_STATUS", `This affiliate is ${a.status.toLowerCase()}, so it cannot be ${move.verb}.`);
    let code = a.attribution_code;
    if (decision === "APPROVE" && !code) {
      for (let i = 0; i < 5 && !code; i++) {
        const c = newCode();
        if (!(await one(db, "SELECT 1 FROM affiliates WHERE attribution_code = $1", [c]))) code = c;
      }
    }
    await db.query("UPDATE affiliates SET status = $2, attribution_code = $3, decided_by = $4, decided_at = now() WHERE id = $1", [a.id, move.to, code, admin.id]).catch(dbRule);
    await db.query("INSERT INTO affiliate_history (affiliate_id, status, by_admin, reason) VALUES ($1, $2, $3, $4)", [a.id, move.to, admin.id, reason?.trim() || null]);
    await audit(db, adminActor(admin), `affiliate.${move.verb}`, "affiliate", a.id, { reference: a.reference, reason: reason ?? null });
    const n = NOTICES[move.to] ?? NOTICES.APPROVED!;
    await notify(db, { userId: a.user_id, kind: "ACCOUNT", link: "#/affiliate", dedupeKey: `affiliate:${a.id}:${move.to}:${Date.now()}`, title: n.title, body: n.body, ha: n.ha });
    return { status: move.to, ...(code && move.to === "APPROVED" ? { code } : {}) };
  });
}

/** Asks for the fee programme to be switched on or off, or its rate changed. A second person decides. */
export async function requestProgrammeChange(ctx: Ctx, admin: Admin, input: { enable: boolean; ratePercent: number; legalReference?: string; reason: string }): Promise<{ id: string }> {
  requireRole(admin, "COMPLIANCE", "FINANCE");
  const rateBp = Math.round(input.ratePercent * 100);
  if (!Number.isFinite(rateBp) || rateBp < 0 || rateBp > 500) throw badRequest("INVALID_RATE", "The fee must be between 0% and 5%.");
  if (input.enable && !input.legalReference?.trim()) throw badRequest("LEGAL_APPROVAL_REQUIRED", "Give the reference of the legal approval for affiliate fees.");
  if (!input.reason.trim()) throw badRequest("REASON_REQUIRED", "Give the reason for the change.");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>(
      "INSERT INTO affiliate_programme_changes (enable, rate_bp, legal_reference, reason, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [input.enable, rateBp, input.legalReference?.trim() || null, input.reason.trim(), admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "affiliate_programme.change_requested", "affiliate_programme", r.rows[0]!.id, { ...input });
    return { id: r.rows[0]!.id };
  });
}

export async function decideProgrammeChange(ctx: Ctx, admin: Admin, changeId: string, approve: boolean, reason?: string): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE", "FINANCE");
  return withTx(ctx.pool, async (db) => {
    const c = await one<{ id: string; enable: boolean; rate_bp: number; legal_reference: string | null; requested_by: string; status: string }>(db,
      "SELECT id, enable, rate_bp, legal_reference, requested_by, status FROM affiliate_programme_changes WHERE id = $1 FOR UPDATE", [changeId]);
    if (!c) throw notFound("Request not found.");
    if (c.status !== "PENDING") throw conflict("ALREADY_DECIDED", "This request has already been decided.");
    if (c.requested_by === admin.id) throw forbidden("SAME_PERSON", "You made this request, so someone else must decide it.");
    if (!approve) {
      if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Give a reason for rejecting the request.");
      await db.query("UPDATE affiliate_programme_changes SET status = 'REJECTED', decided_by = $2, decided_at = now() WHERE id = $1", [c.id, admin.id]).catch(dbRule);
      await audit(db, adminActor(admin), "affiliate_programme.change_rejected", "affiliate_programme", c.id, { reason });
      return { status: "REJECTED" };
    }
    await db.query("UPDATE affiliate_programme SET remuneration_enabled = $1, rate_bp = $2, legal_reference = coalesce($3, legal_reference), updated_at = now()",
      [c.enable, c.rate_bp, c.legal_reference]);
    await db.query("UPDATE affiliate_programme_changes SET status = 'APPROVED', decided_by = $2, decided_at = now() WHERE id = $1", [c.id, admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "affiliate_programme.changed", "affiliate_programme", c.id, { enabled: c.enable, rateBp: c.rate_bp, legalReference: c.legal_reference });
    return { status: "APPROVED" };
  });
}

/** Finance gathers an affiliate's unpaid fees into a settlement, for a payout approver to approve. */
export async function prepareSettlement(ctx: Ctx, admin: Admin, affiliateId: string): Promise<{ id: string; amountKobo: number }> {
  requireRole(admin, "FINANCE");
  return withTx(ctx.pool, async (db) => {
    await lockKey(db, `affiliate:${affiliateId}`);
    const a = await one<{ status: string }>(db, "SELECT status FROM affiliates WHERE id = $1", [affiliateId]);
    if (!a) throw notFound("Affiliate not found.");
    if (a.status === "SUSPENDED") throw conflict("AFFILIATE_SUSPENDED", "This affiliate is suspended: settle after Compliance has finished the review.");
    const due = (await one<{ n: number; amount: string; latest: Date | null }>(db,
      "SELECT count(*)::int AS n, coalesce(sum(amount_kobo), 0)::bigint AS amount, max(created_at) AS latest FROM affiliate_fees WHERE affiliate_id = $1 AND status = 'ACCRUED' AND settlement_id IS NULL AND amount_kobo > 0",
      [affiliateId]))!;
    if (!due.n) throw conflict("NOTHING_DUE", "This affiliate has no unpaid fees.");
    const s = await db.query<{ id: string }>(
      "INSERT INTO affiliate_settlements (affiliate_id, amount_kobo, fees_count, period_to, prepared_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [affiliateId, due.amount, due.n, due.latest, admin.id]).catch(dbRule);
    const id = s.rows[0]!.id;
    await db.query("UPDATE affiliate_fees SET settlement_id = $2 WHERE affiliate_id = $1 AND status = 'ACCRUED' AND settlement_id IS NULL AND amount_kobo > 0", [affiliateId, id]);
    await audit(db, adminActor(admin), "affiliate.settlement_prepared", "affiliate", affiliateId, { settlementId: id, amountKobo: Number(due.amount), fees: due.n });
    return { id, amountKobo: Number(due.amount) };
  });
}

export async function decideSettlement(ctx: Ctx, admin: Admin, settlementId: string, approve: boolean, reason?: string): Promise<{ status: string; paymentRef?: string }> {
  requireRole(admin, "PAYOUT_APPROVER");
  return withTx(ctx.pool, async (db) => {
    const s = await one<{ id: string; affiliate_id: string; amount_kobo: number; status: string; prepared_by: string }>(db,
      "SELECT id, affiliate_id, amount_kobo, status, prepared_by FROM affiliate_settlements WHERE id = $1 FOR UPDATE", [settlementId]);
    if (!s) throw notFound("Settlement not found.");
    if (s.status !== "PROPOSED") throw conflict("ALREADY_DECIDED", "This settlement has already been decided.");
    if (s.prepared_by === admin.id) throw forbidden("SAME_PERSON", "You prepared this settlement, so someone else must approve it.");
    await lockKey(db, `affiliate:${s.affiliate_id}`);
    const now = (await one<{ amount: string }>(db, "SELECT coalesce(sum(amount_kobo), 0)::bigint AS amount FROM affiliate_fees WHERE settlement_id = $1 AND status = 'ACCRUED'", [s.id]))!;
    const a = await one<{ status: string; reference: string; user_id: string }>(db, "SELECT status, reference, user_id FROM affiliates WHERE id = $1", [s.affiliate_id]);
    if (approve && (Number(now.amount) !== Number(s.amount_kobo) || a!.status === "SUSPENDED")) {
      throw conflict("SETTLEMENT_CHANGED", a!.status === "SUSPENDED" ? "This affiliate has been suspended: reject the settlement." : "Fees in this settlement have changed since it was prepared: reject it and prepare it again.");
    }
    if (!approve) {
      if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Give a reason for rejecting the settlement.");
      await db.query("UPDATE affiliate_fees SET settlement_id = NULL WHERE settlement_id = $1", [s.id]);
      await db.query("UPDATE affiliate_settlements SET status = 'REJECTED', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1", [s.id, admin.id, reason.trim()]).catch(dbRule);
      await audit(db, adminActor(admin), "affiliate.settlement_rejected", "affiliate", s.affiliate_id, { settlementId: s.id, reason });
      return { status: "REJECTED" };
    }
    // Simulated: in production this is a transfer to the affiliate's verified bank account through the payout provider.
    const paymentRef = `SIMAFF-${s.id.slice(0, 8)}`;
    await post(db, { kind: "AFFILIATE_SETTLEMENT", reference: `affiliate-settlement:${s.id}`, memo: `Affiliate ${a!.reference}`,
      debit: accounts.affiliatePayable(s.affiliate_id), credit: accounts.companyBank(), amountKobo: Number(s.amount_kobo) });
    await db.query("UPDATE affiliate_settlements SET status = 'PAID', decided_by = $2, decided_at = now(), payment_ref = $3 WHERE id = $1", [s.id, admin.id, paymentRef]).catch(dbRule);
    await audit(db, adminActor(admin), "affiliate.settlement_paid", "affiliate", s.affiliate_id, { settlementId: s.id, amountKobo: Number(s.amount_kobo), paymentRef });
    await notify(db, { userId: a!.user_id, kind: "ACCOUNT", link: "#/affiliate", dedupeKey: `affiliate-settlement:${s.id}`,
      title: "Affiliate fees paid", body: `Your affiliate fees of ₦${(Number(s.amount_kobo) / 100).toLocaleString("en-NG")} have been paid to your bank account.`,
      ha: { title: "An biya kuɗin wakili", body: `An biya kuɗin wakilcinka na ₦${(Number(s.amount_kobo) / 100).toLocaleString("en-NG")} zuwa asusun bankinka.` } });
    return { status: "PAID", paymentRef };
  });
}
