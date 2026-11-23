import { createHash } from "node:crypto";
import { audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { one, withTx } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";

/** Turns a rule written in the database into a readable 409. */
function dbRule(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "23000") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  if (e.code === "23514") throw badRequest("INVALID_REQUEST", "Some details are missing or not valid. Please check and try again.");
  throw err;
}

// --- Pop-up announcements ---------------------------------------------------------------------

export interface NewFlash {
  titleEn: string; bodyEn: string; titleHa?: string; bodyHa?: string;
  link?: string; startsAt: string; endsAt: string;
}

/**
 * Writes an announcement for the player app. It shows nothing until a
 * Compliance officer who did not write it approves it: anything players are
 * told about prizes, odds or deadlines must be accurate.
 */
export async function createFlash(ctx: Ctx, admin: Admin, f: NewFlash): Promise<{ id: string }> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE");
  if (new Date(f.endsAt).getTime() <= Date.now()) throw badRequest("INVALID_DATE", "The end time must be in the future.");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO flash_messages (title_en, body_en, title_ha, body_ha, link, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [f.titleEn.trim(), f.bodyEn.trim(), f.titleHa?.trim() || null, f.bodyHa?.trim() || null, f.link || null, f.startsAt, f.endsAt, admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "flash.created", "flash", r.rows[0]!.id, { titleEn: f.titleEn, startsAt: f.startsAt, endsAt: f.endsAt });
    return { id: r.rows[0]!.id };
  });
}

/** Compliance approves or rejects; the writer cannot decide their own. */
export async function decideFlash(ctx: Ctx, admin: Admin, id: string, approve: boolean): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE");
  return withTx(ctx.pool, async (db) => {
    const f = await one<{ status: string; created_by: string }>(db, "SELECT status, created_by FROM flash_messages WHERE id = $1 FOR UPDATE", [id]);
    if (!f) throw notFound("Announcement not found.");
    if (f.created_by === admin.id) throw forbidden("SAME_PERSON", "You wrote this announcement, so someone else in Compliance must check it.");
    if (f.status !== "PENDING") throw conflict("ALREADY_DECIDED", "This announcement has already been decided.");
    const status = approve ? "APPROVED" : "REJECTED";
    await db.query("UPDATE flash_messages SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [id, status, admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), approve ? "flash.approved" : "flash.rejected", "flash", id);
    return { status };
  });
}

/** Takes an announcement down at once. */
export async function withdrawFlash(ctx: Ctx, admin: Admin, id: string): Promise<{ status: string }> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query("UPDATE flash_messages SET status = 'WITHDRAWN' WHERE id = $1 AND status IN ('PENDING','APPROVED')", [id]).catch(dbRule);
    if (!r.rowCount) throw conflict("NOT_LIVE", "This announcement is not pending or live.");
    await audit(db, adminActor(admin), "flash.withdrawn", "flash", id);
    return { status: "WITHDRAWN" };
  });
}

export async function listFlash(ctx: Ctx, admin: Admin): Promise<unknown[]> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE", "AUDITOR");
  return (await ctx.pool.query(
    `SELECT f.*, c.full_name AS created_by_name, d.full_name AS decided_by_name,
            (f.status = 'APPROVED' AND now() BETWEEN f.starts_at AND f.ends_at) AS live
     FROM flash_messages f JOIN admin_users c ON c.id = f.created_by LEFT JOIN admin_users d ON d.id = f.decided_by
     ORDER BY f.created_at DESC LIMIT 100`)).rows;
}

/** What the player app shows now. */
export async function liveFlash(ctx: Ctx): Promise<unknown[]> {
  return (await ctx.pool.query(
    `SELECT id, title_en, body_en, title_ha, body_ha, link, ends_at FROM flash_messages
     WHERE status = 'APPROVED' AND now() BETWEEN starts_at AND ends_at ORDER BY starts_at DESC LIMIT 5`)).rows;
}

// --- Prize pictures ------------------------------------------------------------------------------

const MAX_IMAGE = 1024 * 1024;
const SIGNATURES: [string, (b: Buffer) => boolean][] = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

/**
 * Adds or replaces a prize's picture, until sales open (the database refuses
 * it after that). Only PNG, JPEG and WebP, recognised by their contents rather
 * than by what the uploader claims, and at most 1 MB. SVG is not accepted: it
 * can carry script.
 */
export async function setPrizeImage(ctx: Ctx, admin: Admin, tierId: string, input: { dataBase64: string }): Promise<{ sha256: string; contentType: string }> {
  requireRole(admin, "CYCLE_MANAGER");
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE) throw badRequest("INVALID_IMAGE", "The picture must be at most 1 MB.");
  const type = SIGNATURES.find(([, ok]) => ok(bytes))?.[0];
  if (!type) throw badRequest("INVALID_IMAGE", "Use a PNG, JPEG or WebP picture.");
  const sha = createHash("sha256").update(bytes).digest();
  return withTx(ctx.pool, async (db) => {
    if (!(await one(db, "SELECT 1 FROM prize_tiers WHERE id = $1", [tierId]))) throw notFound("Prize not found.");
    await db.query(
      `INSERT INTO prize_images (prize_tier_id, content_type, bytes, sha256, uploaded_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (prize_tier_id) DO UPDATE SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
         uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
      [tierId, type, bytes, sha, admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "prize.image_set", "prize_tier", tierId, { sha256: sha.toString("hex"), bytes: bytes.length, contentType: type });
    return { sha256: sha.toString("hex"), contentType: type };
  });
}

export async function prizeImage(ctx: Ctx, tierId: string): Promise<{ bytes: Buffer; contentType: string; etag: string }> {
  const r = await one<{ bytes: Buffer; content_type: string; sha256: Buffer }>(ctx.pool,
    "SELECT bytes, content_type, sha256 FROM prize_images WHERE prize_tier_id = $1", [tierId]);
  if (!r) throw notFound("Not found.");
  return { bytes: r.bytes, contentType: r.content_type, etag: `"${r.sha256.toString("hex")}"` };
}

// --- Live activity on the home screen ---------------------------------------------------------------

/**
 * Real activity only, for the home screen: cards sold in the last hour and the
 * latest instant wins (amount and time — never who won).
 */
const activityCache = new Map<string, { at: number; value: unknown }>();
export async function cycleActivity(ctx: Ctx, cycleId: string): Promise<unknown> {
  const hit = activityCache.get(cycleId);
  if (hit && Date.now() - hit.at < 10_000) return hit.value; // the home screen is busy during a rush
  const value = await readActivity(ctx, cycleId);
  if (activityCache.size > 50) activityCache.clear();
  activityCache.set(cycleId, { at: Date.now(), value });
  return value;
}

async function readActivity(ctx: Ctx, cycleId: string): Promise<unknown> {
  const sold = await one<{ n: number }>(ctx.pool,
    "SELECT coalesce(sum(quantity), 0)::int AS n FROM orders WHERE cycle_id = $1 AND status = 'FULFILLED' AND updated_at > now() - interval '1 hour'", [cycleId]);
  const wins = await ctx.pool.query(
    `SELECT substring(revealed_outcome FROM 6)::bigint AS cash_kobo, revealed_at AS at FROM tickets
     WHERE cycle_id = $1 AND status = 'REVEALED' AND revealed_outcome LIKE 'CASH:%' AND revealed_at > now() - interval '1 day'
     ORDER BY revealed_at DESC LIMIT 10`, [cycleId]);
  return { soldLastHour: sold!.n, recentWins: wins.rows.map((w) => ({ cashKobo: Number(w.cash_kobo), at: w.at })) };
}
