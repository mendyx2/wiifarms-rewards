import { timingSafeEqual } from "node:crypto";
import { FORMAT_VERSION, encodeFields, sha256 } from "./encoding.ts";

/**
 * Ticket commitments.
 *
 * Every ticket in a cycle becomes one leaf. The Merkle root over all leaves is
 * published before sales open. Revealing a ticket later discloses its outcome
 * and salt together with a proof that the leaf was part of the published root,
 * so an outcome cannot be changed after the fact.
 *
 * Leaf and interior hashes use different prefixes (as in RFC 6962) so an
 * interior node can never be passed off as a leaf.
 */

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export interface TicketCommitmentInput {
  cycleId: string;
  /** Public serial number, unique within the cycle. */
  serial: string;
  /** Canonical outcome code, e.g. "NONE" or "CASH:50000" (amount in kobo). */
  outcome: string;
  /** 16 random bytes; keeps the outcome unguessable from the published leaf. */
  salt: Uint8Array;
}

export interface ProofStep {
  hash: Buffer;
  /** Which side the sibling sits on when combining. */
  side: "left" | "right";
}

export function ticketLeafHash(t: TicketCommitmentInput): Buffer {
  if (t.salt.length !== 16) throw new Error("salt must be 16 bytes");
  return sha256(LEAF_PREFIX, encodeFields([FORMAT_VERSION, "ticket", t.cycleId, t.serial, t.outcome, t.salt]));
}

function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** Builds every level of the tree. An unpaired node is carried up unchanged (never duplicated). */
function buildLevels(leaves: readonly Buffer[]): Buffer[][] {
  if (leaves.length === 0) throw new Error("cannot build a tree with no leaves");
  const levels: Buffer[][] = [[...leaves]];
  let current = levels[0]!;
  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = current[i + 1];
      next.push(right === undefined ? left : nodeHash(left, right));
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

export class MerkleTree {
  readonly #levels: Buffer[][];

  constructor(leaves: readonly Buffer[]) {
    this.#levels = buildLevels(leaves);
  }

  get size(): number {
    return this.#levels[0]!.length;
  }

  get root(): Buffer {
    return this.#levels[this.#levels.length - 1]![0]!;
  }

  proof(index: number): ProofStep[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) throw new RangeError("leaf index out of range");
    const steps: ProofStep[] = [];
    let i = index;
    for (let level = 0; level < this.#levels.length - 1; level++) {
      const nodes = this.#levels[level]!;
      const siblingIndex = i % 2 === 0 ? i + 1 : i - 1;
      const sibling = nodes[siblingIndex];
      if (sibling !== undefined) steps.push({ hash: sibling, side: i % 2 === 0 ? "right" : "left" });
      i = Math.floor(i / 2);
    }
    return steps;
  }
}

export function verifyProof(leaf: Uint8Array, proof: readonly ProofStep[], expectedRoot: Uint8Array): boolean {
  let acc: Buffer = Buffer.from(leaf);
  for (const step of proof) {
    acc = step.side === "left" ? nodeHash(step.hash, acc) : nodeHash(acc, step.hash);
  }
  return acc.length === expectedRoot.length && timingSafeEqual(acc, expectedRoot);
}

/** What a player (or auditor) runs to check a revealed ticket against the published root. */
export function verifyTicket(t: TicketCommitmentInput, proof: readonly ProofStep[], publishedRoot: Uint8Array): boolean {
  return verifyProof(ticketLeafHash(t), proof, publishedRoot);
}
