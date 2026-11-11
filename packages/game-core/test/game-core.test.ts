import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MerkleTree,
  NO_WIN,
  SeededStream,
  commitSecret,
  deriveDrawSeed,
  entriesHash,
  generateOutcomes,
  instantCashLiabilityKobo,
  runDraw,
  shuffle,
  ticketLeafHash,
  verifySecretCommitment,
  verifyTicket,
} from "../src/index.ts";

const bytes = (label: string, n = 32) => createHash("sha512").update(label).digest().subarray(0, n);
const seed = bytes("seed");

function tickets(n: number) {
  const tiers = [
    { outcome: "CASH:1000000", count: 1 },
    { outcome: "CASH:50000", count: Math.floor(n / 5) },
  ];
  const outcomes = generateOutcomes(n, tiers, seed);
  return outcomes.map((outcome, i) => ({
    cycleId: "cycle-1",
    serial: `WR-${String(i).padStart(6, "0")}`,
    outcome,
    salt: bytes(`salt-${i}`, 16),
  }));
}

test("inventory has exact prize counts and is reproducible from the seed", () => {
  const tiers = [
    { outcome: "CASH:1000000", count: 3 },
    { outcome: "CASH:50000", count: 200 },
  ];
  const a = generateOutcomes(1000, tiers, seed);
  assert.equal(a.length, 1000);
  assert.equal(a.filter((o) => o === "CASH:1000000").length, 3);
  assert.equal(a.filter((o) => o === "CASH:50000").length, 200);
  assert.equal(a.filter((o) => o === NO_WIN).length, 797);
  assert.deepEqual(generateOutcomes(1000, tiers, seed), a);
  assert.notDeepEqual(generateOutcomes(1000, tiers, bytes("other")), a);
  assert.equal(instantCashLiabilityKobo(tiers), 13_000_000n);
  assert.throws(() => generateOutcomes(10, [{ outcome: "CASH:1", count: 11 }], seed));
});

test("every ticket verifies against the root, for awkward tree sizes", () => {
  for (const n of [1, 2, 3, 5, 7, 8, 13, 100]) {
    const ts = tickets(n);
    const tree = new MerkleTree(ts.map(ticketLeafHash));
    ts.forEach((t, i) => assert.ok(verifyTicket(t, tree.proof(i), tree.root), `n=${n} i=${i}`));
  }
});

test("a changed outcome, salt, serial or cycle fails verification", () => {
  const ts = tickets(13);
  const tree = new MerkleTree(ts.map(ticketLeafHash));
  const t = ts[4]!;
  const proof = tree.proof(4);
  assert.ok(verifyTicket(t, proof, tree.root));
  assert.ok(!verifyTicket({ ...t, outcome: "CASH:1000000" }, proof, tree.root));
  assert.ok(!verifyTicket({ ...t, salt: bytes("x", 16) }, proof, tree.root));
  assert.ok(!verifyTicket({ ...t, serial: "WR-000005" }, proof, tree.root));
  assert.ok(!verifyTicket({ ...t, cycleId: "cycle-2" }, proof, tree.root));
  assert.ok(!verifyTicket(t, tree.proof(5), tree.root));
  assert.ok(!verifyTicket(t, proof, bytes("wrong-root")));
});

test("field boundaries cannot be shifted to forge a leaf", () => {
  const salt = bytes("s", 16);
  const a = ticketLeafHash({ cycleId: "c1", serial: "2A", outcome: "NONE", salt });
  const b = ticketLeafHash({ cycleId: "c12", serial: "A", outcome: "NONE", salt });
  assert.notDeepEqual(a, b);
});

test("an interior node cannot be presented as a leaf", () => {
  const ts = tickets(4);
  const leaves = ts.map(ticketLeafHash);
  const tree = new MerkleTree(leaves);
  // Proof for leaf 0 minus its first step would verify the interior node if prefixes were shared.
  const [, ...upper] = tree.proof(0);
  const fakeLeaf = createHash("sha256").update(Buffer.concat([leaves[0]!, leaves[1]!])).digest();
  assert.ok(!verifyTicket({ ...ts[0]!, outcome: fakeLeaf.toString("hex") }, upper, tree.root));
});

test("nextInt is in range and roughly uniform", () => {
  const s = new SeededStream(seed);
  const counts = new Array<number>(6).fill(0);
  for (let i = 0; i < 60_000; i++) {
    const v = s.nextInt(6);
    assert.ok(v >= 0 && v < 6);
    counts[v]!++;
  }
  for (const c of counts) assert.ok(Math.abs(c - 10_000) < 500, `count ${c}`);
  assert.throws(() => s.nextInt(0));
});

test("shuffle is a permutation and leaves the input untouched", () => {
  const input = Array.from({ length: 50 }, (_, i) => i);
  const out = shuffle(input, new SeededStream(seed));
  assert.deepEqual([...out].sort((a, b) => a - b), input);
  assert.notDeepEqual(out, input);
  assert.equal(input[0], 0);
});

test("draw is reproducible, order-independent and never picks a ticket twice", () => {
  const serials = Array.from({ length: 500 }, (_, i) => `WR-${String(i).padStart(6, "0")}`);
  const prizes = [
    { prizeId: "vehicle", quantity: 1 },
    { prizeId: "fridge", quantity: 5 },
    { prizeId: "rice-50kg", quantity: 50 },
  ];
  const secret = bytes("secret");
  const commitment = commitSecret(secret);
  assert.ok(verifySecretCommitment(secret, commitment));
  assert.ok(!verifySecretCommitment(bytes("other"), commitment));

  const eh = entriesHash("cycle-1", serials);
  assert.deepEqual(entriesHash("cycle-1", [...serials].reverse()), eh);
  const drawSeed = deriveDrawSeed({ secret, beaconValue: bytes("beacon"), cycleId: "cycle-1", entriesHash: eh });

  const winners = runDraw(serials, prizes, drawSeed);
  assert.equal(winners.length, 56);
  assert.equal(new Set(winners.map((w) => w.serial)).size, 56);
  assert.ok(winners.every((w) => serials.includes(w.serial)));
  assert.deepEqual(runDraw([...serials].reverse(), prizes, drawSeed), winners);

  const otherSeed = deriveDrawSeed({ secret, beaconValue: bytes("beacon-2"), cycleId: "cycle-1", entriesHash: eh });
  assert.notDeepEqual(runDraw(serials, prizes, otherSeed), winners);
});

test("draw with fewer entries than prizes stops cleanly; duplicates are rejected", () => {
  const w = runDraw(["a", "b"], [{ prizeId: "p", quantity: 5 }], seed);
  assert.deepEqual(w.map((x) => x.serial).sort(), ["a", "b"]);
  assert.throws(() => runDraw(["a", "a"], [{ prizeId: "p", quantity: 1 }], seed));
  assert.deepEqual(runDraw([], [{ prizeId: "p", quantity: 1 }], seed), []);
});

test("draw gives every entry an equal chance (statistical check)", () => {
  const serials = ["a", "b", "c", "d"];
  const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
  for (let i = 0; i < 8000; i++) {
    const w = runDraw(serials, [{ prizeId: "p", quantity: 1 }], bytes(`s${i}`));
    counts[w[0]!.serial]!++;
  }
  for (const c of Object.values(counts)) assert.ok(Math.abs(c - 2000) < 200, `count ${c}`);
});
