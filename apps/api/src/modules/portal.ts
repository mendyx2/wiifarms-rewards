import { createHash } from "node:crypto";
import { audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { decideAffiliateInTx } from "./affiliates.ts";
import type { User } from "./identity.ts";
import { notify } from "./notify.ts";
import { MAX_IMAGE, SIGNATURES } from "./promo.ts";
import { normaliseCode } from "./referrals.ts";

/**
 * The affiliate portal (SRS section 13): the approved content library with
 * version control (AFF-005, AFF-011), and complaints and investigations
 * (AFF-009).
 *
 * Affiliates may only use approved materials. Each text is written by staff,
 * approved by someone else in Compliance, and never edited afterwards: a
 * correction is a new version, and approving it retires the old one. Texts may
 * contain {link}, which becomes the affiliate's own attribution link; every
 * text must say "18+".
 */

export const CHANNELS = ["WHATSAPP", "SMS", "SOCIAL", "PRINT", "RADIO"] as const;
export type Channel = typeof CHANNELS[number];
export interface MaterialText { bodyEn: string; bodyHa?: string; imageBase64?: string }

function checkText(t: MaterialText): { image: Buffer | null; type: string | null; sha: Buffer } {
  if (!/18\+/.test(t.bodyEn)) throw badRequest("RESPONSIBLE_PLAY_LINE", 'Every marketing text must say "18+" (for example "18+ only. Play responsibly.").');
  if (t.bodyHa && !/18\+/.test(t.bodyHa)) throw badRequest("RESPONSIBLE_PLAY_LINE", 'The Hausa text must also say "18+".');
  let image: Buffer | null = null, type: string | null = null;
  if (t.imageBase64) {
    image = Buffer.from(t.imageBase64, "base64");
    if (!image.length || image.length > MAX_IMAGE) throw badRequest("INVALID_IMAGE", "The picture must be at most 1 MB.");
    type = SIGNATURES.find(([, ok]) => ok(image!))?.[0] ?? null;
    if (!type) throw badRequest("INVALID_IMAGE", "Use a PNG, JPEG or WebP picture.");
  }
  const sha = createHash("sha256").update(t.bodyEn).update("\0").update(t.bodyHa ?? "").update("\0").update(image ?? Buffer.alloc(0)).digest();
  return { image, type, sha };
}

function dbRule(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "marketing_material_one_pending") throw conflict("VERSION_PENDING", "A new version of this text is already waiting for approval.");
  if (e.code === "23000") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  if (e.code === "23514") throw conflict("RULE_VIOLATION", "That is not allowed (for example, approving your own text).");
  throw err;
}

// --- Materials ------------------------------------------------------------------------------

export async function createMaterial(ctx: Ctx, admin: Admin, input: { name: string; channel: Channel } & MaterialText): Promise<{ id: string; versionId: string }> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE");
  const c = checkText(input);
  return withTx(ctx.pool, async (db) => {
    const m = await db.query<{ id: string }>("INSERT INTO marketing_materials (name, channel, created_by) VALUES ($1, $2, $3) RETURNING id", [input.name.trim(), input.channel, admin.id]);
    const id = m.rows[0]!.id;
    const v = await insertVersion(db, admin, id, 1, input, c);
    await audit(db, adminActor(admin), "material.created", "marketing_material", id, { name: input.name, channel: input.channel, sha256: c.sha.toString("hex") });
    return { id, versionId: v };
  });
}

async function insertVersion(db: Db, admin: Admin, materialId: string, version: number, t: MaterialText, c: ReturnType<typeof checkText>): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO marketing_material_versions (material_id, version, body_en, body_ha, image, content_type, sha256, written_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [materialId, version, t.bodyEn.trim(), t.bodyHa?.trim() || null, c.image, c.type, c.sha, admin.id]).catch(dbRule);
  return r.rows[0]!.id;
}

/** A correction or update: a new version, approved like the first. The current version stays in use until then. */
export async function newMaterialVersion(ctx: Ctx, admin: Admin, materialId: string, input: MaterialText): Promise<{ versionId: string; version: number }> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE");
  const c = checkText(input);
  return withTx(ctx.pool, async (db) => {
    if (!(await one(db, "SELECT 1 FROM marketing_materials WHERE id = $1 FOR UPDATE", [materialId]))) throw notFound("Marketing text not found.");
    const m = (await one<{ n: number }>(db, "SELECT coalesce(max(version), 0)::int AS n FROM marketing_material_versions WHERE material_id = $1", [materialId]))!;
    const versionId = await insertVersion(db, admin, materialId, m.n + 1, input, c);
    await audit(db, adminActor(admin), "material.version_written", "marketing_material", materialId, { version: m.n + 1, sha256: c.sha.toString("hex") });
    return { versionId, version: m.n + 1 };
  });
}

export async function decideMaterialVersion(ctx: Ctx, admin: Admin, versionId: string, approve: boolean): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE");
  return withTx(ctx.pool, async (db) => {
    const v = await one<{ id: string; material_id: string; version: number; status: string; written_by: string }>(db,
      "SELECT id, material_id, version, status, written_by FROM marketing_material_versions WHERE id = $1 FOR UPDATE", [versionId]);
    if (!v) throw notFound("Version not found.");
    if (v.status !== "PENDING") throw conflict("ALREADY_DECIDED", "This version has already been decided.");
    if (v.written_by === admin.id) throw forbidden("SAME_PERSON", "You wrote this text, so another Compliance officer must approve it.");
    if (approve) {
      await db.query("UPDATE marketing_material_versions SET status = 'RETIRED', retired_at = now() WHERE material_id = $1 AND status = 'APPROVED'", [v.material_id]);
    }
    await db.query("UPDATE marketing_material_versions SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [v.id, approve ? "APPROVED" : "REJECTED", admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), approve ? "material.approved" : "material.rejected", "marketing_material", v.material_id, { version: v.version });
    return { status: approve ? "APPROVED" : "REJECTED" };
  });
}

/** Withdraws a text from use at once (one person is enough to stop something). */
export async function retireMaterial(ctx: Ctx, admin: Admin, materialId: string): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query("UPDATE marketing_material_versions SET status = 'RETIRED', retired_at = now() WHERE material_id = $1 AND status = 'APPROVED'", [materialId]);
    if (!r.rowCount) throw conflict("NOT_IN_USE", "This text is not in use.");
    await audit(db, adminActor(admin), "material.retired", "marketing_material", materialId);
    return { status: "RETIRED" };
  });
}

export async function listMaterials(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE", "AUDITOR");
  const rows = (await ctx.pool.query(
    `SELECT m.id, m.name, m.channel, v.id AS version_id, v.version, v.body_en, v.body_ha, v.image IS NOT NULL AS has_image, encode(v.sha256, 'hex') AS sha256,
            v.status, v.written_by, w.full_name AS written_by_name, d.full_name AS decided_by_name, v.created_at, v.decided_at
     FROM marketing_materials m JOIN marketing_material_versions v ON v.material_id = m.id
     JOIN admin_users w ON w.id = v.written_by LEFT JOIN admin_users d ON d.id = v.decided_by
     ORDER BY m.created_at DESC, v.version DESC`)).rows;
  const byId = new Map<string, { id: string; name: string; channel: string; versions: unknown[] }>();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, { id: r.id, name: r.name, channel: r.channel, versions: [] });
    const { id: _id, name: _n, channel: _c, ...v } = r;
    byId.get(r.id)!.versions.push(v);
  }
  return { materials: [...byId.values()] };
}

/** The picture of a version in use (or, for staff reviewing it, any version). */
export async function materialImage(ctx: Ctx, versionId: string, staff: boolean): Promise<{ bytes: Buffer; type: string; etag: string } | null> {
  const v = await one<{ image: Buffer | null; content_type: string | null; sha256: Buffer; status: string }>(ctx.pool,
    "SELECT image, content_type, sha256, status FROM marketing_material_versions WHERE id = $1", [versionId]);
  if (!v?.image || (!staff && v.status !== "APPROVED")) return null;
  return { bytes: v.image, type: v.content_type!, etag: `"${v.sha256.toString("hex").slice(0, 32)}"` };
}

/** What an approved affiliate may use, right now. */
export async function affiliateMaterials(ctx: Ctx, userId: string): Promise<unknown> {
  const a = await one<{ status: string; attribution_code: string | null }>(ctx.pool, "SELECT status, attribution_code FROM affiliates WHERE user_id = $1", [userId]);
  if (!a || a.status !== "APPROVED") throw forbidden("NOT_AN_AFFILIATE", "Approved materials are for approved affiliates.");
  const rows = (await ctx.pool.query(
    `SELECT m.name, m.channel, v.id AS version_id, v.version, v.body_en, v.body_ha, v.image IS NOT NULL AS has_image, v.decided_at AS approved_at
     FROM marketing_materials m JOIN marketing_material_versions v ON v.material_id = m.id AND v.status = 'APPROVED' ORDER BY m.channel, m.name`)).rows;
  return { link: `/r/${a.attribution_code}`, materials: rows };
}

// --- Complaints and investigations ------------------------------------------------------------

export const CATEGORIES = ["MISLEADING", "UNDERAGE", "PRESSURE", "UNAPPROVED_MATERIAL", "PAID_SIGNUPS", "IMPERSONATION", "OTHER"] as const;
export type Category = typeof CATEGORIES[number];

async function newReference(db: Db): Promise<string> {
  return `CMP-${(await one<{ n: string }>(db, "SELECT nextval('affiliate_complaint_seq')::text AS n"))!.n.padStart(6, "0")}`;
}

/** A player reports a promoter. The code is optional: people often do not know it. */
export async function reportAffiliate(ctx: Ctx, actor: Actor, user: User, input: { code?: string; category: Category; description: string }): Promise<{ reference: string }> {
  return withTx(ctx.pool, async (db) => {
    const recent = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM affiliate_complaints WHERE reporter_user_id = $1 AND created_at > now() - interval '24 hours'", [user.id]);
    if (recent!.n >= 5) throw conflict("TOO_MANY_REPORTS", "You have sent several reports today. We are looking into them; please contact support if it is urgent.");
    const code = input.code?.trim() ? normaliseCode(input.code) : null;
    const aff = code ? await one<{ id: string }>(db, "SELECT id FROM affiliates WHERE attribution_code = $1", [code]) : null;
    const reference = await newReference(db);
    const r = await db.query<{ id: string }>(
      `INSERT INTO affiliate_complaints (reference, affiliate_id, reported_code, source, reporter_user_id, category, description)
       VALUES ($1, $2, $3, 'PLAYER', $4, $5, $6) RETURNING id`, [reference, aff?.id ?? null, code, user.id, input.category, input.description.trim()]);
    await audit(db, actor, "affiliate_complaint.reported", "affiliate_complaint", r.rows[0]!.id, { reference, category: input.category });
    return { reference };
  });
}

export async function openComplaint(ctx: Ctx, admin: Admin, input: { affiliateId: string; category: Category; description: string }): Promise<{ id: string; reference: string }> {
  requireRole(admin, "COMPLIANCE", "SUPPORT");
  return withTx(ctx.pool, async (db) => {
    if (!(await one(db, "SELECT 1 FROM affiliates WHERE id = $1", [input.affiliateId]))) throw notFound("Affiliate not found.");
    const reference = await newReference(db);
    const r = await db.query<{ id: string }>(
      `INSERT INTO affiliate_complaints (reference, affiliate_id, source, reporter_admin_id, category, description)
       VALUES ($1, $2, 'STAFF', $3, $4, $5) RETURNING id`, [reference, input.affiliateId, admin.id, input.category, input.description.trim()]);
    await audit(db, adminActor(admin), "affiliate_complaint.opened", "affiliate_complaint", r.rows[0]!.id, { reference, category: input.category });
    return { id: r.rows[0]!.id, reference };
  });
}

export async function listComplaints(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, "COMPLIANCE", "AUDITOR");
  return { complaints: (await ctx.pool.query(
    `SELECT c.id, c.reference, c.affiliate_id, a.reference AS affiliate_reference, a.business_name, a.status AS affiliate_status, c.reported_code, c.source,
            c.category, c.description, c.status, c.findings, c.outcome, c.created_at, c.decided_at, c.reporter_admin_id,
            c.investigator_id, i.full_name AS investigator_name
     FROM affiliate_complaints c LEFT JOIN affiliates a ON a.id = c.affiliate_id LEFT JOIN admin_users i ON i.id = c.investigator_id
     ORDER BY (c.status IN ('OPEN','INVESTIGATING')) DESC, c.created_at DESC LIMIT 300`)).rows };
}

/** Compliance takes the case. A complaint can be linked to the affiliate here when the reporter did not know the code. */
export async function investigateComplaint(ctx: Ctx, admin: Admin, complaintId: string, affiliateId?: string): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE");
  return withTx(ctx.pool, async (db) => {
    const c = await one<{ status: string; affiliate_id: string | null; reporter_admin_id: string | null }>(db,
      "SELECT status, affiliate_id, reporter_admin_id FROM affiliate_complaints WHERE id = $1 FOR UPDATE", [complaintId]);
    if (!c) throw notFound("Complaint not found.");
    if (c.status !== "OPEN") throw conflict("ALREADY_TAKEN", "This complaint is already being investigated or has been concluded.");
    if (c.reporter_admin_id === admin.id) throw forbidden("SAME_PERSON", "You reported this, so someone else must investigate it.");
    await db.query("UPDATE affiliate_complaints SET status = 'INVESTIGATING', investigator_id = $2, affiliate_id = coalesce(affiliate_id, $3) WHERE id = $1",
      [complaintId, admin.id, affiliateId ?? null]).catch(dbRule);
    await audit(db, adminActor(admin), "affiliate_complaint.investigating", "affiliate_complaint", complaintId, { affiliateId: affiliateId ?? c.affiliate_id });
    return { status: "INVESTIGATING" };
  });
}

/**
 * Records the findings and outcome. Suspending or ending the affiliate happens
 * in the same transaction, so a recorded outcome always matches what was done.
 */
export async function concludeComplaint(ctx: Ctx, admin: Admin, complaintId: string,
  input: { upheld: boolean; findings: string; outcome: "NO_ACTION" | "WARNING" | "SUSPENDED" | "TERMINATED" }): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE");
  if (!input.findings.trim()) throw badRequest("FINDINGS_REQUIRED", "Record what the investigation found.");
  if (!input.upheld && input.outcome !== "NO_ACTION") throw badRequest("INVALID_OUTCOME", "A dismissed complaint leads to no action.");
  return withTx(ctx.pool, async (db) => {
    const c = await one<{ id: string; reference: string; status: string; investigator_id: string | null; affiliate_id: string | null; reporter_user_id: string | null }>(db,
      "SELECT id, reference, status, investigator_id, affiliate_id, reporter_user_id FROM affiliate_complaints WHERE id = $1 FOR UPDATE", [complaintId]);
    if (!c) throw notFound("Complaint not found.");
    if (c.status !== "INVESTIGATING") throw conflict("NOT_INVESTIGATING", "Start the investigation first.");
    if (c.investigator_id !== admin.id) throw forbidden("NOT_INVESTIGATOR", "Only the investigating officer can conclude this complaint.");
    if (input.outcome !== "NO_ACTION" && !c.affiliate_id) throw badRequest("AFFILIATE_UNKNOWN", "Link the complaint to an affiliate before taking action.");
    const reason = `Complaint ${c.reference}: ${input.findings.trim()}`;
    if (input.outcome === "SUSPENDED") await decideAffiliateInTx(db, admin, c.affiliate_id!, "SUSPEND", reason);
    if (input.outcome === "TERMINATED") await decideAffiliateInTx(db, admin, c.affiliate_id!, "TERMINATE", reason);
    if (input.outcome === "WARNING") {
      const a = (await one<{ user_id: string }>(db, "SELECT user_id FROM affiliates WHERE id = $1", [c.affiliate_id]))!;
      await notify(db, { userId: a.user_id, kind: "ACCOUNT", urgent: true, link: "#/affiliate", dedupeKey: `complaint-warning:${c.id}`,
        title: "Formal warning", body: `A complaint about your promotion was upheld (${c.reference}). Use only the approved materials and follow the training. Another upheld complaint may end your agreement.`,
        ha: { title: "Gargaɗi na hukuma", body: `An tabbatar da ƙorafi game da tallanka (${c.reference}). Ka yi amfani da kayan talla da aka amince da su kawai kuma ka bi horon. Wani ƙorafi da aka tabbatar zai iya kawo ƙarshen yarjejeniyarka.` } });
      await db.query("INSERT INTO affiliate_history (affiliate_id, status, by_admin, reason) VALUES ($1, 'WARNED', $2, $3)", [c.affiliate_id, admin.id, reason]);
    }
    await db.query("UPDATE affiliate_complaints SET status = $2, findings = $3, outcome = $4, decided_at = now() WHERE id = $1",
      [c.id, input.upheld ? "UPHELD" : "DISMISSED", input.findings.trim(), input.outcome]).catch(dbRule);
    await audit(db, adminActor(admin), "affiliate_complaint.concluded", "affiliate_complaint", c.id, { upheld: input.upheld, outcome: input.outcome });
    if (c.reporter_user_id) {
      await notify(db, { userId: c.reporter_user_id, kind: "SUPPORT", link: "#/support", dedupeKey: `complaint-done:${c.id}`,
        title: "Your report has been looked into", body: `Thank you for your report ${c.reference}. Compliance has investigated it${input.upheld ? " and taken action" : ""}.`,
        ha: { title: "An duba rahotonka", body: `Mun gode da rahotonka ${c.reference}. Sashen bin doka ya bincika shi${input.upheld ? " kuma ya ɗauki mataki" : ""}.` } });
    }
    return { status: input.upheld ? "UPHELD" : "DISMISSED" };
  });
}
