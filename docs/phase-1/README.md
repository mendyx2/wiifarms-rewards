# Phase 1 — system design pack

Status as of 12 November 2026. Phase 1 exit is **management sign-off** on this pack.

## Deliverables against the brief (section 7)

| # | Deliverable | Where | Status |
|---|-------------|-------|--------|
| 1 | Software architecture and framework | `../IMPLEMENTATION_PLAN.md` §2 | Drafted — cloud provider/region still to choose |
| 2 | Customer and administrator mockups | `../../prototypes/player/index.html`, `../../prototypes/admin/index.html` | Clickable prototypes, sample data |
| 3 | Module descriptions | `../IMPLEMENTATION_PLAN.md` §3 | Drafted |
| 4 | Database and transaction security | `04-database-design.md`, `../../db/schema.sql` | Schema written; 57 safety tests pass |
| 5 | Scratch-card and draw engine design | `03-game-core-spec.md`, `../../packages/game-core` | Specified; reference code with 10 passing tests; **not certified** |
| 6 | Payment, identity, notification integrations | `05-integrations-and-costs.md` §1 | Candidates listed; **not yet evaluated or quoted** |
| 7 | Schedule and milestones | `../IMPLEMENTATION_PLAN.md` §11 | Drafted |
| 8 | Cost estimate | `05-integrations-and-costs.md` §3–5 | Effort estimated; **no naira figures until rates and quotes are in** |
| 9 | Build versus license | `05-integrations-and-costs.md` §2 | Drafted |
| 10 | Demonstration prototype | `../../prototypes/` | UI demo now; full simulated platform is the Phase 2 output |

Also in this pack: `01-process-flows.md` (business-process flowcharts and customer journey) and `02-threat-model.md`.

## How to view the prototypes

Open the two HTML files in any browser; the player one is best at phone width. Everything is simulated in the page — no server, no payments, no data leaves the device.

- **Player:** try a demo card, sign up (any phone number and 6-digit code), verify (any 11 digits), buy, scratch with a finger or mouse, check winnings, run a test draw, set limits.
- **Admin:** switch role in the sidebar and try the Approvals page to see separation of duties.

## Needed from management to close Phase 1

1. **Legal confirmation that a licence is obtainable in Niger State**, and from which authority. Everything else can proceed, but real-money launch depends on it.
2. Staff and contractor rates, so the effort estimate becomes a budget.
3. Go-ahead to open sandbox accounts and request quotes from payment, identity and messaging providers — asking payment providers first whether they accept lottery/gaming merchants.
4. Choice of cloud provider and region.
5. The payout amount above which a second approver is required.
6. Review of the two prototypes: wording, prize presentation, anything missing.

## Not done in Phase 1 (by design)

- No real payment, identity or SMS integration.
- No API or production web app; those are Phase 2.
- No certification or penetration test; those are Phase 3.
