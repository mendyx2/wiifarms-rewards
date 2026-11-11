import type { Db } from "./db.ts";

export interface Actor {
  type: "PLAYER" | "ADMIN" | "SYSTEM";
  id?: string | undefined;
  ip?: string | undefined;
}
export const SYSTEM: Actor = { type: "SYSTEM" };

/** Writes one tamper-evident audit record. Always call inside the same transaction as the action it describes. */
export async function audit(db: Db, actor: Actor, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    // seq and the two hashes are placeholders: the database trigger assigns the real values.
    `INSERT INTO audit_log (seq, actor_type, actor_id, action, entity_type, entity_id, details, ip, prev_hash, row_hash)
     VALUES (0, $1, $2, $3, $4, $5, $6, $7, '\\x00', '\\x00')`,
    [actor.type, actor.id ?? null, action, entityType, entityId, JSON.stringify(details), actor.ip ?? null],
  );
}
