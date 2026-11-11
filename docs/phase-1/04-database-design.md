# Database and transaction-security design

Brief deliverable 4. The design is executable: `db/schema.sql` (PostgreSQL 16), with `db/schema_test.sql` proving that 57 unsafe actions are rejected by the database itself. Both run in CI.

## Principles

1. **The database is the last line of defence.** Rules that protect fairness and money are constraints and triggers, not only application code.
2. **Money is integer kobo** in `bigint`. No floating point anywhere.
3. **History is never rewritten.** Ledger, audit log, approvals, commitments, draws and self-exclusions are append-only.
4. **Sensitive values are encrypted or hashed before they reach a column.** NIN/BVN and account numbers are stored as keyed hashes (for matching) and ciphertext (for use); ticket outcomes are ciphertext until revealed.

## Table groups

| Group | Tables | Notes |
|-------|--------|-------|
| Players | `users`, `kyc_verifications`, `next_of_kin`, `bank_accounts` | One account per verified identity (`identity_hash` unique) |
| Responsible gaming | `rg_limits`, `self_exclusions`, `exclusion_register` | Defaults ₦5,000 / ₦20,000 / ₦50,000; pending increases held 24h |
| Administration | `admin_users`, `admin_roles` | Conflicting roles rejected; no self-granting |
| Compliance gate | `licences`, `certifications` | Required before a real-money cycle can open |
| Cycles | `cycles`, `prize_tiers`, `cycle_approvals`, `cycle_commitments` | State machine; locked from approval |
| Tickets | `tickets` | Encrypted outcome, leaf hash, once-only sale and reveal |
| Payments | `orders`, `payments`, `payment_events`, `refunds` | Idempotency and uniqueness keys throughout |
| Ledger | `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `ledger_balances` (view) | Double-entry; balanced at commit |
| Draw | `draws`, `draw_winners` | One draw per cycle; two operators + appointed auditor |
| Merchandise | `suppliers`, `purchase_orders`, `skus`, `warehouses`, `stock_units`, `shipments` | Costs, serial numbers, handover evidence |
| Prizes | `prize_claims`, `payouts` | One claim per ticket per stage; maker ≠ checker |
| Oversight | `audit_log`, `compliance_alerts` | Hash-chained log with a verify function |

Deferred to Phase 2: notifications, support tickets, sessions and devices, operating-expense records.

## Rules enforced by the database

| Rule | Mechanism |
|------|-----------|
| A cycle moves only along the approved lifecycle | Transition check in `enforce_cycle_rules` |
| Approval needs two different people, neither the drafter, plus financial model, rules, auditor and fully funded escrow | `check_cycle_approval`, `enforce_cycle_rules` |
| Price, quantities, dates, rules and prize tiers cannot change after approval | Field comparison trigger; `lock_prize_tiers` |
| Published commitments cannot change | Append-only trigger |
| Tickets are created only at generation, sold only while `OPEN`, and never deleted | `tickets_insert_rules`, `enforce_ticket_rules` |
| A ticket's outcome, owner and revealed result cannot change | `enforce_ticket_rules` |
| One claim per ticket per stage; one final-draw prize per ticket | Unique constraints |
| A payment counts only after server-side verification; one success per order; a webhook is processed once | Check and unique constraints |
| Every ledger transaction balances and cannot be edited | Deferred constraint triggers; append-only triggers |
| Refunds and payouts cannot be approved by the person who raised them | Check constraints |
| Real-money sales need a valid state licence and certified game core | `enforce_cycle_rules` on `OPEN` |
| The draw needs a closed cycle, two operators and that cycle's appointed auditor, and runs once | `check_draw`, primary key, check constraint |
| Self-exclusions cannot be shortened or removed | Append-only trigger |
| Audit history cannot be edited, and tampering by a privileged user is detectable | Append-only trigger; hash chain + `audit_log_verify()` |

## Transaction patterns the application must follow (Phase 2)

- **Purchase:** inside one transaction — lock the order, insert the verified payment, `SELECT … FROM tickets WHERE status='UNSOLD' ORDER BY random() … FOR UPDATE SKIP LOCKED`, mark them sold, post the ledger transaction with reference `order:<id>`.
- **Reveal:** lock the ticket row, decrypt, mark revealed, post `INSTANT_PRIZE` with reference `ticket:<id>:instant`, create the claim. Replays hit the unique reference and return the stored result.
- **Payout:** create with idempotency key → (approval if required) → send → on confirmation post `PAYOUT` with reference `payout:<id>`.
- **Spending-limit check:** sum of the player's paid orders in the window, computed under a per-user advisory lock so parallel purchases cannot both slip under the limit.

## Access roles (to be created with the infrastructure)

| Database role | Rights |
|---------------|--------|
| `app_api` | Read/write business tables; insert-only on ledger and audit; cannot alter schema or disable triggers; no KMS decrypt on cycle keys |
| `app_reveal` | Update reveal columns on `tickets`; KMS decrypt for cycle keys |
| `app_generation` | Insert tickets and commitments only; runs as an isolated job |
| `reporting_ro` | Read-only on a replica, with identity and bank columns excluded |
| `migrator` | Schema owner; used only by the deployment pipeline |
| Humans | No standing access; break-glass with approval, time limit and logging |

## Backup and recovery targets (proposal)

- Point-in-time recovery, encrypted backups, copy in a second zone.
- Recovery point objective: 5 minutes. Recovery time objective: 1 hour. To be confirmed against regulator requirements and tested quarterly.
