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
| `hausa.test.ts` | Signing up in Hausa sets the account to Hausa, switching back sets it to English, and a new phone takes the account's language on sign-in. Every player screen in Hausa with nothing left in English (other than names from the server); the switch applies to the tab bar and is remembered after a reload; server error messages appear in Hausa; switching back restores English. `lifecycle.test.ts` also repeats its draw, verification and prize screens in Hausa |
| `installable.test.ts` | Install icons and manifest; nothing personal kept on the phone; offline screen in English and Hausa; recovery when back online; the staff app never served offline; install prompt and *Not now* |
| `wallet.test.ts` | An invite link fills in the code at sign-up; the friend's purchase pays the inviter 2.5%; the wallet buys cards only with the right PIN |
| `engage.test.ts` | Invite screen and share links carry the link, code and "18+ only"; live activity and a ticking countdown; a true sales milestone shown once; achievements; link previews; pop-ups appear only after a second person approves, once, in Hausa for Hausa readers; prize pictures accepted before sales open, refused after, and fake image files refused |
| `accept.test.ts` | A winning card scratched with a finger shows the prize but pays nothing until Accept; Accept adds it to the wallet once; returning to the card shows it accepted |
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

## Hausa

The player app can be used in **English or Hausa**. A switch on the home screen and the Me page changes the language at once, including the tab bar and the simulation banner, and the choice is remembered on the phone. A phone already set to Hausa starts in Hausa.

- **What is translated:** every screen, button, form label, hint, confirmation question and toast, and every error message the server can send a player (wrong PIN, spending limit reached, sold out, and so on). Counts follow Hausa word order ("kati 10", not "10 cards"); dates use Hausa month names and the 24-hour clock ("30 Nuwamba 2026, 10:17").
- **Texts and in-app messages** are written in the player's language too: sign-up codes, wins, draw results, prize dispatch and delivery, claim reminders and expiry, withdrawals, refunds, cancelled cycles, next-of-kin cases, support replies and security alerts. The language is stored on the player's account (`users.language`), set when they sign up and whenever they use the switch, and every change is in the audit trail. A message is written in the language the player reads when the event happens. On a new phone where nothing has been chosen yet, the app takes the account's language as soon as they sign in.
- **Texts in Hausa write ɓ ɗ ƙ ƴ as b d k y**, as is usual in Hausa text messages. Those letters are not in the standard SMS character set, and one of them would switch the whole text to a format that holds less than half as much, at higher cost. The app itself shows the proper letters. A test checks that Hausa texts stay in the standard set.
- **What stays as it is:** prize names, cycle names and people's names, which come from staff or players; bank names.
- **How nothing is missed:** all text passes through one function on its way to the screen. In Hausa mode it records any English it could not translate, and the browser tests visit every player screen in Hausa — sign-up, verification, buying, scratching, the card check, winnings and bank account, limits and breaks, next of kin, messages, support, the draw results, both phone checks and a delivered prize — and fail if anything was recorded.

> **The Hausa needs review by a fluent speaker, ideally from Niger State, before launch.** It was written by the development team. Pay particular attention to anything about money, prizes, spending limits and self-exclusion, where an awkward phrase could mislead. The whole dictionary is in one file, `apps/web/public/js/i18n.js`, with the English beside each Hausa phrase, so a reviewer can work through it without touching the code.

**Found while doing this:** a wrong PIN on the sign-in screen showed "Please sign in again" rather than "Wrong phone number or PIN", because the app treated every refusal of that kind as an expired session. It now does that only when the player was already signed in. A test covers it.

## Installable app and offline screen

The player app can be **added to the home screen** and opens like an app, full screen, with the WiiFarm icon.
- **Android:** when Chrome allows installing, an *Add to home screen* card appears on the home screen (it can be put off with *Not now*, which is remembered) and stays available on the Me page.
- **iPhone:** the same card explains the two taps in Safari (Share, then Add to Home Screen). Those two words are left in English in the Hausa version because that is what the iPhone shows.

**With no connection** the app still opens and shows a plain *You are offline* screen (in English or Hausa) with the tab bar, instead of the browser's error page, and reassures the player that what they bought or won is safe. When the connection returns the screen updates by itself, still signed in.

**What is kept on the phone, and what is not.** Only the app's own public files — the page, styles, scripts, language file and icons. Nothing from the API is ever stored, so no balances, card results, messages or personal details stay on the phone, and a shared or lost phone gives nothing away beyond what any visitor could download. The staff app is never served from the phone's copy. The app always fetches its files fresh when online, so a player never runs an outdated version after an update.

Tested in `installable.test.ts`: the icons are real PNGs of the stated sizes (including one shaped for Android's round masks); the phone's copy contains no `/v1/` or staff-app entries after a signed-in session; offline opening, the offline screen in both languages, and automatic recovery; the install prompt offered once per request; *Not now* remembered.

## First wave: season economics, referrals, wallet and engagement

Built from management's instructions of 23 November 2026.

### Seasons and the prize budget
- **Rewards are seasonal** (each season is a cycle, as built). **The lottery ("loto") is a separate, continuous product and is not part of this system**: it would need its own licence, rules and certification, and nothing here mixes the two.
- **First wave: 400,000 cards at ₦500**, ₦200,000,000 at sell-out. `pnpm --filter @wiifarm/api seed:demo --first-wave` creates it in the simulation; the everyday demo uses a scaled-down copy.
- **A season runs 90 days**, with the final draw at its end.
- **Prize money is 50% of full sell-out sales (₦100,000,000), and 5% of that (₦5,000,000) is instant cash**; the rest (₦95,000,000) is for the final draw. This is company policy, set in configuration (`WR_PRIZE_SHARE_BP`, `WR_INSTANT_SHARE_BP`) and fixed on each season when it is drafted. Approval is refused if the instant prizes or the final-draw prizes exceed their share; merchandise counts at its advertised value. The admin cycle page shows the budget as it is filled.
- **The ₦5,000,000 of instant cash (recommended split):**

| Prize | Share of the ₦5,000,000 | Winning cards | Chance per card |
|---|---|---|---|
| ₦10,000 | 8% (₦400,000) | 40 | 1 in 10,000 |
| ₦5,000 | 10% (₦500,000) | 100 | 1 in 4,000 |
| ₦2,500 | 14% (₦700,000) | 280 | 1 in 1,429 |
| ₦1,000 | 28% (₦1,400,000) | 1,400 | 1 in 286 |
| ₦500 | 40% (₦2,000,000) | 4,000 | 1 in 100 |
| **All** | **100%** | **5,820** | **about 1 in 69** |

  Most of the money goes to ₦500 and ₦1,000 prizes so that wins are as frequent as the budget allows (₦500 gives the player their card's price back), while 140 prizes of ₦5,000–₦10,000 give people something to talk about.
- **Instant cash is released in levels as cards sell.** The first wave is sold in 4 levels of 100,000 cards, one after another; each level holds exactly a quarter of every instant prize (₦1,250,000: 10 × ₦10,000, 25 × ₦5,000, 70 × ₦2,500, 350 × ₦1,000 and 1,000 × ₦500), shuffled within the level. Level 2 goes on sale when level 1 has sold out, and so on. **Players are not shown the levels**: they see their result and that every card, win or lose, qualifies for the final prize draw at the end of the season. Staff see the level on sale on the admin cycle page. If sales stop early, the prizes in unsold levels are never paid, so the instant-cash cost follows sales exactly. The levels are fixed at approval and are part of the published prize-table fingerprint; the certified engine generates each level separately.
- **Final draw placeholder:** **the single car**, then an electric motorcycle, cash, freezers and rice — about ₦33,000,000 of the ₦95,000,000 final-draw budget. **The car's value (₦30,000,000 in the demo) and the rest of the list are placeholders for management's real list and pictures.** Every card enters the final draw, win or lose — instant cash winners included.
- **If not every card sells, the advertised final-draw prizes are still given**, so prizes become a larger share of actual sales. This is the operator's risk and is stated on the admin page.

### Every payment gets its cards: no refunds for "sold out"
- **When a player starts paying, their cards are held for them for 15 minutes** (the payment provider's own payment window must be shorter). Held cards are not on sale to anyone else, so a completed payment always gets exactly the cards it was for. If too few cards are left, the player is told before paying anything.
- Holds whose payment never arrives are released every minute and go back on sale.
- **Last resort:** if a payment somehow arrives after its hold was released and no cards are left (or after a season was cancelled), the money is never kept without a card and never sent back through the bank: it goes straight into the player's wallet, to buy cards or withdraw, and the player is told by text and in the app.
- **All sales are final**, as the buy screen says. The only other ways money can go back are the two legal cases, each needing two staff: a purchase by someone who was not allowed to play (a minor, an excluded person, staff, fraud), and a whole season cancelled.

### Buying: up to 10 cards a day
- Each person can buy **at most 10 cards per Nigerian calendar day** (`WR_CARDS_PER_DAY`), in any number of purchases. At ₦500 that is exactly the default ₦5,000 daily spending limit. The buy screen shows "cards today", offers 1, 3, 5 or 10, and explains that each card is one entry in the final draw.
- **Speed at scale (measured):** 400,000 cards generated and committed in about 20 seconds; about 73 purchases of 10 cards per second (a full sell-out at maximum rush in about 9 minutes); the final draw over 400,000 entries in about 13 seconds. If nobody scratched their cards, revealing all 400,000 takes about 5 minutes, so it now runs in the background as soon as sales close rather than when the draw is started.

### Invite codes (no earnings — replaced by the SRS affiliate model)
- **Every player still has an invite code from sign-up** to share (`/r/ABC2345` links fill it in at sign-up). Inviting is counted (friends joined, friends who played) but **earns nothing**: the board adopted the SRS affiliate model, so marketing fees are for authorised affiliates only (below).
- Who invited an account is still fixed when it is opened. Commissions paid under the earlier model remain in the records and are still taken back if their purchase is refunded.

### Digital cards: scratch, then Accept
- Every card is digital. The player scratches it by swiping a finger across it on their phone (or taps *Reveal now*); the result underneath was fixed before sale and the phone checks it against the published fingerprint.
- A winning card shows **Accept ₦…**. Tapping it moves the prize into the wallet, once only (repeat taps, retries and two phones at once still pay once; the database refuses a second acceptance or an acceptance on a losing card). *My cards* has **Accept all winnings**, and the home screen reminds the player of winnings waiting.
- **No prize is lost by not tapping.** Prizes still waiting are accepted for the player when the season closes, when it is cancelled (revealed prizes are honoured), and for cards revealed automatically after close. A refunded purchase forfeits its unaccepted prizes, as it forfeits accepted ones.

### The wallet
- One wallet per player holds **winnings** (net of any statutory deduction), in the double-entry ledger. It can be **withdrawn from ₦500** to a bank account in the player's own verified name, with the PIN (as before), **or spent on cards**.
- Paying from the wallet asks for the PIN again, and is settled in one database transaction while the player's account is locked against other spending, so the same money cannot be spent or withdrawn twice. Wallet purchases count towards spending limits and the daily card limit like any other, and refunds go back to the wallet.
- Daily reconciliation compares money through the payment provider, so wallet purchases and wallet refunds (which never pass through it) are kept out of that check and reported separately as wallet sales.

### Sharing and engagement
Built in the style of shopping apps such as Temu — invites, sharing, live activity, countdowns, pop-ups and badges — **but only with true information, because this is gambling**: no invented countdowns or "only 3 left" messages, no rewards for spending more, and nothing shown to people who are taking a break.
- **Invite friends** screen: the code, the link, the phone's own share sheet, WhatsApp, Facebook, X and Telegram buttons, copy link, and counts of friends joined and who played. Every message shared says "18+ only. Play responsibly."
- **Share a win** after an instant win, with the invite code.
- **Link previews**: a title, description and picture when the link is pasted into WhatsApp or Facebook. Set `WR_PUBLIC_URL` to the live https address so the picture's link is absolute.
- **Home screen**: a live countdown to the real closing time (then to the draw), "cards sold in the last hour", and the latest instant wins (amount and time only, never who won).
- **Confetti** on an instant win (not for people whose phones ask for less motion).
- **Sales milestones**: at 25%, 50%, 75% and 90% sold, a pop-up once per phone with the true number of cards left and the draw date.
- **Achievements** on the Me page: verified, first card, first scratch, first instant win, shared, a friend joined — none for spending.
- **Flash pop-ups** (admin *Pop-ups* page): written by a cycle manager or Compliance, in English and optionally Hausa, with a start and end time and an optional button to a screen. **They appear only after a Compliance officer who did not write them approves them**; approved text cannot be edited, only withdrawn at once.

### Prize pictures
- Final-draw prizes can have a picture (PNG, JPEG or WebP, up to 1 MB), uploaded on the admin cycle page **until sales open; after that the database refuses changes**, because the pictures are part of what players were shown. Files are checked by their contents, not their names; SVG is refused because it can carry script. Players see the picture on the home screen, and the emoji stands in until one is uploaded.

### For management to confirm
1. The real final-draw prize list, the car's model and value, and pictures.
2. The instant prize split (the recommendation above, or another that fits the ₦5,000,000).
3. That 2.5% referral commission has no time limit (built: it lasts as long as the friend plays), and whether there should be a ceiling per referrer.
4. Advertising and promotion rules from the Niger State regulator, which may restrict social-media promotion of gambling and require age-gating; the share messages already say "18+ only".

## SRS (WRL/SRS/2026/001): inaugural campaign and compliance basics

### Item 1 — the inaugural campaign template and scale
- **Template:** `pnpm --filter @wiifarm/api seed:demo --inaugural` creates *WRL-2027-001 Inaugural Rewards Campaign* exactly as SRS section 2 sets it out: 2,686,000 cards at ₦500 (₦1,343,000,000 at sell-out), 90 days, ₦20,000,000 of instant cash (10,000 × ₦500, 5,000 × ₦1,000, 2,500 × ₦2,000, 800 × ₦5,000, 100 × ₦10,000 — 18,400 winning cards, 1 in 146), and the final-draw list (Chinese SUV, household appliances, NaijaSweetRice 50/25/5/1 kg, VitaActive, VitaForce — 29,541 prizes). Released in 4 levels of 671,500 cards. The admin form's defaults are the same.
- **Open for the board:** the listed prizes total **₦591.5m, not the ₦671.5m stated** (the appliances are ₦20m "TBD"); and the appliance quantities and vehicle specification. The template uses 40 appliances of ₦500,000 as a placeholder.
- **Prize budget rule:** instant cash is capped at its share (5% of the prize money by policy; the SRS uses about 3%), and all prizes together at the prize money (50% of full sell-out sales). Whatever instant cash does not use is available to the final draw.
- **Scale (measured):** the inaugural campaign is generated and committed in about 2 minutes 40 seconds with a peak of 419 MB of memory (it was 4.3 GB before this change, and failed outright before the fix of 25 November). Cards are made and stored a chunk at a time; serial numbers are unique by construction; the card commitment tree is held in one contiguous buffer (a new engine class, `PackedMerkleTree`, proven to give exactly the same roots and proofs). "Cards left" is a lookup kept by the database itself (2 ms instead of 0.8 s), and a test checks it always matches the cards. **SRS capacity target met:** a campaign of 10,000,000 cards was generated and committed in 13 minutes (on a shared test machine) with a peak of 921 MB of memory; it takes 3.9 GB of database.

### Item 2 — compliance basics
- **Privacy and consent (REG-008):** opening an account requires accepting the privacy policy (its version is recorded); news and offers by text are optional and can be switched on or off on the Me page. Every choice is kept permanently. The privacy policy page is a draft summary for legal to replace.
- **Versioned game rules (REG-007, WEB-012):** a campaign's approved rules text is stored and published (it cannot change after approval, and must match its published fingerprint). Before their first purchase in a campaign, players tick that they have read and accept the rules; the exact version is recorded. The *Game rules and odds* page shows the rules and the chances: each instant prize's chance per card, the chance of any instant prize, the final-draw prizes, and the final-draw chance at full sales (each card can win at most one final-draw prize).
- **Play summary (SRS section 7):** the Me page shows what the player has spent, won in cash, their net position, and their cards and final-draw entries.
- **No repeat-purchase prompts (SRS section 10):** the "Buy more cards" button no longer appears after scratching.

## SRS affiliates and statutory deductions on winnings

### Affiliates (SRS section 13)
- **Separate application** on the player app's *Become an affiliate* page (linked from *Invite friends*): it needs the **liveness check** (tier 2), a **bank account in the applicant's own verified name** (where fees are paid), contact details, where they will promote, the **compliance training** (shown in the app; acknowledged) and the **affiliate agreement** (version recorded; the text is a draft for legal). Territory is the applicant's verified state, with an optional area. People on the staff and exclusion register cannot apply.
- **Compliance approves or rejects**, and can **suspend, reinstate or end** an approval, with a reason; every change is kept permanently (history table and audit log) and the affiliate is told. Rejected or ended affiliates cannot be reinstated.
- **Attribution codes**: on approval the affiliate gets a unique 8-character code (`/r/CODE` links work as for invites; a player's code has 7 characters, so the two can never be confused). A player who opens an account with it is attributed to that affiliate **for good** (the database refuses changes). Codes of suspended or ended affiliates are refused at sign-up.
- **Fees are off until legally approved** (SRS go-live checklist: *affiliate remuneration disabled without approval*). Switching fees on, or changing the rate (0%–5%; the SRS proposes 2.5%–5%), needs **two people** from Compliance or Finance and **the legal approval's reference**. While fees are off, each attributed purchase is still recorded with a fee of 0, so the reports are complete.
- **What earns a fee**: purchases by the players the affiliate brought, in the affiliate's territory, while the affiliate is approved. **No downlines and no recruitment bonuses** — players brought in by an affiliate's players earn the affiliate nothing. Fees come from the operator's share (`AFFILIATE_EXPENSE` per campaign), are owed to the affiliate (`AFFILIATE_PAYABLE`, not a player wallet), and are taken back if the purchase is refunded (Compliance is alerted if they were already paid).
- **Settlements**: Finance prepares a settlement of an affiliate's unpaid fees; a payout approver (a different person) approves it and it is paid to the affiliate's verified bank account (simulated, `SIMAFF-…` reference). Suspended affiliates are not settled until the review ends.
- **The affiliate's page**: reference, status, territory, code and share links, sign-ups, players who bought, their purchases, fees to be paid and paid, and statements — never who the players are.
- **Admin app → Affiliates**: applications with the checks (liveness, bank name match, agreement version), decisions, the fee programme switch with its pending request, unsettled fees and settlements. The dashboard shows fees owed and applications to review. Sign-up surges on an affiliate code (200 in 24 hours) alert Compliance.
- **Approved marketing materials (AFF-005, AFF-011).** The only texts and pictures affiliates may use, per channel (WhatsApp, text message, social media, print, radio), in English and optionally Hausa, with an optional picture (PNG/JPEG/WebP, checked, ≤1 MB). Every text must say "18+". A cycle manager or Compliance officer writes a version; **another Compliance officer approves it**. Approved versions are **never edited** (the database refuses): a correction is a new version, the old one stays in use until the new one is approved and is then retired; any Compliance officer can withdraw a text at once. Each version keeps a fingerprint, who wrote it and who approved it. On the affiliate's page, `{link}` in a text becomes the affiliate's own link, with copy and WhatsApp buttons; with no approved materials the page says to share only the link.
- **Complaints and investigations (AFF-009).** Players report a promoter from the Help page (what happened, the code if they know it, details; at most 5 reports a day). Staff (Compliance or Support) can record one too. A Compliance officer **who did not report it** investigates (linking it to the affiliate if the code was not known) and concludes with findings and an outcome: no action, a formal warning (the affiliate is told), suspension or ending the agreement — the suspension or ending happens **in the same transaction** as the conclusion. Concluded complaints are final. The reporter is told it was looked into, without details.
- *Not yet:* training records beyond the acknowledgement at application, and a separate log-in for affiliates who are not players (today an affiliate uses their verified player account).

### Statutory deductions on winnings (SRS PAY-009)
- **A configurable rate** (`WR_WINNINGS_TAX_BP`, basis points, up to 50%) is **fixed on each campaign when it is created**, cannot change once approved (the database refuses), and is **published** on the campaign's *Game rules and odds* page.
- **The rate is 0% until legal and finance confirm it.** The admin dashboard shows a warning for a live campaign at 0%, and so does the deductions report.
- **Every cash award** (instant and final-draw cash) records its gross amount, rate, deduction and net in a permanent table. The winner's wallet receives the net; the deduction is held for the tax authority (`STATUTORY_DEDUCTIONS_PAYABLE`). The prize cost of the campaign is the full prize. A forfeited prize gives back both parts.
- The winner sees it when they scratch: "₦50 statutory deduction (10%) · ₦450 to your wallet". Accepting adds the net.
- **Reports**: Finance → *Statutory deductions on winnings* (per day and campaign: awards, gross, withheld, net, and the amount held now), `GET /v1/admin/reports/deductions`; campaign results and the spreadsheet show the deductions and affiliate fees as their own columns.
- *Not yet:* recording remittances to the authority, and deductions on merchandise prizes (whether they apply is for legal to confirm).

## Liveness and fraud rules
- **Liveness check before anything large.** Claiming a prize worth ₦100,000 or more (merchandise at its advertised value: the car, motorcycles) and withdrawing ₦100,000 or more need a liveness check: a short live selfie matched to the photo held for the player's identity number (simulated here; the identity provider does it in the live service). It is done once and raises the player to tier 2. A stolen phone and PIN are then not enough to take a major prize. The app takes the player to the check and back to what they were doing. Threshold: `WR_MAJOR_PRIZE_KOBO`.
- **Fraud rules (alerts to Compliance):**
  - *Same bank account on two players* — suggests one person behind several accounts (for example to farm referral earnings). Critical alert, so that player's withdrawals wait for a person to review.
  - *Referral surge* — 20 or more sign-ups with one invite code in 24 hours. Warning alert, once a day per code, to look before the earnings are withdrawn.
  - Existing rules still apply: one account per identity number, payouts only to the player's own verified name, staff and exclusion register checks, PIN for every withdrawal.

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

1. ~~Player web app connected to the API~~ — done (see above). Hausa (screens, texts and messages), installable app with an offline screen, and automated browser tests in CI done.
2. ~~Admin web app connected to the API~~ — done for cycles, approvals, draw, payouts, audit and compliance (see above).
3. **Public verifier page**: check a card, re-run a draw.
4. ~~Merchandise module~~ — done (see above). Remaining: photo and document uploads, carrier tracking.
5. ~~Voiding a cycle with refunds; manual refunds with two-person approval~~ — done (see above).
6. ~~Publishing the full ticket list when a cycle is archived; settling and archiving steps~~ — done (see above).
7. ~~Notifications (SMS/in-app); support requests and tools~~ — done (see above). Remaining: WhatsApp.
8. ~~Reconciliation report and financial reports; operating-expense records~~ — done (see above).
9. ~~Unclaimed-prize reminders and expiry; the next-of-kin claim process~~ — done.
10. ~~Tier 2 checks (liveness) before major-prize claims; fraud rules beyond the staff register~~ — done (see *Liveness and fraud rules*). Remaining: more fraud rules as real patterns appear.

## Before any real money (Phase 3 and later — unchanged)

Real key service, real public beacon or regulator-approved randomness, real payment/identity/SMS providers, separate database roles, admin single sign-on with hardware keys, shared rate limiting, penetration test, game certification, and the Niger State licence.
