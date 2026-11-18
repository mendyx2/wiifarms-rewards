// Independent checks that run in the player's own browser, using only the
// browser's built-in cryptography. They repeat the published rules of
// packages/game-core so a result can be checked without trusting our servers.
// test/verify.test.ts proves this file and game-core always agree.

const VERSION = "wiifarm-rewards/v1";
const te = new TextEncoder();

export const fromHex = (hex) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Each field is prefixed with its length (4 bytes, big-endian) so field boundaries cannot be shifted. */
function encodeFields(fields) {
  const chunks = [];
  for (const f of fields) {
    const bytes = typeof f === "string" ? te.encode(f) : f;
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length);
    chunks.push(len, bytes);
  }
  return concat(...chunks);
}

const sha256 = async (...parts) => new Uint8Array(await crypto.subtle.digest("SHA-256", concat(...parts)));

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// --- Scratch cards ------------------------------------------------------------

export const ticketLeafHash = (t) =>
  sha256(Uint8Array.of(0), encodeFields([VERSION, "ticket", t.cycleId, t.serial, t.outcome, t.salt]));

/**
 * True if this card, with this outcome, was part of the fingerprint published
 * before sales opened. `proof` is what the reveal returned; `publishedRootHex`
 * must come from the public cycle page, not from the reveal itself.
 */
export async function verifyTicket(proof, publishedRootHex) {
  let acc = await ticketLeafHash({ cycleId: proof.cycleId, serial: proof.serial, outcome: proof.outcome, salt: fromHex(proof.salt) });
  for (const step of proof.steps) {
    const sibling = fromHex(step.hash);
    acc = step.side === "left" ? await sha256(Uint8Array.of(1), sibling, acc) : await sha256(Uint8Array.of(1), acc, sibling);
  }
  return equal(acc, fromHex(publishedRootHex));
}

/**
 * Checks a whole archived cycle from its published card list: rebuilds the
 * fingerprint from every card and compares it with the one published before
 * sales opened, and counts every instant prize against the published prize
 * table. `cycle` is GET /v1/cycles/:id; `cards` is every card from
 * GET /v1/cycles/:id/tickets, in order.
 */
export async function verifyCycle(cycle, cards) {
  let level = [];
  for (const c of cards) level.push(await ticketLeafHash({ cycleId: cycle.id, serial: c.serial, outcome: c.outcome, salt: fromHex(c.salt) }));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? await sha256(Uint8Array.of(1), level[i], level[i + 1]) : level[i]);
    level = next;
  }
  const rootOk = level.length === 1 && toHex(level[0]) === cycle.commitment.ticket_merkle_root;
  const inOrder = cards.every((c, i) => c.leaf_index === i);
  const counted = new Map();
  for (const c of cards) counted.set(c.outcome, (counted.get(c.outcome) ?? 0) + 1);
  const instant = cycle.prizes.filter((p) => p.stage === "INSTANT");
  const prizesOk = instant.every((p) => counted.get("CASH:" + p.cash_kobo) === p.quantity)
    && [...counted.keys()].every((o) => o === "NONE" || instant.some((p) => "CASH:" + p.cash_kobo === o));
  const unsoldWins = cards.filter((c) => c.sale_status === "UNSOLD" && c.outcome !== "NONE").length;
  const checks = [
    { label: `All ${cards.length.toLocaleString("en-NG")} cards published, in order`, ok: cards.length === cycle.total_tickets && inOrder },
    { label: "They rebuild exactly the fingerprint published before sales opened", ok: rootOk },
    { label: `Every advertised instant prize was on a card (${instant.reduce((n, p) => n + p.quantity, 0)} prizes)`, ok: prizesOk },
  ];
  return { ok: checks.every((c) => c.ok), checks, unsoldWins };
}

// --- Final draw ------------------------------------------------------------------

const sorted = (serials) => [...serials].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export const commitSecret = (secret) => sha256(encodeFields([VERSION, "draw-secret", secret]));
export const entriesHash = (cycleId, serials) => sha256(encodeFields([VERSION, "draw-entries", cycleId, ...sorted(serials)]));
export const deriveDrawSeed = (secret, beaconValue, cycleId, entriesHashBytes) =>
  hmac(secret, encodeFields([VERSION, "draw-seed", cycleId, entriesHashBytes, beaconValue]));

/** Same random stream as game-core: block i = HMAC(seed, i), four 64-bit values per block. */
function stream(seed) {
  let counter = 0n, block = new Uint8Array(0), offset = 0;
  const next64 = async () => {
    if (offset + 8 > block.length) {
      const c = new Uint8Array(8);
      new DataView(c.buffer).setBigUint64(0, counter++);
      block = await hmac(seed, c);
      offset = 0;
    }
    const v = new DataView(block.buffer, block.byteOffset + offset, 8).getBigUint64(0);
    offset += 8;
    return v;
  };
  return async (n) => {
    const range = BigInt(n), limit = (1n << 64n) - ((1n << 64n) % range);
    for (;;) {
      const v = await next64();
      if (v < limit) return Number(v % range); // rejection sampling: no bias
    }
  };
}

export async function runDraw(serials, prizes, seed) {
  const pool = sorted(serials), nextInt = stream(seed), winners = [];
  let remaining = pool.length;
  for (const prize of prizes) {
    for (let position = 1; position <= prize.quantity; position++) {
      if (remaining === 0) return winners;
      const pick = await nextInt(remaining);
      winners.push({ prizeId: prize.prizeId, position, serial: pool[pick] });
      pool[pick] = pool[remaining - 1];
      remaining--;
    }
  }
  return winners;
}

/**
 * Re-runs a whole draw from the published data and reports each check.
 * `draw` is GET /v1/cycles/:id/draw; `commitmentHex` is the secret commitment
 * shown on the cycle page since before sales opened.
 */
export async function verifyDraw(draw, commitmentHex) {
  const secret = fromHex(draw.secret);
  const eh = await entriesHash(draw.cycle_id, draw.entries);
  const seed = await deriveDrawSeed(secret, fromHex(draw.beacon_value), draw.cycle_id, eh);
  const rerun = await runDraw(draw.entries, draw.prizes.map((p) => ({ prizeId: p.prize_id, quantity: p.quantity })), seed);
  const same = rerun.length === draw.winners.length &&
    rerun.every((w, i) => w.prizeId === draw.winners[i].prize_id && w.position === draw.winners[i].position && w.serial === draw.winners[i].serial);
  const checks = [
    { label: "The secret is the one committed before sales opened", ok: equal(await commitSecret(secret), fromHex(commitmentHex)) },
    { label: `The list of ${draw.entries.length} entries matches its published fingerprint`, ok: toHex(eh) === draw.entries_sha256 },
    { label: "The draw seed comes from that secret and the public randomness", ok: toHex(seed) === draw.seed },
    { label: "Re-running the draw gives the same winners", ok: same },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
