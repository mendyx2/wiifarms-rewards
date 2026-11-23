import { audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { lockKey, one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { normalisePhone, onExclusionRegister } from "./identity.ts";
import { naira, notify } from "./notify.ts";
import { winningsBalance } from "./wallet.ts";

/**
 * Next-of-kin claims.
 *
 * If a winner has died or cannot be reached, the next of kin they recorded may
 * receive the prizes still waiting to be claimed and any winnings not yet
 * withdrawn. Never automatically:
 *
 * - The claimant must have their own verified account, and their phone number
 *   and verified name must match the next of kin the winner recorded. (A winner
 *   cannot change that record while a prize claim is open.)
 * - Compliance opens a case with the reason and the supporting documents, and
 *   the winner is told at once, by text and in the app.
 * - Nothing can be decided for 7 days. If the winner signs in during that time
 *   the case cannot be approved: they are evidently reachable.
 * - A different person (Compliance or Finance) decides. On approval, in one
 *   transaction, the waiting prizes and the winnings move to the claimant, who
 *   gets at least 30 days to complete the claim.
 * - While a case is open, the winner's prizes do not lapse (enforced by the database).
 */

export const WAITING_DAYS = 7;
const CLAIMANT_DAYS = 30;

const sameName = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean).sort().join(" ");
  return norm(a) === norm(b);
};

async function playerByPhone(db: Db | Ctx["pool"], phoneInput: string) {
  const p = await one<{ id: string; full_name: string | null; kyc_tier: number; status: string; identity_hash: Buffer | null; phone_e164: string }>(
    db, "SELECT id, full_name, kyc_tier, status, identity_hash, phone_e164 FROM users WHERE phone_e164 = $1", [normalisePhone(phoneInput)]);
  if (!p) throw notFound("No player account has that phone number.");
  return p;
}

async function openClaims(db: Db | Ctx["pool"], winnerId: string) {
  return (await db.query<{ id: string; title: string; cycle: string; expires_at: Date; kind: string }>(
    `SELECT pc.id, pt.title, c.name AS cycle, pc.expires_at, pt.kind FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id JOIN cycles c ON c.id = pt.cycle_id
     WHERE pc.user_id = $1 AND pc.status = 'ENTITLED' ORDER BY pc.created_at`, [winnerId])).rows;
}

/** What Compliance sees before opening a case: the winner's waiting prizes, winnings and recorded next of kin. */
export async function lookupWinner(ctx: Ctx, admin: Admin, phone: string): Promise<unknown> {
  requireRole(admin, "COMPLIANCE", "FINANCE", "SUPPORT", "AUDITOR");
  const w = await playerByPhone(ctx.pool, phone);
  const db = await ctx.pool.connect();
  try {
    const nok = await one<{ full_name: string; relationship: string; phone_e164: string }>(db, "SELECT full_name, relationship, phone_e164 FROM next_of_kin WHERE user_id = $1", [w.id]);
    return {
      winner: { id: w.id, name: w.full_name, phone: "…" + w.phone_e164.slice(-4), status: w.status },
      nextOfKin: nok ? { name: nok.full_name, relationship: nok.relationship, phone: "…" + nok.phone_e164.slice(-4) } : null,
      waitingPrizes: await openClaims(db, w.id),
      winningsKobo: Math.max(0, await winningsBalance(db, w.id)),
    };
  } finally {
    db.release();
  }
}

export async function openCase(ctx: Ctx, admin: Admin, input: { winnerPhone: string; claimantPhone: string; reason: "DECEASED" | "UNREACHABLE"; documents: string[]; note: string }): Promise<{ id: string; decideFrom: string }> {
  requireRole(admin, "COMPLIANCE");
  const documents = input.documents.map((d) => d.trim()).filter(Boolean);
  if (!documents.length) throw badRequest("DOCUMENTS_REQUIRED", input.reason === "DECEASED" ? "Attach the death certificate reference and the claimant's identity documents." : "Attach the record of attempts to reach the winner and the claimant's identity documents.");
  if (!input.note.trim()) throw badRequest("NOTE_REQUIRED", "Describe the case.");
  return withTx(ctx.pool, async (db) => {
    const winner = await playerByPhone(db, input.winnerPhone);
    await lockKey(db, `player:${winner.id}`);
    const claimant = await playerByPhone(db, input.claimantPhone);
    const nok = await one<{ full_name: string; phone_e164: string }>(db, "SELECT full_name, phone_e164 FROM next_of_kin WHERE user_id = $1", [winner.id]);
    if (!nok) throw conflict("NO_NEXT_OF_KIN", "This winner never recorded a next of kin, so no one can claim on their behalf through this process.");
    if (claimant.phone_e164 !== nok.phone_e164) throw conflict("NOT_NEXT_OF_KIN", "The claimant's phone number is not the one the winner recorded for their next of kin.");
    if (claimant.kyc_tier < 1 || !claimant.full_name) throw conflict("CLAIMANT_NOT_VERIFIED", "The claimant must first verify their own identity in the app.");
    if (!sameName(claimant.full_name, nok.full_name)) throw conflict("NAME_MISMATCH", "The claimant's verified name does not match the next of kin the winner recorded.");
    if (await onExclusionRegister(db, claimant)) throw conflict("NOT_ELIGIBLE", "The claimant is on the exclusion register and cannot receive prizes.");
    const prizes = await openClaims(db, winner.id);
    if (!prizes.length && (await winningsBalance(db, winner.id)) <= 0) throw conflict("NOTHING_TO_CLAIM", "This winner has no prizes waiting and no winnings to pass on.");
    const r = await db.query<{ id: string; opened_at: Date }>(
      `INSERT INTO next_of_kin_cases (winner_user_id, claimant_user_id, reason, documents, note, opened_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, opened_at`,
      [winner.id, claimant.id, input.reason, documents, input.note.trim(), admin.id])
      .catch((e: { code?: string }) => { if (e.code === "23505") throw conflict("CASE_ALREADY_OPEN", "A next-of-kin case for this winner is already open."); throw e; });
    const id = r.rows[0]!.id;
    // Tell the winner straight away: if they are alive and reachable, this is their chance to say so.
    await notify(db, { userId: winner.id, kind: "NOK_CASE_OPENED", urgent: true, link: "#/wallet", dedupeKey: `nok:${id}:opened`,
      title: "Someone has asked to claim your prizes",
      body: `Your next of kin has asked to claim your waiting prizes because we could not reach you. If you did not expect this, sign in or contact support within ${WAITING_DAYS} days and nothing will be passed on.`,
      sms: `Your next of kin has asked to claim your waiting prizes. If you did not expect this, sign in to the app or contact support within ${WAITING_DAYS} days.`,
      ha: { title: "Wani ya nemi karɓar kyaututtukanka",
        body: `Magajinka ya nemi karɓar kyaututtukanka da ke jira saboda ba mu iya samun ka ba. Idan ba ka yi tsammanin haka ba, shiga manhajar ko ka tuntuɓi masu taimako cikin kwana ${WAITING_DAYS} kuma ba za a miƙa komai ba.`,
        sms: `Magajinka ya nemi karɓar kyaututtukanka da ke jira. Idan ba ka yi tsammanin haka ba, shiga manhajar ko ka tuntuɓi masu taimako cikin kwana ${WAITING_DAYS}.` } });
    await audit(db, adminActor(admin), "nok.case_opened", "user", winner.id, { caseId: id, reason: input.reason, documents, claimant: claimant.id });
    return { id, decideFrom: new Date(r.rows[0]!.opened_at.getTime() + WAITING_DAYS * 864e5).toISOString() };
  });
}

export async function decideCase(ctx: Ctx, admin: Admin, caseId: string, approve: boolean, reason?: string): Promise<{ status: string; transferred?: unknown }> {
  requireRole(admin, "COMPLIANCE", "FINANCE");
  return withTx(ctx.pool, async (db) => {
    const c = await one<{ id: string; winner_user_id: string; claimant_user_id: string; reason: string; opened_by: string; opened_at: Date; status: string }>(
      db, "SELECT * FROM next_of_kin_cases WHERE id = $1 FOR UPDATE", [caseId]);
    if (!c) throw notFound("Case not found.");
    if (c.status !== "OPEN") throw conflict("ALREADY_DECIDED", "This case has already been decided.");
    if (c.opened_by === admin.id) throw forbidden("SAME_PERSON", "You opened this case, so someone else must decide it.");
    await lockKey(db, `player:${c.winner_user_id}`);
    if (!approve) {
      if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Give the reason for rejecting the case.");
      await db.query("UPDATE next_of_kin_cases SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1", [c.id, admin.id, reason.trim()]);
      await audit(db, adminActor(admin), "nok.case_rejected", "user", c.winner_user_id, { caseId: c.id, reason });
      return { status: "REJECTED" };
    }
    const readyAt = c.opened_at.getTime() + WAITING_DAYS * 864e5;
    if (Date.now() < readyAt) throw conflict("WAITING_PERIOD", `The winner has until ${new Date(readyAt).toISOString().slice(0, 10)} to respond before this case can be approved.`);
    const signedIn = await one(db, "SELECT 1 FROM sessions WHERE user_id = $1 AND created_at > $2", [c.winner_user_id, c.opened_at]);
    if (signedIn) throw conflict("WINNER_ACTIVE", "The winner has signed in since this case was opened, so they can be reached. Contact them, and reject this case.");
    const claimant = await one<{ status: string; kyc_tier: number; identity_hash: Buffer | null; phone_e164: string }>(db, "SELECT status, kyc_tier, identity_hash, phone_e164 FROM users WHERE id = $1", [c.claimant_user_id]);
    if (!claimant || claimant.status !== "ACTIVE" || claimant.kyc_tier < 1) throw conflict("CLAIMANT_NOT_VERIFIED", "The claimant's account is no longer active and verified.");
    if (await onExclusionRegister(db, claimant)) throw conflict("NOT_ELIGIBLE", "The claimant is on the exclusion register and cannot receive prizes.");

    // Move the waiting prizes, giving the claimant at least 30 days to complete each claim.
    const moved = await db.query<{ id: string }>(
      `UPDATE prize_claims SET user_id = $2, claimed_by_next_of_kin = true, expires_at = greatest(expires_at, now() + make_interval(days => $3))
       WHERE user_id = $1 AND status = 'ENTITLED' RETURNING id`, [c.winner_user_id, c.claimant_user_id, CLAIMANT_DAYS]);
    // Move any winnings not yet withdrawn.
    const balance = await winningsBalance(db, c.winner_user_id);
    if (balance > 0) {
      await post(db, { kind: "ADJUSTMENT", reference: `nok:${c.id}:winnings`, memo: "Winnings passed to next of kin",
        debit: accounts.playerWinnings(c.winner_user_id), credit: accounts.playerWinnings(c.claimant_user_id), amountKobo: balance });
    }
    const transferred = { prizeClaims: moved.rows.map((r) => r.id), winningsKobo: Math.max(0, balance) };
    await db.query("UPDATE next_of_kin_cases SET status = 'APPROVED', decided_by = $2, decided_at = now(), transferred = $3 WHERE id = $1", [c.id, admin.id, JSON.stringify(transferred)]);
    if (c.reason === "DECEASED") {
      // The account of someone who has died is closed to sign-in, so it cannot be misused.
      await db.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [c.winner_user_id]);
      await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [c.winner_user_id]);
    }
    const whatHa = [moved.rows.length ? `kyauta ${moved.rows.length}` : "", balance > 0 ? `${naira(balance)} na kuɗin nasara` : ""].filter(Boolean).join(" da ");
    const what = [moved.rows.length ? `${moved.rows.length} prize${moved.rows.length === 1 ? "" : "s"}` : "", balance > 0 ? `${naira(balance)} in winnings` : ""].filter(Boolean).join(" and ");
    await notify(db, { userId: c.claimant_user_id, kind: "NOK_APPROVED", urgent: true, link: "#/wallet", dedupeKey: `nok:${c.id}:approved`,
      title: "Prizes passed to you as next of kin",
      body: `Your claim as next of kin was approved: ${what} ${moved.rows.length + (balance > 0 ? 1 : 0) === 1 ? "is" : "are"} now in your account. Complete each prize claim within ${CLAIMANT_DAYS} days.`,
      sms: `Your claim as next of kin was approved: ${what} now in your account. Complete each prize claim in the app within ${CLAIMANT_DAYS} days.`,
      ha: { title: "An ba ka kyaututtuka a matsayin magaji",
        body: `An amince da buƙatarka a matsayin magaji: ${whatHa} yanzu suna cikin asusunka. Ka kammala karɓar kowace kyauta cikin kwana ${CLAIMANT_DAYS}.`,
        sms: `An amince da buƙatarka a matsayin magaji: ${whatHa} yanzu suna cikin asusunka. Ka kammala karɓar kowace kyauta a manhajar cikin kwana ${CLAIMANT_DAYS}.` } });
    await audit(db, adminActor(admin), "nok.case_approved", "user", c.winner_user_id, { caseId: c.id, ...transferred });
    return { status: "APPROVED", transferred };
  });
}

export async function listCases(ctx: Ctx, admin: Admin): Promise<unknown[]> {
  requireRole(admin, "COMPLIANCE", "FINANCE", "AUDITOR");
  return (await ctx.pool.query(
    `SELECT c.id, c.reason, c.documents, c.note, c.status, c.opened_at, c.opened_by, ob.full_name AS opened_by_name, c.decided_at, db.full_name AS decided_by_name,
            c.decision_reason, c.transferred, w.full_name AS winner_name, '…' || right(w.phone_e164, 4) AS winner_phone,
            cl.full_name AS claimant_name, '…' || right(cl.phone_e164, 4) AS claimant_phone,
            c.opened_at + make_interval(days => $1) AS decide_from,
            EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = c.winner_user_id AND s.created_at > c.opened_at) AS winner_signed_in_since
     FROM next_of_kin_cases c JOIN users w ON w.id = c.winner_user_id JOIN users cl ON cl.id = c.claimant_user_id
     JOIN admin_users ob ON ob.id = c.opened_by LEFT JOIN admin_users db ON db.id = c.decided_by
     ORDER BY (c.status = 'OPEN') DESC, c.opened_at DESC LIMIT 100`, [WAITING_DAYS])).rows;
}
