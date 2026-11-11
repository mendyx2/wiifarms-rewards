# Phase 2 — minimum viable platform (simulated money only)

Status as of 12 November 2026: **backend complete for the core journey and tested end to end; web apps not yet connected.**

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
| F. Merchandise | Winners get a claim with the 90-day window | Stock allocation, delivery and handover not built yet |
| G. Dashboard | Figures per cycle and totals from the ledger; audit trail with integrity check | No screen yet (data only) |

## What the tests prove

`apps/api/test/e2e.test.ts` runs a complete cycle against a real PostgreSQL — 12 tests, run repeatedly without failure:

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

## Differences from the Phase 1 plan

| Plan said | Built | Why |
|-----------|-------|-----|
| NestJS | Fastify | Fewer third-party packages to trust; no build step |
| Argon2id for PINs | scrypt (built into Node.js) | Avoids a native add-on; parameters are stored with each hash so they can be raised or replaced |
| Separate database roles per service | One role | Needs the hosting decision; still required before Phase 3 |
| Reservation of specific cards during payment | Availability check, then assign on payment; refund if gone | Simpler and never strands a card; revisit if refunds at sell-out prove annoying |

## API summary

Player: `POST /v1/auth/otp`, `/auth/register`, `/auth/login`, `/auth/logout` · `GET /v1/me` · `POST /v1/me/verify` · `PUT /v1/me/next-of-kin`, `/me/limits` · `POST /v1/me/exclusion`, `/me/bank-accounts` · `GET /v1/cycles`, `/cycles/:id`, `/cycles/:id/draw` · `POST /v1/orders` · `POST /v1/simulated-gateway/pay` · `GET /v1/tickets` · `POST /v1/tickets/:id/reveal` · `GET /v1/wallet` · `POST /v1/payouts`

Admin: `POST /v1/admin/dev-login` (simulation only) · `GET /v1/admin/dashboard`, `/admin/audit` · `POST /v1/admin/exclusion-register` · `POST /v1/admin/cycles` and `/cycles/:id/prize-tiers`, `/submit`, `/approve`, `/commit`, `/open`, `/draw/sign`, `/draw/execute` · `PUT /v1/admin/cycles/:id/evidence` · `GET /v1/admin/payouts/pending` · `POST /v1/admin/payouts/:id/decision`

## Still to do in Phase 2

1. **Player web app** connected to the API (the Phase 1 prototype is still a stand-alone mockup).
2. **Admin web app** connected to the API, including the cycle wizard, approvals, draw console and payout queue.
3. **Public verifier page**: check a card, re-run a draw.
4. **Merchandise module**: suppliers, stock, reserving stock to a cycle, delivery/collection with code and photo, warranty records.
5. Voiding a cycle with refunds; manual refunds (ineligible purchase, disputed payment) with two-person approval.
6. Publishing the full ticket list when a cycle is archived; settling and archiving steps.
7. Notifications (SMS/WhatsApp/in-app) and support tickets.
8. Reconciliation report and financial reports; operating-expense records.
9. Unclaimed-prize reminders, expiry and the next-of-kin claim process.
10. Tier 2 checks (liveness) before major-prize claims; fraud rules beyond the staff register.

## Before any real money (Phase 3 and later — unchanged)

Real key service, real public beacon or regulator-approved randomness, real payment/identity/SMS providers, separate database roles, admin single sign-on with hardware keys, shared rate limiting, penetration test, game certification, and the Niger State licence.
