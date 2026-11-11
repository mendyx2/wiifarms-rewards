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
