# WiiFarm Rewards

Digital scratch-card and prize-management platform. **Phase 2 (simulated platform) — nothing here accepts real money.**

| Where | What |
|-------|------|
| `docs/IMPLEMENTATION_PLAN.md` | Overall plan, decisions and schedule |
| `docs/phase-1/` | Phase 1 design pack (start with its README) |
| `docs/phase-3/` | Certification pack for the test lab, internal security review, what remains before real money |
| `docs/phase-2/` | Phase 2 status: what is built, how to run it, what remains |
| `apps/api/` | Backend API (simulated payments, identity and randomness beacon) |
| `apps/web/` | Player web app, served by the API |
| `apps/admin/` | Admin web app, served by the API under `/admin` |
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

Browser tests drive both web apps in real Chromium (a whole cycle from draft to archive, the player journey, refunds, cancellation, finance, staff access and licences). They need the same database server and a Chromium for Playwright (`pnpm --filter @wiifarm/browser-tests exec playwright install chromium` the first time):

```bash
pnpm test:browser
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

It refuses to start unless `WR_SIMULATION=1` is set, because this build has only simulated payments, identity checks and sign-in; it also refuses to listen on anything but this machine unless `WR_ALLOW_PUBLIC_SIMULATION=1` is set for a closed demonstration network. Behind a load balancer or CDN, set `WR_TRUSTED_PROXIES` to the number of proxies in front of the server, so rate limits count each player separately (left at 0, every player would share the proxy's allowance). It needs `DATABASE_URL`, plus `MASTER_KEY` and `HASH_KEY` (64 hex characters each, e.g. from `openssl rand -hex 32`). It applies database migrations on start.

```bash
pnpm --filter @wiifarm/api start
```
