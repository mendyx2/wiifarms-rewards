// The browser verifier must agree exactly with game-core, or players would be
// checking against different rules from the ones the platform runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as core from "@wiifarm/game-core";
import * as web from "../public/js/verify.js";

const bytes = (label: string, n = 32) => createHash("sha512").update(label).digest().subarray(0, n);

test("card proofs: browser verifier accepts what game-core produces and rejects changes", async () => {
  for (const n of [1, 2, 5, 37]) {
    const outcomes = core.generateOutcomes(n, [{ outcome: "CASH:50000", count: Math.floor(n / 3) }], bytes("gen"));
    const tickets = outcomes.map((outcome, i) => ({ cycleId: "cycle-x", serial: `WR-${i}`, outcome, salt: bytes(`salt${i}`, 16) }));
    const tree = new core.MerkleTree(tickets.map(core.ticketLeafHash));
    const root = tree.root.toString("hex");
    for (const [i, t] of tickets.entries()) {
      assert.equal(web.toHex(await web.ticketLeafHash(t)), core.ticketLeafHash(t).toString("hex"));
      const proof = { cycleId: t.cycleId, serial: t.serial, outcome: t.outcome, salt: t.salt.toString("hex"), steps: tree.proof(i).map((s) => ({ hash: s.hash.toString("hex"), side: s.side })) };
      assert.equal(await web.verifyTicket(proof, root), true);
      assert.equal(await web.verifyTicket({ ...proof, outcome: t.outcome === "NONE" ? "CASH:50000" : "NONE" }, root), false);
      assert.equal(await web.verifyTicket(proof, bytes("other-root").toString("hex")), false);
    }
  }
});

test("draw: browser re-run matches game-core for many random draws", async () => {
  for (let round = 0; round < 25; round++) {
    const cycleId = `cycle-${round}`;
    const serials = Array.from({ length: 1 + ((round * 37) % 200) }, (_, i) => `WR-${randomBytes(4).toString("hex")}-${i}`);
    const prizes = [{ prizeId: "a", quantity: 1 }, { prizeId: "b", quantity: 1 + (round % 7) }, { prizeId: "c", quantity: round % 3 }];
    const secret = randomBytes(32), beacon = randomBytes(32);
    const eh = core.entriesHash(cycleId, serials);
    const seed = core.deriveDrawSeed({ secret, beaconValue: beacon, cycleId, entriesHash: eh });
    const winners = core.runDraw(serials, prizes, seed);

    assert.equal(web.toHex(await web.commitSecret(secret)), core.commitSecret(secret).toString("hex"));
    assert.equal(web.toHex(await web.entriesHash(cycleId, serials)), eh.toString("hex"));
    assert.equal(web.toHex(await web.deriveDrawSeed(secret, beacon, cycleId, eh)), seed.toString("hex"));
    assert.deepEqual(await web.runDraw(serials, prizes, seed), winners);

    const published = {
      cycle_id: cycleId, entries: serials, entries_sha256: eh.toString("hex"), secret: secret.toString("hex"),
      beacon_value: beacon.toString("hex"), seed: seed.toString("hex"),
      prizes: prizes.map((p) => ({ prize_id: p.prizeId, quantity: p.quantity })),
      winners: winners.map((w) => ({ prize_id: w.prizeId, position: w.position, serial: w.serial })),
    };
    const commitment = core.commitSecret(secret).toString("hex");
    assert.equal((await web.verifyDraw(published, commitment)).ok, true);
    // Any single alteration is caught.
    if (winners.length && serials.length > 1) {
      const swapped = { ...published, winners: published.winners.map((w, i) => (i === 0 ? { ...w, serial: serials.find((s) => s !== w.serial)! } : w)) };
      assert.equal((await web.verifyDraw(swapped, commitment)).ok, false);
    }
    assert.equal((await web.verifyDraw({ ...published, entries: serials.slice(1) }, commitment)).ok, serials.length === 1 ? false : false);
    assert.equal((await web.verifyDraw(published, core.commitSecret(randomBytes(32)).toString("hex"))).ok, false);
  }
});

test("whole cycle: browser rebuilds the fingerprint and prize counts from a published card list, and spots any change", async () => {
  const cycleId = "cycle-archive";
  const tiers = [{ outcome: "CASH:1000000", count: 1 }, { outcome: "CASH:50000", count: 6 }];
  for (const n of [1, 7, 40]) {
    const t = n === 1 ? [{ outcome: "CASH:50000", count: 1 }] : tiers;
    const outcomes = core.generateOutcomes(n, t, bytes("arch" + n));
    const cards = outcomes.map((outcome, i) => ({ leaf_index: i, serial: `WR-${i}`, outcome, salt: bytes(`s${n}-${i}`, 16).toString("hex"), sale_status: i % 3 ? "SOLD" : "UNSOLD" }));
    const root = new core.MerkleTree(cards.map((c) => core.ticketLeafHash({ cycleId, serial: c.serial, outcome: c.outcome, salt: Buffer.from(c.salt, "hex") }))).root.toString("hex");
    const cycle = { id: cycleId, total_tickets: n, commitment: { ticket_merkle_root: root },
      prizes: t.map((x) => ({ stage: "INSTANT", cash_kobo: Number(x.outcome.slice(5)), quantity: x.count })).concat([{ stage: "FINAL_DRAW", cash_kobo: 1, quantity: 1 }] as any) };
    assert.equal((await web.verifyCycle(cycle, cards)).ok, true, `n=${n}`);
    // Any tampering is caught: a changed outcome, a missing card, swapped order, or an advertised prize that was not there.
    const changed = cards.map((c, i) => (i === 0 ? { ...c, outcome: c.outcome === "NONE" ? "CASH:50000" : "NONE" } : c));
    assert.equal((await web.verifyCycle(cycle, changed)).ok, false);
    assert.equal((await web.verifyCycle(cycle, cards.slice(1))).ok, false);
    if (n > 1) assert.equal((await web.verifyCycle(cycle, [cards[1]!, cards[0]!, ...cards.slice(2)])).ok, false);
    const inflated = { ...cycle, prizes: cycle.prizes.map((p: any, i: number) => (i === 0 ? { ...p, quantity: p.quantity + 1 } : p)) };
    assert.equal((await web.verifyCycle(inflated, cards)).ok, false);
  }
});

test("the phone's checker reproduces the engine's published reference cases exactly", async () => {
  // test-vectors.json is the fixed set of inputs and answers given to the test lab. The checker in the
  // player app is a second, separate implementation; it must agree with every answer.
  const { readFileSync } = await import("node:fs");
  const v = JSON.parse(readFileSync(new URL("../../../packages/game-core/test-vectors.json", import.meta.url), "utf8"));
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  for (const t of v.tickets) {
    assert.equal(hex(await web.ticketLeafHash({ cycleId: t.cycleId, serial: t.serial, outcome: t.outcome, salt: Buffer.from(t.salt, "hex") })), t.leafHash, t.serial);
  }
  const t3 = v.tickets[3];
  const proof = { cycleId: t3.cycleId, serial: t3.serial, outcome: t3.outcome, salt: t3.salt, steps: v.merkle.proofForIndex3 };
  assert.equal(await web.verifyTicket(proof, v.merkle.root), true);
  // The whole card list rebuilds the published root.
  const cycle = { id: v.tickets[0].cycleId, total_tickets: v.tickets.length, commitment: { ticket_merkle_root: v.merkle.root }, prizes: [] as unknown[] };
  const cards = v.tickets.map((t: any, i: number) => ({ leaf_index: i, serial: t.serial, outcome: t.outcome, salt: t.salt }));
  assert.equal((await web.verifyCycle(cycle, cards)).checks[1]!.ok, true);
  // The draw.
  const d = v.draw;
  assert.equal(hex(await web.commitSecret(Buffer.from(d.secret, "hex"))), d.secretCommitment);
  assert.equal(hex(await web.entriesHash(d.cycleId, d.entries)), d.entriesHash);
  const seed = await web.deriveDrawSeed(Buffer.from(d.secret, "hex"), Buffer.from(d.beaconValue, "hex"), d.cycleId, Buffer.from(d.entriesHash, "hex"));
  assert.equal(hex(seed), d.seed);
  assert.deepEqual(await web.runDraw(d.entries, d.prizes, seed), d.winners);
  const published = { cycle_id: d.cycleId, entries: d.entries, entries_sha256: d.entriesHash, secret: d.secret, beacon_value: d.beaconValue, seed: d.seed,
    prizes: d.prizes.map((p: any) => ({ prize_id: p.prizeId, quantity: p.quantity })), winners: d.winners.map((w: any) => ({ prize_id: w.prizeId, position: w.position, serial: w.serial })) };
  assert.equal((await web.verifyDraw(published, d.secretCommitment)).ok, true);
});
