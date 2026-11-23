# Phase 2 — minimum viable platform (simulated money only)

Status as of 12 November 2026: **backend, player web app and admin web app complete for the core journey, including merchandise, refunds, finance, close-out and notifications, and tested end to end.**

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

`apps/api/test/e2e.test.ts` runs a complete cycle against a real PostgreSQL — 25 tests, run repeatedly without failure, including with the processor saturated:

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
3. **Buyers wrongly refunded in a sell-out rush.** When more people paid at the same instant than there were cards left, two payments could each lock part of the remaining cards, each come up short, and both be refunded — leaving cards unsold. No money was lost (refunds were full), but buyers lost purchases they should have had. It showed up as an occasional failure of the whole suite; a dedicated test (six rushes of ten buyers for thirty cards) reproduced it. Fixed by assigning one cycle's cards one payment at a time.
4. **Crash on a lost database connection.** If the database closed an idle connection (restart, maintenance), the server process would stop. Now the broken connection is discarded and a new one is opened.

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

Both need `WR_SIMULATION=1`, `DATABASE_URL`, `MASTER_KEY` and `HASH_KEY`; over plain http on your own machine also set `COOKIE_SECURE=false`. The server only listens on this machine unless `WR_ALLOW_PUBLIC_SIMULATION=1` is set. Then open the address the server prints.

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

Still missing from the admin app: nothing planned for Phase 2. In production it must be served from its own restricted address rather than alongside the player app.

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

## Finance: reconciliation, expenses and reports

New **Finance** page in the admin app (Finance can act; auditors and Compliance can view).

**Daily reconciliation.** For each day (Nigerian time), money through the payment provider is counted twice, independently: from the payment, refund and payout records, and from the ledger. Finance can also enter the totals from the provider's own statement. Any difference marks the day as a mismatch and raises one Compliance alert. Yesterday is reconciled automatically every hour until signed off; days with money movement that nobody has reconciled are listed. Finance signs each day off; a mismatched day can only be signed off with a written explanation; a signed-off day can never be re-run, changed or deleted. The dashboard shows the reconciliation status.

*Limit to know:* in simulation there is no real provider statement, so the check is records against ledger. It still catches the important failure — money recorded in one place and not the other — as the test shows by slipping a fake "sale" into the ledger: the books still balanced, but reconciliation flagged it.

**Operating expenses.** Finance records expenses by category, date, payee, invoice reference, and either a cycle or company overhead. Each is posted to the ledger. Entries cannot be edited or deleted; a mistake is corrected by a reversal, which must match the original and cannot itself be reversed. Both stay on record.

**Results by cycle.** For every cycle: cards sold, sales, refunds, net revenue, instant and draw cash prizes (from the ledger), forfeited prizes, merchandise at landed cost (from the stock records), expenses, contribution, and prizes as a share of revenue. Merchandise is counted in full from approval, so a cycle still on sale shows a loss until its cards are sold; the share is shown only once sales have closed.

**Period summary.** For any date range: collected, refunded, cash prizes awarded, paid out to winners, expenses by category, result before merchandise, and how many days were signed off or mismatched.

**Spreadsheets.** Cycle results and expenses download as CSV for Excel. Cells that would be read as formulas (for example a cycle or payee name beginning with "=") are neutralised, so opening a downloaded file cannot run anything.

*Not included yet:* payment provider fees (recorded as expenses until a real provider is connected), tax, and escrow account statements.

## Closing out a cycle

After the draw, a cycle is closed out once four checks pass, shown on the cycle page:

1. the final draw has taken place;
2. every prize is claimed, delivered or expired (claims past their 90-day window are closed as expired at this point);
3. every day on which the cycle's money moved is reconciled and signed off;
4. no Compliance alert about the cycle or its prize claims is open.

A cycle manager or Compliance requests the close-out; someone in Finance — a different person — confirms it. The checks run again at confirmation. Then, in one transaction, **every card's outcome and salt is published** — sold, unsold and cancelled — merchandise held for prizes that lapsed unclaimed goes back to stock, and the cycle is archived. The database refuses to archive a cycle without a second person or without every card published, and the published list can never be changed.

The published list is public. On the Draw page, players can tap **Check the whole cycle**: the phone downloads every card, rebuilds the fingerprint published before sales opened, counts every instant prize against the advertised table, and says how many prizes were on cards nobody bought. This completes the promise in the brief that outcomes are fixed, independently verifiable and that every advertised prize existed.

A cancelled (void) cycle is not archived and its card list is not published; that could be added if the regulator wants it.

## Notifications

Messages are written into an outbox **in the same database transaction as the event** they report, each with a unique key. So a message exists exactly when its event does — never for something that was rolled back, never twice for a retry. In-app messages appear at once; text messages are sent by a background worker.

| Event | In the app | Text message |
|-------|-----------|--------------|
| Final-draw win | ✓ | ✓ |
| Draw has happened (did not win) | ✓ | — (no texts to people who did not win) |
| Withdrawal sent / held for checking / rejected | ✓ | sent and rejected |
| Prize on its way or ready to collect | ✓ | ✓ (the handover code stays in the app) |
| Prize handed over; claim period ended | ✓ | — |
| Purchase refunded; cycle cancelled | ✓ | ✓ |
| PIN changed; bank account added | ✓ | ✓ at once — warns the real owner of a possible account takeover |
| Unclaimed prize at 7, 30, 60 and 80 days | ✓ | ✓ (only the latest due, each once) |

- **Daytime only for texts that can wait:** sent between 08:00 and 20:00 Nigerian time; security and money texts go at once.
- **Retries:** a provider failure is retried after 1, 2, 4 and 8 minutes, then marked failed for Support to follow up.
- **Nothing secret in a text:** no PIN, no handover code; one-time sign-in codes go straight to the provider and are stored nowhere. Every text ends "We will never ask for your PIN." Texts use only standard SMS characters ("N" for naira), which keeps each message to one part and the cost down.
- **Screens:** the player app has a message bell with an unread count and an inbox whose messages open the right screen; the admin app's Audit & compliance page shows every text with its status for Support and Compliance.
- *Not yet:* WhatsApp, languages other than English, and a real SMS provider (the simulated one keeps messages in memory).

## Staff access, licences and certifications

New **Access & licences** page in the admin app.

**Staff access** (security administrators act; Compliance and auditors can see who has what):
- A security administrator creates a staff account. It starts with **no roles**.
- Giving or removing a role, or re-enabling an account, is a request that **a different security administrator** approves. Nobody can request or approve a change to their own access — the database refuses it too.
- Roles that would let one person both do and approve the same thing (finance with payout approval; auditor or security administrator with anything else) are refused with a plain explanation.
- **Disabling** an account needs one person and takes effect at once: every session ends immediately. This is for a lost laptop, a leaver or a suspected compromise.
- There must always be **at least two security administrators**, or the two-person rule could no longer work; the system refuses any change that would break this.
- Every request and decision is kept, with reasons.

*Bootstrap:* the first two security administrators are created once, directly in the database, when an environment is set up (the demo seed does this). Everything after that goes through the page.

**Licences and certifications** (Compliance records; Compliance or Finance verifies; auditors can see):
- Compliance records each licence (authority, number, dates, document) and each certificate (component, exact version, lab, dates).
- **Someone else** checks the original document and verifies it. Only verified, in-date, unrevoked records count towards the real-money gate — and the database now enforces exactly that, so a record that is merely typed in cannot open real-money sales.
- Records cannot be edited or deleted. Revoking takes effect at once, needs a reason and raises a Compliance alert.
- The page shows whether the Niger State licence is in force and whether the exact engine version is certified. Real-money sales stay unavailable in Phase 2 regardless, because no payment provider is connected.

## Browser tests in the automated suite

`apps/browser-tests` — the manual browser checks used while building are now permanent tests that run on every change, locally (`pnpm test:browser`) and in GitHub's automated checks. Each test file starts its own fresh database, the real API and both web apps on a random port, seeds the demo data, and drives real Chromium. Every page fails the test on any script error, any server error, or sideways scrolling.

| File | What it proves |
|------|----------------|
| `player.test.ts` | Demo card pays nothing; sign-up (weak PIN refused), verification, purchase, scratching with a finger, the phone's check of each card, revisiting a card shows the same result, winnings equal the sum of wins, withdrawal needs the right PIN, limits (lower now, raise later, buying stops), the security message in the inbox; the session cookie is unreadable by page scripts, forged cross-site changes are refused, the app never turns text into HTML, sign-out ends the session; every player screen fits a 320 px phone |
| `lifecycle.test.ts` | A cycle from draft to archive: drafter cannot approve, escrow ₦1 short refused, locked after approval; the draw needs two operators and the appointed auditor, the auditor cannot execute, it runs once; the player is told, verifies the draw on the phone, adds next of kin, claims with PIN; fulfilment dispatches, staff never see the handover code, a wrong code is refused; Finance reconciles and signs off; close-out by two people publishes every card; the player checks the whole cycle; every admin screen fits a phone |
| `operations.test.ts` | Refund requested by Compliance and approved by Finance, seen by the player; cycle cancellation requested by a manager, approved by Compliance, seen by players; reconciliation against a statement, sign-off with an explanation, expenses recorded and reversed, spreadsheet with formulas neutralised; auditors see but cannot act; staff access granted by two security administrators, disabling immediate; a licence recorded by one person and verified by another |

The whole browser suite takes about a minute and passed four runs in a row, one with the processor saturated.

**Found by turning the checks into tests:** the player app's message bell only refreshed when the app was first opened, so a player who had the app open during the draw saw no badge until they reloaded. It now refreshes on every screen change.

## Next-of-kin claims

When a winner has died or cannot be reached, the next of kin they recorded may receive the prizes still waiting to be claimed and any winnings not yet withdrawn — never automatically:

1. **Only the recorded next of kin.** The claimant needs their own verified account, and their phone number and verified name must match the next of kin the winner recorded. (A winner cannot change that record while a prize claim is open.) People on the exclusion register cannot be claimants.
2. **Compliance opens a case** with the reason (died / cannot be reached), the documents seen and notes.
3. **The winner is told at once**, by text and in the app.
4. **Seven-day wait.** Nothing can be decided before then. If the winner signs in during the wait, the case cannot be approved — they can be reached.
5. **A different person decides** (Compliance or Finance), with a reason if rejecting.
6. **On approval**, in one transaction: the waiting prizes move to the claimant, marked as passed on, with at least 30 days to complete each claim; winnings not withdrawn move through the ledger; for a winner who has died, their account is closed to sign-in. The claimant is told by text and in the app.
7. **Nothing lapses meanwhile.** While a case is open the database will not let the winner's prizes expire.
8. Decided cases cannot be changed or deleted, and every step is in the audit trail.

Staff use the new **Next of kin** page (look up the winner, open a case, decide). The claimant sees "Passed to you as next of kin" on the prize.

## Customer support

**Players** have a *Help and support* screen (from the Me page): they choose a topic, describe the problem, follow the conversation and reply. When support answers, a text says a reply is waiting — the reply itself stays in the app. The screen reminds them that support never asks for a PIN or a code. Complaints go to Compliance automatically. At most five open requests per player.

**Support staff** have a *Support* page:
- a queue of requests (needs reply / waiting for player / closed; anything passed to Compliance is marked), with reply, reply-and-close, close and *pass to Compliance*;
- a player lookup showing what is needed to help — account state, limits and breaks, winnings, cards, purchases, prizes, withdrawals, bank accounts (bank code and whether the name matches only), texts sent and past requests. Phone numbers are masked; identity numbers, account numbers and unrevealed outcomes are never shown. **Every lookup is written to the audit trail.**
- **Lock account** for a suspected takeover: one person, immediate, signs the player out everywhere and texts them. A locked account cannot be reopened by resetting the PIN with a text code, so a stolen SIM is not enough. **Unlocking needs a Compliance officer who is not the person who locked it.** When the real owner signs in with the right PIN they are told the account is locked; a stranger without the PIN learns nothing.

**Deliberately not possible for support:** resetting a PIN, changing a phone number, raising a limit or moving money — what someone pretending to be the player would ask for. Conversations are a permanent record.

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
4. ~~Merchandise module~~ — done (see above). Remaining: photo and document uploads, carrier tracking.
5. ~~Voiding a cycle with refunds; manual refunds with two-person approval~~ — done (see above).
6. ~~Publishing the full ticket list when a cycle is archived; settling and archiving steps~~ — done (see above).
7. ~~Notifications (SMS/in-app); support requests and tools~~ — done (see above). Remaining: WhatsApp.
8. ~~Reconciliation report and financial reports; operating-expense records~~ — done (see above).
9. ~~Unclaimed-prize reminders and expiry; the next-of-kin claim process~~ — done.
10. Tier 2 checks (liveness) before major-prize claims; fraud rules beyond the staff register.

## Before any real money (Phase 3 and later — unchanged)

Real key service, real public beacon or regulator-approved randomness, real payment/identity/SMS providers, separate database roles, admin single sign-on with hardware keys, shared rate limiting, penetration test, game certification, and the Niger State licence.
