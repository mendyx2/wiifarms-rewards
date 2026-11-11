# WiiFarm Rewards

Digital scratch-card and prize-management platform. **Phase 2 (simulated platform) — nothing here accepts real money.**

| Where | What |
|-------|------|
| `docs/IMPLEMENTATION_PLAN.md` | Overall plan, decisions and schedule |
| `docs/phase-1/` | Phase 1 design pack (start with its README) |
| `docs/phase-2/` | Phase 2 status: what is built, how to run it, what remains |
| `apps/api/` | Backend API (simulated payments, identity and randomness beacon) |
| `packages/game-core/` | Reference implementation of ticket commitments and the final draw |
| `db/` | PostgreSQL schema and its safety tests |
| `prototypes/` | Clickable player and admin mockups (open the HTML files in a browser) |

## Running the checks

```bash
pnpm install
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

`pnpm test` includes the API's end-to-end tests, which need PostgreSQL 16. They create and drop their own database on the server named by `TEST_DATABASE_URL` (default `postgres://postgres:postgres@127.0.0.1:5432/postgres`).

The schema's own safety tests run against an empty database:

```bash
psql -v ON_ERROR_STOP=1 -f db/schema.sql
```

```bash
psql -v ON_ERROR_STOP=1 -f db/schema_test.sql
```

## Running the API locally (simulation)

It needs `DATABASE_URL`, plus `MASTER_KEY` and `HASH_KEY` (64 hex characters each, e.g. from `openssl rand -hex 32`). It applies database migrations on start.

```bash
pnpm --filter @wiifarm/api start
```
