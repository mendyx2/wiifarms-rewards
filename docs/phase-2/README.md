# Phase 2 — minimum viable platform (simulated money only)

Status as of 12 November 2026: **backend, player web app and admin web app complete for the core journey, including merchandise, and tested end to end.** Notifications, reports and archiving remain.

Nothing in this phase can take real money. There is no payment-gateway integration, every cycle is created in `SIMULATED` mode, the API has no setting that changes this, and the database separately refuses to open a real-money cycle without a licence and certification record.

## What is built

`apps/api` — one service, one module per business area, on the Phase 1 database.

| Brief module | Built now | Simulated stand-in |
|--------------|-----------|--------------------|
| A. Customer management | Phone + one-time code sign-up, 6-digit PIN, sign-in with lockout, sessions, age/identity/location check, one account per identity, next of kin, spending limits (lower now, raise after 24h), cool-off and self-exclusion, staff exclusion register, bank account with name match and cooling-off | Identity provider, SMS, bank name enquiry |
| B. Scratch-card engine | Fixed inventory generated at commit, outcomes encrypted per ticket, fingerprint published, random outcome-blind assignment at purchase, once-only reveal with proof | Cloud key service (local key used instead) |
| C. Prize cycle management | Draft → submit → two approvals → commit → open → close; evidence and escrow check; locked after approval; closes on sell-out or closing time | — |
| D. Final draw | Entries frozen, two operators + appointed auditor, committed secret + beacon, runs once, public data to re-run it | Public randomness beacon |
| E. Payments and cash prizes | Orders with idempotency, payment confirmation, automatic refund when no card can be issued, double-entry ledger, winnings balance, withdrawals with PIN, second approver above a threshold, reject returns the money | Payment gateway and bank transfers |
| F. Merchandise | Items, suppliers, warehouses, purchase orders; stock received with purchase and landed cost and serial numbers; stock reserved to a cycle before approval; winner's claim (delivery or collection); dispatch; handover against a one-time code with photo; warranty reference; expiry of unclaimed prizes | Carrier integration (tracking is typed in); photos and documents are file references, not uploads |
| G. Dashboard | Figures per cycle and totals from the ledger; audit trail with integrity check; role-based admin screens | Operating expenses and financial reports not built yet |

## What the tests prove

`apps/api/test/e2e.test.ts` runs a complete cycle against a real PostgreSQL — 16 tests, run repeatedly without failure:

- A used or wrong one-time code is refused; weak PINs are refused; five wrong PINs lock sign-in.
- Under-18s are refused; one identity cannot open two accounts; identity numbers, PINs and session tokens are not stored in readable form.
- A cycle cannot be approved by its drafter, by one person, without evidence, or with escrow ₦1 short; nothing can be edited after approval.
- Ticket outcomes cannot be read from the database before reveal.
- Unverified, out-of-state, self-excluded and staff-register players cannot buy.
- Spending limits hold even when two purchases are sent at the same instant; the per-cycle cap holds.
- Four players racing for the last cards: every card is sold exactly once, late payers are refunded automatically, and the cycle closes itself at sell-out.
- Every revealed card verifies against the fingerprint published before sales; a different claimed outcome does not. Revealing repeatedly and simultaneously pays once.
- The draw refuses to run early, without two operators, or without the appointed auditor; it runs once; a third party re-running it from the published data gets the same winners.
- With unsold cards at the closing date, the draw still runs, over sold cards only.
- Winnings can go only to a bank account in the player's verified name, with the PIN; two simultaneous withdrawals of the same money: one succeeds. Large payouts wait for a different person; rejection returns the money.
- The ledger sums to zero, the dashboard agrees with it, and editing an audit record directly in the database is detected.

### Defects the tests found and that are now fixed

1. **Deadlocks under simultaneous payments.** Fixed by changing how rows and ledger accounts are locked; a transaction aborted by the database is now retried safely.
2. **False "audit trail broken" under load.** Audit numbers were assigned before the ordering lock. Fixed in `db/migrations/003_audit_chain_order.sql`; the number is now also covered by the hash.

## Player web app

`apps/web` — served by the API from the same address, so there is one thing to deploy and nothing is loaded from other sites.

| Screen | What the player can do |
|--------|------------------------|
| Home | See the cycle: price, cards left, odds, closing and draw dates, prizes, published fingerprint; switch cycle; try a free demo card |
| Sign up / sign in | Phone number, one-time code, 6-digit PIN |
| Verify | Identity number, age and location check, optional next of kin |
| Buy | Choose 1–20 cards, see spending against the limit, simulated payment, automatic refund message if cards sell out mid-payment |
| My cards | All cards in all cycles; scratch with a finger or "Reveal now"; "Reveal all" |
| Card | Result, "entered in the final draw", and a check **done on the player's own phone** that the result matches the fingerprint published before sales |
| Winnings | Balance, history, add bank account, withdraw with PIN, withdrawal status |
| Draw | Schedule and fairness steps before; winners (own cards highlighted) after; **re-run the whole draw on the phone** and see each check pass |
| Me | Profile, next of kin, spending limit, 7-day break, self-exclusion, sign out |

Safety and experience choices:

- **No framework and no third-party code** in the app (about 58 KB in total before compression). It loads fast on slow connections and there is no supply chain to audit. This replaces the Next.js choice in the Phase 1 plan; a framework can be added later if the team wants one.
- The session is kept in a cookie that page scripts cannot read, is never sent from another site, and state-changing requests need a header another site cannot add.
- The server sends a strict content-security policy: no inline script or style, nothing from other origins, no framing.
- The app never builds HTML from text, so data from the server cannot run as script.
- Every money action is safe to retry after a dropped connection: the same request key is reused, so nothing is charged or paid twice. Buttons disable while a request is in flight.
- `apps/web/test/verify.test.ts` proves the in-browser checker gives exactly the same answers as the game engine, and rejects altered results.

Checked in a real browser (headless Chromium, phone width, and again at 320 px): full journey from demo card through sign-up, verification, purchase, scratching, in-phone verification, winnings, withdrawal, limits, a real draw executed by three administrators, and in-phone draw verification — with no script errors and no sideways scrolling. This browser run is a manual check script, not yet part of the automated suite.

Not yet in the web app: offline shell/installation prompt (service worker), languages other than English, notifications, support.

### Try it locally

```bash
pnpm --filter @wiifarm/api seed:demo
```

```bash
pnpm --filter @wiifarm/api start
```

Both need `DATABASE_URL`, `MASTER_KEY` and `HASH_KEY`; over plain http on your own machine also set `COOKIE_SECURE=false`. Then open the address the server prints.

## Admin web app

`apps/admin` — served under `/admin`. Same construction as the player app: no framework, no third-party code, strict security headers. Its sign-in session is a separate 8-hour cookie that is not valid on the player side, and a player session is not valid here.

| Screen | What it does |
|--------|--------------|
| Sign-in | Simulation only: by email. The live service uses company single sign-on with a hardware key |
| Dashboard | Tickets sold and remaining, revenue, prizes awarded, outstanding liability against escrow cover, winnings owed, payouts in progress, ledger balance check, open alerts, all cycles |
| Prize cycles | List; create a draft (price ₦200–₦500, quantities, dates) |
| Cycle | Lifecycle strip; key figures; prize schedule; add prizes and merchandise items (draft only); evidence form with required escrow cover; approval checklist; generate tickets and publish fingerprint; open sales; published commitments; draw console; winning tickets |
| Approvals | Cycles awaiting approval and payouts awaiting a second person, with a count in the menu |
| Payouts | Queue of held payouts; approve or reject with a reason |
| Audit & compliance | Licence and certification status (real-money gate), alerts, staff exclusion register (add entry), audit trail with integrity status |

Buttons appear only for roles that may use them, but that is convenience: every rule is enforced by the server and the database, and refusals come back as plain-language messages (for example "the person who drafted a cycle cannot approve it").

Checked in a real browser with six administrators signing in turn: draft through the form; drafter refused when approving their own cycle; finance refused without evidence and with escrow ₦1 short; locked after approval; tickets generated and sales opened; a player bought; sign-off buttons absent before close; execute disabled with one sign-off; payout approver offered no draw buttons; auditor could countersign but not execute; draw executed once and the button disappeared; a ₦20,000 payout held, rejected (money returned), re-requested and approved by the payout approver while finance was offered no approve button; exclusion register entry added by compliance and hidden from the auditor; audit trail intact; no script errors; no sideways scrolling at phone width. As with the player app, this browser run is a manual check script, not yet in the automated suite.

Still missing from the admin app: reconciliation and financial reports, recording licences and certifications, managing administrators and roles (currently set up directly in the database), customer support views. In production it must be served from its own restricted address rather than alongside the player app.

## Merchandise

How a physical prize is protected from start to finish:

1. **It must exist first.** Fulfilment records goods when they arrive: item, supplier, purchase order, warehouse, purchase cost, landed cost and (for tracked items) serial numbers. Costs and serial numbers cannot be edited afterwards.
2. **It is set aside before approval.** Fulfilment — not the people drafting or approving — reserves stock to the cycle. The database refuses to approve a cycle unless every merchandise prize is covered by a reserved unit in the warehouse.
3. **It cannot be diverted.** Once the cycle is approved, a reserved unit cannot be released, moved to another cycle, re-costed or deleted, even with direct database access.
4. **The winner claims it** in the app: delivery (with address) or collection, confirmed with their PIN. A next of kin must be on file, and cannot be swapped while a claim is open. A match on the staff register puts the claim on hold for Compliance.
5. **Handover needs the winner's code.** When Fulfilment dispatches, the winner — and only the winner — is shown a six-digit code. Staff cannot see it. Handover is recorded only with that code and a photo reference; five wrong codes lock the handover and raise an alert.
6. **Everything is recorded:** which serial number went to which winner, when, by whom, with the warranty reference.
7. **Unclaimed prizes close** when the published 90-day window ends.

Stricter than the earlier decision: the plan allowed prizes that were "received or contractually secured". The system currently accepts only goods physically received. Allowing contractually secured goods would need an evidence-and-approval step; say if you want it.

Screens: the admin app has a Merchandise page (stock position and value, redemption queue with dispatch and handover, receiving stock, items, suppliers, warehouses, every unit with its costs) and the cycle page shows whether prizes are secured. The player app lists "My prizes" under Winnings, shows a banner on the home page when a prize is waiting, and leads a winner to the draw of the cycle they played.

Checked in real browsers with a player and several administrators: stock received through the form (refused without serial numbers for a tracked item); a player won, was told on the home page, added next of kin, claimed with an address and PIN; dispatch refused without a carrier; the code appeared on the player's phone and nowhere on the admin page; a wrong code was refused; the right code completed the handover; the player then saw "Received" with serial number and warranty. Finance could view but had no action forms; the payout approver could not open the page.

## Refunds and cancelled cycles

Both need two different people, and the database itself refuses anything else.

**Refunding one purchase** (buyer turned out to be ineligible, or the payment is disputed): Compliance finds the purchase by phone number and requests the refund with a reason and note; Finance approves or rejects it. On approval, in one transaction: the purchase's cards are cancelled and leave the final draw, any prize they won is forfeited (cash taken back out of the player's winnings), the price goes back to the original payment, and the order is marked refunded. If the prize had already been withdrawn, the player's account shows the amount owed, further withdrawals are blocked, and Compliance gets an alert to recover it. A refund cannot be approved while merchandise from that purchase is already being delivered. An order can only be refunded once.

**Cancelling a cycle** (regulator instruction, prize cannot be delivered, integrity problem): a cycle manager or Compliance requests it with a reason; someone else in Finance or Compliance approves or rejects it. Possible from approval up to the closing of sales — never after the draw. On approval, in one transaction: every paid purchase is refunded in full to its original payment, every card is cancelled, instant prizes already revealed stay with their winners (as the refund policy says), open refund requests are superseded, reserved merchandise returns to stock, and a Compliance alert is raised for reporting to the regulator. A payment that arrives after cancellation is refunded automatically.

Players see cancelled cards marked "Cancelled · price refunded", a "My purchases" list with each refund and its reason, and a plain notice on the home and draw pages of a cancelled cycle. Staff have a Refunds page, cancellation controls on the cycle page, and both kinds of request on the Approvals page.

**Fixed along the way:** a database rule made it impossible to cancel a card that had already been revealed, contradicting the ticket rules. Found by the new test; corrected in `db/migrations/005_voids_and_refunds.sql`.

Checked in real browsers: Compliance found a purchase by phone and requested a refund and was not offered the approve button; Finance saw the badge, approved from the Approvals page; the player saw three cancelled cards, the explanation and "Refunded — not eligible to buy". A cycle manager requested cancellation and was not offered approval; a payout approver was not offered it either; Compliance approved; the cycle page, the player's home page and draw page all showed the cancellation. No script errors, no sideways scrolling at phone width.

## Differences from the Phase 1 plan

| Plan said | Built | Why |
|-----------|-------|-----|
| NestJS | Fastify | Fewer third-party packages to trust; no build step |
| Next.js player app | Dependency-free web app served by the API | Smaller download for low-end phones; no third-party code to audit; one deployment |
| Argon2id for PINs | scrypt (built into Node.js) | Avoids a native add-on; parameters are stored with each hash so they can be raised or replaced |
| Separate database roles per service | One role | Needs the hosting decision; still required before Phase 3 |
| Reservation of specific cards during payment | Availability check, then assign on payment; refund if gone | Simpler and never strands a card; revisit if refunds at sell-out prove annoying |

## API summary

Player: `POST /v1/auth/otp`, `/auth/register`, `/auth/login`, `/auth/logout` · `GET /v1/me` · `POST /v1/me/verify` · `PUT /v1/me/next-of-kin`, `/me/limits` · `POST /v1/me/exclusion`, `/me/bank-accounts` · `GET /v1/cycles`, `/cycles/:id`, `/cycles/:id/draw` · `POST /v1/orders` · `POST /v1/simulated-gateway/pay` · `GET /v1/tickets` · `POST /v1/tickets/:id/reveal` · `GET /v1/wallet` · `POST /v1/payouts`

Admin: `POST /v1/admin/dev-login` (simulation only) · `GET /v1/admin/dashboard`, `/admin/audit` · `POST /v1/admin/exclusion-register` · `POST /v1/admin/cycles` and `/cycles/:id/prize-tiers`, `/submit`, `/approve`, `/commit`, `/open`, `/draw/sign`, `/draw/execute` · `PUT /v1/admin/cycles/:id/evidence` · `GET /v1/admin/payouts/pending` · `POST /v1/admin/payouts/:id/decision`

## Still to do in Phase 2

1. ~~Player web app connected to the API~~ — done (see above). Remaining: offline shell, more languages, automated browser tests in CI.
2. ~~Admin web app connected to the API~~ — done for cycles, approvals, draw, payouts, audit and compliance (see above).
3. **Public verifier page**: check a card, re-run a draw.
4. ~~Merchandise module~~ — done (see above). Remaining: photo and document uploads, carrier tracking, next-of-kin claims.
5. ~~Voiding a cycle with refunds; manual refunds with two-person approval~~ — done (see above).
6. Publishing the full ticket list when a cycle is archived; settling and archiving steps.
7. Notifications (SMS/WhatsApp/in-app) and support tickets.
8. Reconciliation report and financial reports; operating-expense records.
9. Unclaimed-prize reminders, expiry and the next-of-kin claim process.
10. Tier 2 checks (liveness) before major-prize claims; fraud rules beyond the staff register.

## Before any real money (Phase 3 and later — unchanged)

Real key service, real public beacon or regulator-approved randomness, real payment/identity/SMS providers, separate database roles, admin single sign-on with hardware keys, shared rate limiting, penetration test, game certification, and the Niger State licence.
