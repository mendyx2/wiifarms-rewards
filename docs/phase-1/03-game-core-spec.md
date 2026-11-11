# Scratch-card and final-draw engine — technical design

Brief deliverable 5. The reference implementation is `packages/game-core` (TypeScript, no third-party dependencies, 10 passing tests). It is **not yet certified**; certification by an independent lab is a Phase 3 exit criterion, and the lab or regulator may require changes.

## 1. Guarantees

| # | Guarantee | How a third party checks it |
|---|-----------|-----------------------------|
| G1 | Every ticket's outcome is fixed before the first sale | The Merkle root published before sales matches every later reveal |
| G2 | The number of prizes is exactly what was advertised | Full ticket list published at archive reproduces the root and the prize counts |
| G3 | The scratch action cannot influence the result | The result is returned by the server from stored data; the proof ties it to the pre-sale root |
| G4 | The draw cannot be predicted or steered by anyone | Seed needs both a pre-committed secret and a later public beacon value |
| G5 | Anyone can reproduce the draw | Inputs are published; `runDraw` is deterministic |

## 2. Encoding rules (all hashes)

- Hash: SHA-256. Keyed hash: HMAC-SHA-256.
- Multi-field inputs use `encodeFields`: each field is prefixed with its length as a 4-byte big-endian integer. This prevents two different field lists producing the same bytes.
- Every input starts with the version string `wiifarm-rewards/v1` and a purpose label (`ticket`, `draw-secret`, `draw-entries`, `draw-seed`), so a hash made for one purpose can never be reused for another.
- Money inside outcome codes is integer kobo: `CASH:50000` is ₦500. No win is `NONE`.

## 3. Ticket inventory

**Inputs:** `totalTickets`, prize tiers (`outcome`, exact `count`), a 32-byte generation seed.

**Procedure (`generateOutcomes`)**
1. Expand the tiers into a list of outcomes; fill the remainder with `NONE`. Reject if prizes exceed tickets.
2. Shuffle with Fisher–Yates using the seeded stream (section 5).
3. Position *i* of the result belongs to the ticket at leaf index *i*.

**Per ticket** the generation job then creates:
- a public **serial**: random, unique within the cycle, unrelated to the leaf index;
- a 16-byte random **salt**;
- the **leaf hash** `SHA-256(0x00 ‖ encodeFields[version, "ticket", cycleId, serial, outcome, salt])`.

The salt stops anyone working out an outcome by hashing guesses against the published leaf.

**Generation seed.** Drawn from the cloud HSM random generator inside the isolated generation job, used once, and never stored in the application database. It is not needed again: the commitment, not the seed, is what binds the outcomes.

## 4. Commitment and proof

- Leaves are combined into a Merkle tree: interior node = `SHA-256(0x01 ‖ left ‖ right)`. An unpaired node is carried up unchanged. The different leaf and node prefixes stop an interior node being passed off as a ticket.
- **Published before sales open:** cycle id, number of tickets, Merkle root, hash of the prize table, hash of the rules document, the draw-secret commitment, and the `game-core` version.
- **On reveal** the player receives outcome, salt and the proof (sibling hashes with sides). `verifyTicket` recomputes the leaf and walks the proof to the root.
- **At archive** every serial, outcome and salt is published so the whole tree can be rebuilt.

## 5. Random stream

- Block *i* = `HMAC-SHA-256(seed, i as 8-byte big-endian)`; each block yields four 64-bit values.
- `nextInt(n)` uses **rejection sampling**: values in the incomplete top slice of the 64-bit range are discarded, so each result in `[0, n)` is exactly equally likely.

## 6. Final draw

| Step | When | Who | Published |
|------|------|-----|-----------|
| 1. Commit secret | At cycle commit | System (secret generated in HSM, stored encrypted) | `commitSecret(secret)` |
| 2. Announce beacon round | At cycle commit | System | Beacon source and round number that falls after the latest close |
| 3. Freeze entries | At close | System | Entry count and `entriesHash(cycleId, serials)` |
| 4. Beacon value arrives | Announced round | Public beacon | (public) |
| 5. Execute | Draw time | Two operators + appointed auditor | Secret, beacon value, seed, winners, signed report |

- **Eligible entries:** tickets that are paid and not cancelled or refunded. Unsold tickets are never entered.
- **Entries hash:** serials sorted ascending, then hashed, so database ordering is irrelevant. Duplicates are an error.
- **Seed:** `HMAC-SHA-256(secret, encodeFields[version, "draw-seed", cycleId, entriesHash, beaconValue])`.
- **Selection (`runDraw`):** prizes are taken in the published draw order. Each pick is `nextInt(remaining)`; the picked ticket is removed from the pool. One ticket therefore wins at most one final-draw prize; one account with several tickets may win several, as decided by management.
- **Fewer entries than prizes:** the draw stops when the pool is empty; undrawn prizes follow the published rules.

**Why both secret and beacon:** with only a secret, the operator could choose it to favour a ticket. With only a beacon, anyone seeing the beacon first could compute winners before publication and the last-minute entry list could be tuned against it. Committing the secret first, then freezing entries, then receiving the beacon closes both gaps.

**Fallback:** if the announced beacon round is unavailable, the next available round is used, as stated in the rules. An operator-chosen value is never permitted.

## 7. Public verifier (Phase 2)

`packages/verifier` will wrap the same functions in a web page and a command-line tool:
- **Check my ticket:** paste or scan the reveal data → pass/fail against the published root.
- **Check the draw:** load the published entries, secret and beacon value → recompute the entries hash, the secret commitment, the seed and the winners.
- **Check the cycle (after archive):** rebuild the tree from the full list → root and prize counts.

## 8. What is deliberately outside `game-core`

Key management, encryption of stored outcomes, ticket assignment at purchase, payments and persistence. `game-core` is pure functions over bytes so that the certified surface stays small and its version can be pinned by hash in each cycle's commitment.

## 9. Questions for the test lab / regulator

1. Is an HMAC-SHA-256 counter-mode generator seeded from an HSM acceptable, or is a specific certified RNG required?
2. Is a public randomness beacon acceptable as a draw input, and which sources?
3. Required statistical test evidence and sample sizes.
4. Any mandated format for draw reports and retention periods.
