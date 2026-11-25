# Phase 3 — security and certification (preparation)

Status as of 19 November 2026: **preparation done in-house; the independent work has not started.**

Phase 3 cannot be finished by the development team alone. It needs an accredited test lab to certify the game engine, an independent firm to test security, the real payment, identity and SMS providers, and the hosting decision. This document is what the team has prepared so that those parties can start quickly, plus an internal security review done before any outsider looks.

---

## 1. Certification pack for the test lab

Everything a lab needs to certify the engine that fixes ticket outcomes and runs the final draw.

| Item | Where |
|------|-------|
| Engine source (about 350 lines, no third-party code) | `packages/game-core/src/` |
| Design and rules: hashing, commitments, shuffle, draw | `docs/phase-1/03-game-core-spec.md` |
| Exact identity of the code being certified | Fingerprint below; recompute with `pnpm --filter @wiifarm/game-core fingerprint` or the one-line shell command in `packages/game-core/tools/digest.ts` |
| Reference cases (fixed inputs and the required answers) | `packages/game-core/test-vectors.json` |
| Independent second implementation | The player app's checker, `apps/web/public/js/verify.js` — written separately using the browser's own cryptography, and tested to give exactly the same answers as the engine on every reference case |
| Statistical fairness report | Section 1.2; regenerate with `pnpm --filter @wiifarm/game-core stats` |
| How a certificate is bound to the code | Section 1.3 |

### 1.1 Engine fingerprint

```
game-core@0.1.0+sha256:de4e5522101c67c4c00528a96ea4e5fe183a4f62014ed3bdd90709436a67c730
```

This is the SHA-256 of every source file of the engine, in a defined order. (Changed on 25 November 2026, when a memory-efficient form of the card commitment tree was added for campaigns of millions of cards; it produces exactly the same roots and proofs as before, which the tests check.) Change one character of the engine and the fingerprint changes. The tests check that the tool and the plain shell definition always agree.

### 1.2 Statistical fairness report

Chi-square goodness-of-fit tests. Every input is fixed, so anyone running the tool gets exactly these numbers.

| Test | Samples | Categories | Chi-square | p-value |
|------|--------:|-----------:|-----------:|--------:|
| Random number 1–2: each value equally likely | 1,000,000 | 2 | 0.36 | 0.547 |
| Random number 1–3 | 1,000,000 | 3 | 1.17 | 0.558 |
| Random number 1–7 | 1,000,000 | 7 | 3.57 | 0.735 |
| Random number 1–10 | 1,000,000 | 10 | 5.88 | 0.752 |
| Random number 1–100 | 1,000,000 | 100 | 124.63 | 0.042 |
| Random number 1–1000 | 1,000,000 | 1000 | 990.75 | 0.568 |
| Shuffle of 10: each item in each position | 2,000,000 | 100 | 73.74 | 0.704 |
| Inventory of 100: which card gets the prize | 100,000 | 100 | 76.95 | 0.951 |
| Draw of 50 entries: winner of first prize | 100,000 | 50 | 59.9 | 0.137 |
| Draw of 50 entries: winner of second prize | 100,000 | 50 | 46.55 | 0.573 |

**About the 0.042.** With ten tests, about one result in twenty is expected below 0.05 by chance alone, so one low value is normal. It was nonetheless followed up rather than assumed. Forty further independent runs of the same test averaged a chi-square of 99.23, against 99 expected from a perfectly fair generator. That is 0.1 standard errors away. Exactly 20 of the 40 fell above 99, as expected. There is no sign of bias.

This is the development team's own evidence, not a certificate. The lab will run its own tests and may ask for raw output in a particular format, or for more samples.

### 1.3 How a certificate is tied to the code

- Every cycle records the fingerprint of the engine that generated its tickets, and every draw records the fingerprint that ran it.
- Compliance records a certificate against an exact fingerprint, and a different person verifies it (built in Phase 2).
- The database will not let a real-money cycle open unless a verified, in-date, unrevoked certificate matches that cycle's fingerprint exactly. A modified engine, even one with the same version number, therefore has no certificate and cannot take real money.

### 1.4 Questions to settle with the lab and the regulator

From the engine design, section 9:
1. Is a random-number generator built on HMAC-SHA-256 and seeded from a hardware security module acceptable, or must a specific certified generator be used?
2. Is a public randomness beacon acceptable as an input to the final draw, and from which sources?
3. What statistical evidence is required, and in what format and sample sizes?
4. What format is required for draw reports, and how long must records be kept?

---

## 2. Internal security review

A review of the whole system against the Phase 1 threat model before any external tester sees it. Each finding was confirmed by demonstration, fixed, and covered by a test.

| # | Finding | Risk | Status |
|---|---------|------|--------|
| S1 | The simulation shortcuts (sign-in by email for staff, one-time codes shown on screen, the fake payment gateway) were always on. Deployed somewhere reachable, anyone could have signed in as an administrator. | Critical if deployed | **Fixed.** The server refuses to start unless simulation is switched on explicitly, and refuses to accept connections from other machines unless that is separately allowed for a closed demonstration network. |
| S2 | Server error logs could contain database detail text, which can include personal data. | Medium (data protection) | **Fixed.** Logs keep the error type and message but not the database's detail text, which repeats the row's values. |
| S3 | After a 15-minute lockout, PIN guessing could resume indefinitely. | Medium | **Fixed.** After ten wrong PINs the lockout is 24 hours. |
| S4 | A sign-in attempt for an unknown phone number was refused faster than one for a real account, revealing who has an account. | Low | **Fixed.** Both take the same time. *Accepted remainder:* a locked account still answers "locked", which shows the number has an account; the message is kept because it helps the real owner. |
| S5 | A certificate was tied to a hand-written version label, so a changed engine could have kept an old certificate. | High (fairness) | **Fixed.** The engine fingerprint (section 1.3). |
| S6 | Behind a load balancer, every player appears to come from the balancer's address, so all players would have shared one rate limit and a busy sale would have locked everyone out. | High (availability) | **Fixed.** `WR_TRUSTED_PROXIES` sets how many proxies to trust. Addresses a client invents are ignored, so limits cannot be dodged. Tested both ways. |
| S7 | A delivery of more than about 1,500 serial-numbered items was refused as too large, so large consignments could not be recorded. | Medium (operations) | **Fixed.** That one request may be up to 1 MB (5,000 serial numbers). Tested with 3,000. |
| S8 | Known-vulnerable dependencies | — | **None found.** The running system uses only two outside packages: the web server and the database driver. |

Fixed earlier, during Phase 2, and still covered by tests:
- Buyers wrongly refunded in a sell-out rush.
- A crash when the database dropped a connection.
- A false "audit trail broken" alarm under load.
- Deadlocks between simultaneous payments.
- A database rule that blocked cancelling an already-revealed card.
- A stale message badge.

What the review confirmed is already sound:
- **Database queries:** all are parameterised, so no SQL injection.
- **Web apps:** neither turns text into page code, under a strict content policy that blocks injected scripts.
- **Sessions:** sign-in cookies cannot be read by page scripts or sent by other sites, and forged requests from other sites are refused.
- **Credentials:** PINs, session tokens and identity numbers are stored only in hashed or encrypted form, and one-time codes are never stored at all.
- **Two people:** every money and fairness action needs two people, enforced in the database as well as the app.

---

## 3. What still stands between this and real money

None of these can be done in code alone. In rough order of importance:

| # | Item | Why it matters | Needs |
|---|------|----------------|-------|
| 1 | **Niger State licence** | Without it nothing else matters | Legal counsel; management |
| 2 | **Real key-management service** for ticket outcomes and draw secrets (today a local key stands in) | Keeps unrevealed outcomes unreadable even to staff with server access | Cloud provider chosen |
| 3 | **Separate database roles** (today the application owns its tables, so a compromised server could switch off the database's safety rules) | Makes the database rules hold even against the application itself | Hosting set-up |
| 4 | **Staff sign-in through company single sign-on with hardware keys** (today: simulation only) | Admin accounts are the most valuable target | Identity provider chosen |
| 5 | **Real payment provider**, with signed webhooks re-checked against the provider, real refunds and payouts, and the daily statement fed into reconciliation | Money | Provider that accepts lottery merchants; quotes |
| 6 | **Real identity checks** (NIN/BVN, liveness) and **bank-account name enquiry** | Age, one account per person, payouts to the right person | Provider; quotes |
| 7 | **Real SMS** (and WhatsApp) provider | Codes, wins, security alerts | Provider; sender-ID registration |
| 8 | **Public randomness beacon** for the draw (today simulated) | The draw's unpredictability | Lab and regulator approval (question 2 above) |
| 9 | **Shared rate limiting across servers**, web firewall, DDoS protection | Availability on sale and draw days | Hosting |
| 10 | **Backups, standby, restore drills, monitoring and alerting** | Recovery from failure | Hosting |
| 11 | **Data-protection work**: impact assessment, safeguards for transferring data to the regional cloud, retention schedule, breach procedure | Nigeria Data Protection Act | Counsel; data protection officer |
| 12 | **Independent penetration test** against the threat model, fixes, and a retest | Required evidence | Security firm; budget |
| 13 | **Engine certification** using the pack above | Required for real money | Accredited lab; budget |
| 14 | **Load test at expected peak** (sell-out minutes, draw night) | Availability | Hosting; expected volumes |

Two design limits to raise with the lab and the testers:
- **Size of the public draw data.** It contains every entry, which is fine at today's sizes but would need to be paged for cycles of hundreds of thousands of cards.
- **The phone checks in the player app** run on the player's device and need its built-in cryptography; very old phones may be unable to run them.

---

## 4. Suggested next steps

1. Management confirms the licence route (item 1) and the cloud provider (items 2, 3, 9, 10).
2. Shortlist and approach two test labs and two security firms, sending them this document, the threat model and the engine specification for quotes.
3. Open test accounts with the payment, identity and SMS providers; ask payment providers first whether they accept lottery merchants.
4. Arrange a fluent Hausa speaker, ideally from Niger State, to review all the Hausa: the app (`apps/web/public/js/i18n.js`) and the texts and messages (the `ha:` version beside each English message in `apps/api/src/modules`). See the Phase 2 document, *Hausa*.
