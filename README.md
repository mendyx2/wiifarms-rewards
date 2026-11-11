# WiiFarm Rewards

Digital scratch-card and prize-management platform. **Phase 1 (system design) — nothing here accepts real money.**

| Where | What |
|-------|------|
| `docs/IMPLEMENTATION_PLAN.md` | Overall plan, decisions and schedule |
| `docs/phase-1/` | Phase 1 design pack (start with its README) |
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

Database checks need PostgreSQL 16 and an empty database:

```bash
psql -v ON_ERROR_STOP=1 -f db/schema.sql
```

```bash
psql -v ON_ERROR_STOP=1 -f db/schema_test.sql
```
