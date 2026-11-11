# Threat model

Who could harm players, the company or the integrity of the game, how, and what stops them.
This is a living document: it is reviewed at the end of each phase and before every launch.

"Enforced in" says where the control lives. **DB** means the database itself rejects the action (see `db/schema.sql`, proven by `db/schema_test.sql`). **Core** means `packages/game-core`. **Planned** means designed here, built in Phase 2 or 3.

## What we are protecting

1. **Fairness** — ticket outcomes and draw results are what was committed, and nobody has an advantage.
2. **Player money and prizes** — stakes, winnings, merchandise.
3. **Company money** — prize funds, revenue, stock.
4. **Personal data** — identity numbers, bank details, documents, play history.
5. **Licence and reputation** — compliance evidence, audit trail, availability on draw day.

## Who might attack

| Actor | Motivation | Capability |
|-------|------------|------------|
| Dishonest player | Win unfairly, double-spend, bonus/refund abuse | Scripts, many phone numbers, modified app |
| Fraud ring | Stolen cards, account takeover, payout diversion | SIM swap, phishing, mule accounts |
| Insider (staff, contractor) | Steer prizes to friends, skim money, cover tracks | Legitimate access, knowledge of the system |
| Privileged engineer / DBA | As insider, with direct database or server access | Can bypass the application |
| External attacker | Data theft, extortion, disruption | Web/API attacks, credential stuffing, DDoS |
| Compromised vendor | Forged payment confirmations, leaked KYC data | Sits on a trusted integration |

## Threats and controls

### A. Game integrity

| # | Threat | Control | Enforced in |
|---|--------|---------|-------------|
| A1 | Insider learns which unsold tickets are winners and buys or tips them | Outcomes encrypted with a per-cycle KMS key; the selling service has no decrypt right; every decrypt is one ticket, logged | Planned (KMS policy) |
| A2 | Insider steers a winning ticket to a chosen account | Tickets assigned at random from the unsold pool by an outcome-blind service; assignment and reveal are separate services with separate credentials | Planned |
| A3 | Outcome changed after sale (winner turned to loser, or reverse) | Merkle root of all tickets published before sales; outcome and leaf columns immutable; reveal returns a proof players verify | Core + DB |
| A4 | Advertised prizes never existed | Exact-count inventory; full list of serials, outcomes and salts published at archive and checkable against the root | Core + Planned |
| A5 | Extra tickets added, or tickets removed, after commit | Ticket insert only while cycle is `APPROVED`; no deletes; leaf count is part of the commitment | DB |
| A6 | Prize schedule, price, odds or dates changed after sales start | Cycle and prize tiers locked from `APPROVED` | DB |
| A7 | Weak or biased randomness in generation | Seed from the KMS/HSM random source; rejection sampling (no modulo bias); algorithm certified by an independent lab | Core + Phase 3 |
| A8 | Operator re-runs the draw until a favoured ticket wins | One draw row per cycle; seed depends on a secret committed before close **and** a public beacon value from a round announced in advance | Core + DB |
| A9 | Operator picks the secret after seeing the beacon | Secret commitment published at cycle commit, weeks before the beacon round | Core + DB |
| A10 | Entry list altered before the draw (entries added or dropped) | Entries hash published before the beacon round; snapshot stored write-once; the verifier recomputes it | Core + Planned |
| A11 | Draw run without oversight | Two different operators plus the auditor appointed for that cycle | DB |
| A12 | Client tampering changes a result | Result never comes from the client; scratch is animation only | By design |
| A13 | Reveal called twice to be paid twice | Reveal once-only; prize credit keyed by ticket; claim unique per ticket | DB |
| A14 | Player infers outcomes from serial numbers or timing | Serials random and unrelated to position; constant-shape reveal responses | Planned |
| A15 | Staff or family play | Exclusion register matched on identity, phone and bank account; winnings void | Planned + DB tables |

### B. Money

| # | Threat | Control | Enforced in |
|---|--------|---------|-------------|
| B1 | Forged "payment succeeded" message | Webhook signature check, then server-to-server re-query; a payment cannot be marked succeeded without `verified_at` | DB + Planned |
| B2 | Same payment or webhook processed twice | Unique provider reference, unique webhook id, one successful payment per order, idempotency key per order | DB |
| B3 | Paying less than the order amount, or in another currency | Amount and currency compared with the order on verification; NGN only | DB + Planned |
| B4 | Tickets issued without payment / payment taken without tickets | Payment confirmation, ledger posting and ticket assignment in one database transaction; automatic refund path | Planned |
| B5 | Balances edited directly | No balance columns; append-only double-entry ledger; every transaction must sum to zero | DB |
| B6 | Insider creates a payout to themselves | Maker and checker must differ; finance and payout-approver roles cannot be held together | DB |
| B7 | Payout diverted to an attacker's bank account | Account name must match verified identity; cooling-off after adding or changing an account; step-up authentication; notification | Planned + DB columns |
| B8 | Refund abuse (refund to a different account, or refund plus keep ticket) | Refund to original method only; ticket cancelled in the same transaction; manual refunds need two people | DB + Planned |
| B9 | Stolen cards used to buy tickets | Gateway 3-D Secure, velocity rules, device signals; chargeback cancels ticket and forfeits winnings | Planned |
| B10 | Prize money not actually available | Approval blocked unless escrow/trust funding covers all cash prizes; funded-cover alert | DB |
| B11 | Merchandise prizes not in stock, or stock diverted | Stock reserved to the cycle at approval; serial-numbered units; handover needs code + photo | Planned + DB tables |
| B12 | Money laundering through purchases and wins | KYC tiers, spending limits, payout to own account only, large-win enhanced checks, suspicious-activity workflow | Planned |

### C. Accounts and data

| # | Threat | Control | Enforced in |
|---|--------|---------|-------------|
| C1 | Account takeover (guessing, SIM swap, phishing) | OTP + PIN, attempt limits, device binding, new-device alerts, SIM-swap check before large payouts | Planned |
| C2 | One person, many accounts (to beat limits or caps) | Unique keyed hash of NIN/BVN per account; device and bank-account matching | DB + Planned |
| C3 | Under-age or out-of-state play | Date of birth from NIN/BVN; location from device with IP and network corroboration; VPN detection | Planned |
| C4 | Self-excluded player keeps playing | Exclusion checked on every purchase; exclusions cannot be shortened or deleted | DB + Planned |
| C5 | Bulk theft of identity or bank data | Field-level encryption with KMS keys; hashes for matching; masking in admin; no PII in logs; least-privilege database roles | Planned |
| C6 | Support staff browse customers or outcomes | Role-limited, masked views; access logged; no role can read unrevealed outcomes | Planned |
| C7 | Next-of-kin details changed to hijack a claim | Step-up authentication, notification, blocked while a claim is open; next of kin is verified independently | Planned |

### D. Platform and operations

| # | Threat | Control | Enforced in |
|---|--------|---------|-------------|
| D1 | Admin account compromised | Separate domain, SSO, hardware-key MFA, network allow-list, short sessions; no single role can complete a sensitive action alone | Planned + DB |
| D2 | Privilege escalation by granting oneself roles | Nobody can grant their own role; conflicting roles rejected; role changes need a second security admin | DB + Planned |
| D3 | Evidence destroyed or altered | Audit log append-only and hash-chained; chain head exported daily to write-once storage outside the database | DB + Planned |
| D4 | Engineer with database superuser bypasses triggers | Tamper is *detectable* (hash chain, published commitments, external anchors); production access is break-glass, time-boxed and logged; application role is not the table owner | DB (detection) + Planned |
| D5 | Malicious or vulnerable dependency / build | Lockfile, dependency and secret scanning, reviewed changes, signed builds; `game-core` has zero third-party dependencies | Core + Planned |
| D6 | Real-money sales switched on early | A real-money cycle cannot open without a valid licence for its state and a certification of the exact game-core version | DB |
| D7 | API abuse: injection, broken access control, scraping | Schema validation, parameterised queries, per-object ownership checks, rate limits, WAF | Planned |
| D8 | Outage or DDoS on draw day or at sell-out | CDN/WAF, autoscaling, queue for purchases, load tests; draw can be delayed but not altered — the seed inputs are already fixed | Planned |
| D9 | Data loss | Encrypted backups, point-in-time recovery, second-zone standby, quarterly restore drills | Planned |
| D10 | KMS key loss or misuse | HSM-backed keys, key policies per service, usage alerts, documented recovery; a lost cycle key is a `VOID` + refund event | Planned |

## Residual risks accepted for now

- **Collusion of two approvers plus the auditor.** Technical controls cannot prevent this; the public commitments and published full ticket list make it detectable afterwards.
- **Public beacon unavailable** at draw time. The draw waits for the announced round or, under a published fallback rule, the next available round. It never falls back to an operator-chosen value.
- **A player's own device is compromised.** We limit the damage (name-matched payouts, step-up authentication) but cannot remove it.

## Open items for Phase 2–3

1. Choose the cloud provider/region and write the KMS key policy per service (A1, A2, C5).
2. Define database roles so the application account cannot disable triggers or own tables (D4).
3. Confirm the regulator's and test lab's RNG requirements; adjust `game-core` if they mandate a specific generator (A7).
4. Set the payout approval threshold and fraud-rule thresholds with Finance and Compliance (B6, B9).
5. Commission the independent penetration test against this document (Phase 3).
