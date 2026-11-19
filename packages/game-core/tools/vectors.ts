// Known-answer test vectors: fixed inputs and the outputs this engine produces.
// A test lab (or anyone re-implementing the published rules) can reproduce
// every value. test/vectors.test.ts fails if the engine's behaviour changes,
// which would also mean the engine needs certifying again.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MerkleTree, SeededStream, commitSecret, deriveDrawSeed, entriesHash, generateOutcomes, runDraw, shuffle, ticketLeafHash,
} from "../src/index.ts";

/** Fixed 32-byte (or n-byte) values derived from labels, so every input is written down. */
export const fixed = (label: string, n = 32) => createHash("sha256").update(label).digest().subarray(0, n);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export function buildVectors() {
  const seed = fixed("vector-seed");
  const s1 = new SeededStream(seed);
  const s2 = new SeededStream(seed);
  const tiers = [{ outcome: "CASH:1000000", count: 1 }, { outcome: "CASH:50000", count: 4 }];
  const outcomes = generateOutcomes(20, tiers, fixed("vector-generation"));
  const tickets = outcomes.slice(0, 7).map((outcome, i) => ({ cycleId: "vector-cycle", serial: `WR-VEC-${i}`, outcome, salt: fixed(`vector-salt-${i}`, 16) }));
  const tree = new MerkleTree(tickets.map(ticketLeafHash));
  const secret = fixed("vector-draw-secret");
  const beacon = fixed("vector-beacon");
  const entries = Array.from({ length: 25 }, (_, i) => `WR-ENTRY-${String(i).padStart(2, "0")}`);
  const eh = entriesHash("vector-cycle", entries);
  const drawSeed = deriveDrawSeed({ secret, beaconValue: beacon, cycleId: "vector-cycle", entriesHash: eh });
  const prizes = [{ prizeId: "first", quantity: 1 }, { prizeId: "second", quantity: 3 }];
  return {
    description: "Known-answer vectors for game-core. Every input is given in full (hex) or as the label it is derived from: fixed(label) = first n bytes of SHA-256(label).",
    seededStream: { seed: hex(seed), nextInt1000: Array.from({ length: 12 }, () => s1.nextInt(1000)), nextInt7: Array.from({ length: 12 }, () => s2.nextInt(7)) },
    shuffle: { seed: hex(fixed("vector-shuffle")), input: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], output: shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], new SeededStream(fixed("vector-shuffle"))) },
    inventory: { totalTickets: 20, tiers, seed: hex(fixed("vector-generation")), outcomes },
    tickets: tickets.map((t) => ({ cycleId: t.cycleId, serial: t.serial, outcome: t.outcome, salt: hex(t.salt), leafHash: hex(ticketLeafHash(t)) })),
    merkle: { root: hex(tree.root), proofForIndex3: tree.proof(3).map((p) => ({ hash: hex(p.hash), side: p.side })) },
    draw: {
      cycleId: "vector-cycle", secret: hex(secret), secretCommitment: hex(commitSecret(secret)), beaconValue: hex(beacon),
      entries, entriesHash: hex(eh), seed: hex(drawSeed), prizes, winners: runDraw(entries, prizes, drawSeed),
    },
  };
}

export const VECTORS_FILE = fileURLToPath(new URL("../test-vectors.json", import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  writeFileSync(VECTORS_FILE, JSON.stringify(buildVectors(), null, 2) + "\n");
  console.log("wrote " + VECTORS_FILE);
}
