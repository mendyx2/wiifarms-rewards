# WiiFarm Rewards — Implementation Plan

Response to the CEO's IT Development Brief of 5 November 2026.
Status: **proposal for management review**. Nothing here is built yet.

Two priorities drive every decision below, in this order:

1. **Safety and integrity** — for players (fair, provable outcomes; protected money and data), for the company (no insider or external manipulation, reconciled liabilities), and for regulators and auditors (everything verifiable after the fact).
2. **User experience** — an ordinary smartphone user on a slow connection must be able to register, buy, scratch and get paid without help.

Where they conflict, safety wins, and the plan says how the UX cost is kept small.

---

## 1. Guiding principles

| # | Principle | What it means in practice |
|---|-----------|---------------------------|
| 1 | Outcomes are fixed before sale | Every ticket's result is generated and cryptographically committed before the cycle opens. The scratch animation only reveals it. |
| 2 | Verify, don't trust | Players, auditors and regulators can check scratch outcomes and the final draw themselves with a published verifier. |
| 3 | No single person can move money or change a game | Dual approval (maker–checker) on cycle approval, payouts, refunds, role changes and draw execution. |
| 4 | Money is a ledger, not a balance column | Append-only double-entry ledger in kobo (integers). Balances are derived, never edited. |
| 5 | Paid entries are off by default | A hard technical gate keeps real-money sales disabled until licence and certification records exist for the player's state. |
| 6 | Own the core, rent the regulated edges | We own code, schema, game logic and UI. Payments, identity checks, SMS and RNG certification are integrated third parties behind our own interfaces. |
| 7 | Simple first | Phone number sign-up, three-tap purchase, one-screen scratch, plain-language odds. |

---

## 2. Architecture

### 2.1 Shape

A **modular monolith** with strict module boundaries, not microservices. One deployable API is easier to secure, audit and certify, and each module (below) can be split out later if scale demands it.

```
 Players (PWA, later Android/iOS)        Admins (separate admin web app)
              |                                      |
        CDN + WAF + rate limiting          SSO + hardware MFA + IP allow-list
              |                                      |
              +---------------- API (REST, versioned) ----------------+
              |  identity | cycles | tickets | draw | payments |      |
              |  ledger | fulfilment | responsible-gaming | audit     |
              +-------------------------------------------------------+
                 |             |              |              |
            PostgreSQL       Redis         Queue /       KMS / HSM
          (primary + replica) (sessions,   workers      (ticket & PII keys)
                              rate limits) (webhooks,
                                            payouts,
                                            notifications)
                 |
        Object storage (prize images, KYC docs, draw reports, WORM audit archive)

 External: payment gateway · KYC provider · SMS/WhatsApp/email · public randomness beacon
```

### 2.2 Proposed stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript end to end | One language across API, web and future mobile; shared types and validation. |
| API | NestJS on Node.js LTS | Enforced module structure, guards for RBAC, mature ecosystem. |
| Database | PostgreSQL | Transactions, row-level locking for inventory, row-level security, triggers for immutability. |
| Cache / queue | Redis + BullMQ | Sessions, rate limiting, ticket reservations, background jobs. |
| Player web | Next.js PWA | Installable, works on low-end Android, small bundles, server-rendered catalogue. |
| Admin web | Separate Next.js app on a separate domain | Isolated attack surface and session scope. |
| Mobile (Phase 5) | React Native, reusing the API and shared packages | "Future Android and iOS applications" without a rewrite. |
| Infrastructure | Managed cloud, infrastructure-as-code, containers | Reproducible environments, auditable changes. |
| Secrets and keys | Cloud KMS (HSM-backed keys for ticket outcomes and draw secrets) | Keys never sit in app config or the database. |

Hosting is a regional cloud region (decided, section 12). The specific provider and region are chosen in Phase 1, subject to NDPA cross-border transfer safeguards and anything the Niger State regulator requires.

### 2.3 Repository layout (monorepo)

```
apps/
  api/          NestJS API and workers
  web/          Player PWA
  admin/        Admin dashboard
packages/
  game-core/    Pure, dependency-free ticket generation, commitment and draw logic
  verifier/     Public, open verifier (CLI + web page) for scratch proofs and draws
  shared/       Types, validation schemas, money utilities
  ui/           Shared components (scratch card, prize card, forms)
infra/          Infrastructure-as-code, CI/CD
docs/           Architecture, threat model, runbooks, certification pack
```

`game-core` is deliberately small and pure so an independent test lab can certify it in isolation and so the certified version can be pinned by hash.

---

## 3. Modules (brief sections 4A–4G)

### A. Customer management
- Sign-up with phone number + OTP, then a 6-digit PIN; passkeys/biometrics where the device supports them.
- Tiered verification so the first minute is not a form wall:
  - **Tier 0** (phone verified): browse catalogue, play the free demo.
  - **Tier 1** (age 18+ and identity verified via NIN or BVN, location confirmed in a licensed state): buy tickets, receive instant cash prizes up to a set limit.
  - **Tier 2** (bank account name-matched to verified identity, liveness check): larger payouts and merchandise claims.
- Profile, ticket history, prize and redemption history, notifications inbox, in-app support tickets.
- Responsible gaming: default daily/weekly/monthly spend limits, per-cycle ticket cap, cool-off, self-exclusion. Lowering a limit is instant; raising one takes effect after 24 hours. Self-exclusion cannot be reversed early and also suppresses marketing messages.

### B. Digital scratch card engine
See section 4.1 for the full design.

### C. Prize cycle management
- Cycle state machine, enforced in the database as well as the API:

  `DRAFT → SUBMITTED → APPROVED → COMMITTED → OPEN → CLOSED → DRAWN → SETTLING → ARCHIVED`

- `APPROVED` requires two different approvers (operations and finance) and attached evidence: the financial model, proof that prizes are secured (stock received or funds reserved), and the published rules.
- `COMMITTED` generates the ticket inventory and publishes the commitments. From this point prize schedule, price, quantities, odds and closing rules are **immutable** — database triggers reject updates regardless of who is asking. The only allowed exceptional action is a regulator-reportable `VOID` with full refunds, requiring dual approval.
- Closing rule: the cycle closes at **sell-out or the published closing date, whichever comes first**; the draw then runs on the published schedule over the tickets actually sold.
- Live monitoring: sold/remaining, revenue, instant prizes revealed vs. outstanding, total prize liability.

### D. Final digital draw
See section 4.2.

### E. Payments and cash prizes
See section 5.

### F. Merchandise inventory and fulfilment
- Catalogue item → SKU → individual stock units with serial numbers, warehouse location, supplier, purchase order, acquisition and landed cost, advertised value, warranty documents.
- Stock for a cycle is **reserved** at approval; a cycle cannot be approved against stock that is not physically received or contractually secured.
- Redemption workflow: winner notified → identity re-verified → choose delivery or collection → dispatch/collection with OTP handover and photo proof → warranty registered → closed. Every step is logged with actor and time.
- Unclaimed-prize policy (claim window, reminders, what happens after expiry) is configured per cycle and published in the rules.

### G. Management dashboard
- All figures listed in the brief, computed from the ledger and ticket tables rather than hand-maintained counters.
- Role-based access with separation of duties:

  | Role | Can | Cannot |
  |------|-----|--------|
  | Cycle manager | Draft cycles, upload prizes | Approve own cycles, see ticket outcomes |
  | Finance | Approve budgets, reconcile, initiate payouts | Approve own payouts, edit cycles |
  | Payout approver | Approve payouts | Initiate payouts |
  | Fulfilment | Manage stock and deliveries | Touch money or cycles |
  | Support | View customer records (masked), handle tickets | See outcomes, change limits upward |
  | Compliance | View everything, export reports, manage exclusions | Change game or money data |
  | Auditor / regulator (read-only) | View audit trail, draw records, reports | Change anything |
  | Security admin | Manage roles (dual approval) | Operate games or money |

- Nobody, including engineers and database administrators, can read unrevealed ticket outcomes (section 4.1).

---

## 4. Game integrity design

### 4.1 Scratch cards

**Generation (at `COMMITTED`)**
1. The approved prize table (for example 100,000 tickets: N at ₦500, N at ₦1,000 … the rest no instant win) is expanded into an exact list of outcomes. Counts are exact, not probabilistic, so prize liability is known to the kobo.
2. The list is shuffled with a certified cryptographic RNG (Fisher–Yates with rejection sampling) inside an isolated generation job.
3. Each ticket gets a random 128-bit salt and a public serial. Its leaf hash is `SHA-256(cycleId | serial | outcome | salt)`.
4. All leaves form a Merkle tree. The **Merkle root, the prize table and the rules hash are published** (cycle page, downloadable, emailed to the auditor/regulator) before sales open.
5. Outcome and salt are stored **encrypted with a per-cycle key held in KMS**. The application role that sells tickets has no decrypt permission; only the reveal service does, and only one ticket at a time, with every decrypt logged.

**Sale**
- Tickets are assigned to a buyer at random from the unsold pool, by a service that cannot see outcomes. This stops both insiders and players from cherry-picking winners.
- Assignment uses row locks (`FOR UPDATE SKIP LOCKED`) inside the payment-confirmation transaction, so a ticket can never be sold twice even under heavy load.

**Reveal**
- When the player scratches, the client calls `reveal`. The server decrypts that one ticket, marks it revealed, credits any instant prize to the ledger in the same transaction, and returns outcome + salt + Merkle proof.
- `reveal` is idempotent: a dropped connection or a second tap returns the same result and never pays twice.
- The scratch canvas is pure presentation. A "Reveal now" button gives the same result for accessibility and weak devices.
- Unscratched tickets are auto-revealed and credited when the cycle closes, so no winner loses out by forgetting.

**Verification**
- Every revealed ticket has a "Verify this ticket" link that recomputes the leaf and checks the proof against the published root — in the browser, using the open verifier.
- After the cycle is archived, the full list of serials, outcomes and salts is published, proving that every advertised prize really existed, including on unsold tickets.

### 4.2 Final draw

1. **Freeze**: at close, eligible entries are compiled automatically — paid, valid, not refunded, not cancelled. Unsold tickets are excluded. The ordered entry list is hashed and the hash published.
2. **Commit**: before close, the system commits to a secret (`SHA-256(secret)` published) and announces which future round of a public randomness beacon (e.g. drand) will be used.
3. **Seed**: `seed = HMAC-SHA-256(secret, beaconValue)`. Neither WiiFarm (which cannot predict the beacon) nor anyone outside (who does not know the secret) can influence or foresee it.
4. **Select**: a published deterministic algorithm in `game-core` maps the seed to winners, major prizes first, with the published rule on whether one ticket/person can win more than once.
5. **Witness**: executing the draw needs two authorised operators plus an auditor/regulator witness account to sign in and countersign.
6. **Publish**: winning serials (and masked winner names where the rules allow), the secret, beacon round, entry-list hash and a signed PDF/JSON draw report. Anyone can re-run the draw with the verifier and get the same winners.
7. **Archive**: draw records go to write-once storage with a retention lock.

The public draw presentation (live page with countdown and animated reveal) plays back this already-determined, already-verifiable result.

If the regulator mandates a specific certified RNG product or procedure, it plugs in behind the same `DrawRandomnessSource` interface; the commit, publish and verify steps stay.

### 4.3 Tamper-evident audit trail
- Every state-changing action writes an audit record: actor, role, IP/device, before/after, reason.
- Records are hash-chained; the chain head is anchored daily to write-once storage and sent to the auditor mailbox, so deletion or back-dating is detectable.
- The application database role has `INSERT` only on audit and ledger tables — no `UPDATE` or `DELETE`.

---

## 5. Money safety

- **Gateway-hosted card entry**: card data never touches our servers (keeps PCI scope minimal). Supported methods: card, bank transfer, USSD.
- **Purchase flow**: reserve quantity (short TTL) → create payment intent with idempotency key → player pays → gateway webhook (signature verified, then re-queried server-to-server, amount and currency checked) → in one transaction: ledger entries + ticket assignment → receipt. Client-side "success" callbacks are never trusted.
- **Failure handling**: paid but sold out, duplicate webhook, late webhook after reservation expiry, partial fulfilment — each has a defined path ending in either tickets issued or an automatic refund, never in limbo.
- **Double-entry ledger** with accounts for gateway clearing, ticket revenue, instant-prize liability, final-draw liability, player winnings payable, refunds, fees and taxes. All amounts are integer kobo.
- **Prize funds protected**: prize liabilities are funded at cycle approval and held in a segregated account; the dashboard shows liability vs. funded cover and alerts on any shortfall.
- **Payouts**: only to a bank account whose resolved name matches the verified identity; new or changed bank details trigger a cooling-off period and a notification; step-up authentication (PIN/biometric) on every withdrawal; amounts above a threshold need maker–checker approval; statutory deductions are applied where the law requires and shown to the winner.
- **Daily reconciliation**: gateway settlement files vs. ledger vs. bank statements; any mismatch raises a compliance alert and blocks cycle archiving until resolved.
- **Fraud monitoring**: velocity rules, device fingerprinting, multiple accounts per device/BVN/bank account, chargeback tracking, staff-and-relatives exclusion list, anomaly alerts on win rates per account, per device and per staff member.

---

## 6. Platform security

- **Players**: OTP + PIN, short-lived access tokens with rotating refresh tokens, device binding, new-device alerts, lockout and back-off on PIN attempts, SIM-swap check before high-value payouts.
- **Admins**: separate domain, SSO, hardware-key MFA, IP allow-list or VPN, short sessions, no shared accounts, access reviewed quarterly.
- **API**: schema validation on every input, per-user and per-IP rate limits, object-level authorisation checks on every resource, WAF and bot protection, strict CORS and CSP.
- **Data**: TLS everywhere; encryption at rest; field-level encryption for NIN/BVN, bank details and documents; PII masked in the admin UI and scrubbed from logs.
- **Engineering**: mandatory code review, signed commits and builds, dependency and secret scanning in CI, no production database access without a time-boxed, logged break-glass approval.
- **Operations**: centralised logging and alerting, automated encrypted backups with point-in-time recovery, standby in a second zone/region, restore drills each quarter, written incident-response and breach-notification runbooks.
- **Independent assurance**: threat model in Phase 1; external penetration test and game/RNG certification in Phase 3; repeat on every major release.

---

## 7. Compliance gates built into the software

- **Paid-entry gate**: a real-money purchase is only possible if (a) the environment is production, (b) a valid licence record exists for the player's state, (c) the certification record for the deployed `game-core` version exists, and (d) the cycle is `OPEN`. Missing any one → the buy button is replaced with an explanation. Phase 2 runs entirely in simulated mode with a visible "DEMO – no real money" banner.
- **Geography**: state-by-state allow-list driven by licence records; location from device GPS with IP and phone-number checks as corroboration; VPN/proxy detection.
- **Age and identity**: 18+ confirmed against NIN/BVN date of birth, one account per person.
- **Data protection (NDPA)**: consent and privacy notices, data-subject access/erasure workflow (within gaming record-retention duties), DPIA, data-processing agreements with vendors, retention schedule, breach notification procedure.
- **AML**: thresholds for enhanced checks on large wins, sanctions/PEP screening via the KYC provider, suspicious-activity reporting workflow.

The first launch state is Niger State (section 12). The licensing authority there and its exact technical standards must be confirmed by legal counsel before Phase 3 scoping.

---

## 8. User experience plan

**Player journey (target: first scratch within 3 minutes of landing)**
1. Land on the cycle page: prizes with photos, price, tickets left, odds in plain words ("1 in 5 tickets wins instant cash"), closing rule, countdown.
2. Try a free demo card without an account.
3. Sign up with phone + OTP; verify identity with one number (NIN or BVN) and a selfie only when needed for the tier.
4. Buy: quantity stepper → pay → tickets appear immediately.
5. Scratch with a finger; haptics and a short win animation; "Reveal now" and "Reveal all" for speed and accessibility.
6. Every ticket shows "Entered in the final draw ✓" with the draw date.
7. Winnings land in an in-app wallet view; "Withdraw to bank" in two taps once a bank account is verified.
8. Draw day: live page, notification of result, winners list, "Verify the draw" link.
9. Merchandise winners: guided claim with delivery tracking.

**Design rules**
- Mobile-first, works on low-end Android and 3G: small bundles, compressed images, skeleton loading, resilient to dropped connections (purchases and reveals are idempotent and resumable).
- Installable PWA with push notifications; SMS/WhatsApp fallback for critical messages (OTP, win, payout, draw result).
- English and Hausa at launch (Niger State first), with Pidgin, Yoruba and Igbo to follow; plain language, no jargon.
- Trust is visible: licence details, published odds, commitments and verification links, clear receipts.
- Accessibility: large touch targets, screen-reader labels, non-gesture alternatives, colour-safe contrast.
- Responsible gaming is part of the flow, not hidden: spend-so-far indicator, easy limit setting, visible self-exclusion and help links.
- No dark patterns: no fake scarcity, no near-miss animations, no pressure messaging to excluded or limit-reached players.

**Admin UX**: guided cycle wizard with validation (prize budget vs. revenue, stock availability), clear approval queues, a liability/reconciliation home screen, and every destructive action behind a typed confirmation and a second approver.

---

## 9. Data model (core tables)

`users`, `kyc_verifications`, `devices`, `sessions`, `rg_limits`, `self_exclusions`
`cycles`, `cycle_approvals`, `prize_tiers`, `cycle_commitments`
`tickets` (serial, cycle, encrypted outcome, leaf hash, status, owner, sold_at, revealed_at)
`orders`, `payments`, `payment_events` (raw webhooks), `refunds`
`ledger_accounts`, `ledger_entries` (append-only)
`draws`, `draw_entries_snapshot`, `draw_results`, `draw_attestations`
`prize_claims`, `payouts`, `bank_accounts`
`suppliers`, `purchase_orders`, `skus`, `stock_units`, `warehouses`, `shipments`, `warranties`
`admin_users`, `roles`, `permissions`, `approval_requests`
`audit_log` (hash-chained, append-only), `licences`, `certifications`, `compliance_alerts`
`notifications`, `support_tickets`

Key constraints: unique ticket serial per cycle; a ticket has at most one owner, one reveal and one prize claim (unique indexes, not just application checks); immutability triggers on committed cycles, tickets' outcome fields, ledger and audit rows.

---

## 10. Integrations and build-vs-buy (deliverables 6 and 9)

| Component | Recommendation | Candidates to evaluate |
|-----------|----------------|------------------------|
| Core platform, game logic, ledger, admin, fulfilment, UI | **Build in-house** — this is the proprietary IP | — |
| Payment collection and payouts | License; integrate two providers behind one interface for failover | Paystack, Flutterwave, Interswitch |
| Identity (NIN/BVN, liveness, sanctions) | License | Smile ID, Dojah, Prembly, VerifyMe |
| SMS / OTP / WhatsApp | License, with a fallback route | Termii, Africa's Talking |
| Email and push | License | Amazon SES or similar; Firebase Cloud Messaging |
| Public randomness for draws | Use a public beacon; certified RNG product if the regulator requires | drand |
| RNG and game certification | Outsource to an accredited test lab accepted by the regulator | To be shortlisted with counsel |
| Penetration testing and security audit | Outsource to an independent firm | To be shortlisted |
| Last-mile delivery of merchandise | Outsource, tracked through our fulfilment module | Regional logistics partners |
| Fraud tooling | Start with in-house rules; add a vendor if volume justifies | — |

Final vendor selection follows a short evaluation in Phase 1 (pricing, reliability, licence status, data-protection terms).

---

## 11. Schedule and milestones (deliverable 7)

Indicative, assuming a core team of 2 backend, 2 frontend, 1 designer, 1 QA, 1 DevOps/security (part-time), 1 product/project lead.

| Phase | Duration | Milestones / exit criteria |
|-------|----------|----------------------------|
| **1. System design** | Weeks 1–4 | Process flowcharts, customer journey, architecture, database design, threat model, clickable UI prototypes (player + admin), vendor shortlist, cost estimate. **Exit: management sign-off.** |
| **2. Minimum viable platform (simulated money only)** | Weeks 5–16 | M1 (wk 7): repo, CI/CD, auth, RBAC, audit log. M2 (wk 10): cycle management, ticket generation with commitments, catalogue. M3 (wk 13): simulated payments, ledger, scratch UI, reveal + verifier. M4 (wk 16): test final draw, fulfilment basics, dashboard, demo prototype. **Exit: end-to-end demo cycle with verifiable outcomes.** |
| **3. Security and certification** | Weeks 17–26 (partly dependent on third parties) | Real gateway and KYC integrations in sandbox, reconciliation, load tests (sell-out bursts), penetration test and fixes, test-lab certification of `game-core` and draw, DR drill, compliance pack. **Exit: certificates and clean retest.** |
| **4. Controlled commercial launch** | After licence approval, ~4 weeks | One small fully funded cycle in Niger State, invited users first, daily reconciliation review, live draw with auditor. **Exit: cycle archived with zero unreconciled items.** |
| **5. Expansion** | Ongoing | More merchandise categories, mobile apps, additional states, larger prize pools, more languages. |

The earliest tangible output is the **demonstration prototype** (deliverable 10) at the end of Phase 2, with an early clickable version of the scratch flow by week 4.

**Cost estimate (deliverable 8)**: produced in Phase 1 once team rates, hosting region and vendor quotes are confirmed. It will cover development, hosting, maintenance, security testing, certification and per-transaction third-party fees. Quoting figures before then would be guesswork.

---

## 12. Management decisions

### Decided (11 November 2026)

| # | Decision | Effect on the plan |
|---|----------|--------------------|
| 1 | **Launch in Niger State first** | The geographic allow-list starts with Niger State only; players located elsewhere can browse and play the demo but cannot buy. Licence and certification requirements are scoped to Niger State's regulator. Hausa moves ahead of the other local languages, alongside English. |
| 2 | **Regional cloud hosting** | Production runs in a regional cloud region rather than an in-country data centre. Customer data therefore leaves Nigeria, so NDPA cross-border transfer safeguards (legal basis, vendor data-processing agreements, DPIA) become a Phase 1 task, and backups/standby stay within the same provider. |
| 6 | **Team: mix of in-house staff and contractors** (recorded from a "yes" reply — to be confirmed) | In-house staff own `game-core`, the ledger, keys and production access; contractors work on UI, admin and integrations under code review. The cost estimate is prepared on this basis. |

**To verify with counsel before any further Niger State spend:** that a lottery/scratch-card licence is actually obtainable there, from which authority, and on what terms. Niger State is understood to be among the northern states applying Sharia-based law, under which gambling may be restricted. If a licence is not available, the first-state choice must change; the software is unaffected because the allow-list is data, not code.

### Still open

3. **Independent auditor / draw witness** — who it is, so their role and sign-off are designed in from the start.
4. **Prize-fund protection** — segregated account or escrow arrangement, and who the finance approvers are.
5. **Policy choices that become published rules** — unclaimed-prize window, refund conditions for a voided cycle, whether one person can win multiple major prizes, default spending limits, staff and family exclusion.

---

## 13. Top risks

| Risk | Mitigation |
|------|------------|
| Insider learns or alters winning tickets | KMS-encrypted outcomes, outcome-blind random assignment, pre-sale commitments, post-cycle full disclosure, hash-chained audit |
| Draw manipulation or the perception of it | Commit–reveal with public beacon, auditor witness, open verifier |
| Double spend / double payout under load or retries | Idempotency keys, database uniqueness constraints, single-transaction ledger + ticket updates |
| Payment webhook spoofing | Signature verification plus server-to-server re-query |
| Account takeover and payout diversion | Step-up auth, name-matched bank accounts, cooling-off on bank changes, SIM-swap checks |
| Prize liabilities unfunded | Approval blocked without evidence; funded-cover alerting |
| Launching before approval | Hard paid-entry gate tied to licence and certification records |
| Under-age or excluded play | NIN/BVN age check, one account per identity, enforced limits and exclusion |
| Certification or licensing delays | Phases 1–2 do not depend on them; `game-core` isolated to shorten certification |
| Poor connectivity hurting UX | Lightweight PWA, idempotent resumable flows, SMS fallback |

---

## 14. Immediate next steps (first two weeks)

1. Management answers the remaining open items in section 12 (auditor, prize-fund protection, published-rule policies).
2. Write the threat model and the detailed specification for `game-core` (ticket commitments, draw algorithm, verifier).
3. Produce player and admin wireframes for the core journey.
4. Scaffold the monorepo with CI, linting, tests and environments.
5. Open sandbox accounts with the shortlisted payment, KYC and SMS providers.
6. Engage legal counsel on Niger State licensing availability, NDPA cross-border transfer safeguards and certification bodies.
