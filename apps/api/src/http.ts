import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Actor } from "./audit.ts";
import type { Ctx } from "./context.ts";
import { withTx } from "./db.ts";
import { AppError, badRequest } from "./errors.ts";
import * as admin from "./modules/admin.ts";
import * as cycles from "./modules/cycles.ts";
import * as draw from "./modules/draw.ts";
import * as identity from "./modules/identity.ts";
import * as tickets from "./modules/tickets.ts";
import * as wallet from "./modules/wallet.ts";

// --- Small JSON-schema helpers; unknown fields are always rejected ----------------------
const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max });
const int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const uuid = { type: "string", format: "uuid" };
const body = (properties: Record<string, unknown>, optional: string[] = []) => ({
  body: { type: "object", additionalProperties: false, properties, required: Object.keys(properties).filter((k) => !optional.includes(k)) },
});
const idParam = { params: { type: "object", properties: { id: uuid }, required: ["id"] } };

/** Fixed-window limiter per client address. Single-instance only; production uses a shared store behind the WAF. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): void => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      if (hits.size > 50_000) hits.clear();
      hits.set(key, { n: 1, reset: now + windowMs });
      return;
    }
    if (++h.n > max) throw new AppError(429, "RATE_LIMITED", "Too many requests. Please slow down.");
  };
}

const bearer = (req: FastifyRequest): string | undefined => {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
};
const idemKey = (req: FastifyRequest): string => {
  const k = req.headers["idempotency-key"];
  if (typeof k !== "string") throw badRequest("INVALID_IDEMPOTENCY_KEY", "Missing Idempotency-Key header.");
  return k;
};

export function buildServer(ctx: Ctx): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const authLimit = limiter(ctx.config.rateLimits.auth, 60_000);
  const generalLimit = limiter(ctx.config.rateLimits.general, 60_000);

  app.addHook("onRequest", async (req) => generalLimit(req.ip));
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (e.validation) return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: e.message } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: "INVALID_REQUEST", message: e.message } });
    // Never leak internals to the caller.
    console.error(err);
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } });
  });

  const player = (req: FastifyRequest) => identity.authenticate(ctx, bearer(req));
  const staff = (req: FastifyRequest) => admin.authenticateAdmin(ctx, bearer(req));
  const actorOf = (userId: string, req: FastifyRequest): Actor => ({ type: "PLAYER", id: userId, ip: req.ip });

  app.get("/health", async () => ({ ok: true, mode: "SIMULATED" }));

  // ---- Sign-up and sign-in ---------------------------------------------------------
  app.post<{ Body: { phone: string } }>("/v1/auth/otp", { schema: body({ phone: str(20) }) }, async (req) => {
    authLimit(req.ip);
    return identity.requestOtp(ctx, req.body.phone);
  });
  app.post<{ Body: { phone: string; code: string; pin: string } }>("/v1/auth/register", { schema: body({ phone: str(20), code: str(6), pin: str(6) }) }, async (req) => {
    authLimit(req.ip);
    return identity.registerWithOtp(ctx, req.body.phone, req.body.code, req.body.pin, req.ip);
  });
  app.post<{ Body: { phone: string; pin: string } }>("/v1/auth/login", { schema: body({ phone: str(20), pin: str(6) }) }, async (req) => {
    authLimit(req.ip);
    return identity.login(ctx, req.body.phone, req.body.pin, req.ip);
  });
  app.post("/v1/auth/logout", async (req) => {
    const t = bearer(req);
    if (t) await identity.logout(ctx, t);
    return { ok: true };
  });

  // ---- Player profile ----------------------------------------------------------------
  app.get("/v1/me", async (req) => {
    const u = await player(req);
    const extra = await withTx(ctx.pool, async (db) => ({
      limits: await identity.getLimits(db, u.id),
      exclusion: (await identity.activeExclusion(db, u.id)) ?? null,
      nextOfKin: (await db.query("SELECT full_name, relationship FROM next_of_kin WHERE user_id = $1", [u.id])).rows[0] ?? null,
    }));
    return { id: u.id, phoneLast4: u.phone_e164.slice(-4), fullName: u.full_name, kycTier: u.kyc_tier, stateCode: u.state_code, ...extra };
  });
  app.post<{ Body: identity.KycInput }>("/v1/me/verify", {
    schema: body({ kind: { enum: ["NIN", "BVN"] }, number: str(11), fullName: str(120), dateOfBirth: str(10), stateCode: str(8) }),
  }, async (req) => {
    const u = await player(req);
    return identity.verifyIdentity(ctx, u.id, req.body, req.ip);
  });
  app.put<{ Body: { fullName: string; relationship: string; phone: string } }>("/v1/me/next-of-kin", {
    schema: body({ fullName: str(120), relationship: str(60), phone: str(20) }),
  }, async (req) => {
    const u = await player(req);
    await identity.setNextOfKin(ctx, actorOf(u.id, req), u.id, req.body);
    return { ok: true };
  });
  app.put<{ Body: { dailyKobo: number; weeklyKobo: number; monthlyKobo: number } }>("/v1/me/limits", {
    schema: body({ dailyKobo: int(), weeklyKobo: int(), monthlyKobo: int() }),
  }, async (req) => {
    const u = await player(req);
    return identity.setLimits(ctx, actorOf(u.id, req), u.id, req.body);
  });
  app.post<{ Body: { kind: "COOL_OFF" | "SELF_EXCLUSION"; days?: number } }>("/v1/me/exclusion", {
    schema: body({ kind: { enum: ["COOL_OFF", "SELF_EXCLUSION"] }, days: int(1, 36500) }, ["days"]),
  }, async (req) => {
    const u = await player(req);
    return identity.selfExclude(ctx, actorOf(u.id, req), u.id, req.body.kind, req.body.days);
  });
  app.post<{ Body: { bankCode: string; accountNumber: string; accountName: string } }>("/v1/me/bank-accounts", {
    schema: body({ bankCode: str(10), accountNumber: str(10), accountName: str(120) }),
  }, async (req) => {
    const u = await player(req);
    return identity.addBankAccount(ctx, actorOf(u.id, req), u, req.body);
  });

  // ---- Catalogue (public) ---------------------------------------------------------------
  app.get("/v1/cycles", async () => ({ cycles: await cycles.listPublicCycles(ctx) }));
  app.get<{ Params: { id: string } }>("/v1/cycles/:id", { schema: idParam }, async (req) => cycles.getPublicCycle(ctx, req.params.id));
  app.get<{ Params: { id: string } }>("/v1/cycles/:id/draw", { schema: idParam }, async (req) => draw.getPublicDraw(ctx, req.params.id));

  // ---- Buying and scratching --------------------------------------------------------------
  app.post<{ Body: { cycleId: string; quantity: number } }>("/v1/orders", { schema: body({ cycleId: uuid, quantity: int(1, 20) }) }, async (req) => {
    const u = await player(req);
    return tickets.createOrder(ctx, actorOf(u.id, req), u, req.body.cycleId, req.body.quantity, idemKey(req));
  });
  app.post<{ Body: { paymentRef: string } }>("/v1/simulated-gateway/pay", { schema: body({ paymentRef: str(64) }) }, async (req) => {
    const u = await player(req);
    return tickets.simulatePayment(ctx, u, req.body.paymentRef);
  });
  app.get<{ Querystring: { cycleId?: string } }>("/v1/tickets", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { cycleId: uuid } } },
  }, async (req) => {
    const u = await player(req);
    return { tickets: await tickets.listTickets(ctx, u.id, req.query.cycleId) };
  });
  app.post<{ Params: { id: string } }>("/v1/tickets/:id/reveal", { schema: idParam }, async (req) => {
    const u = await player(req);
    return tickets.revealTicket(ctx, actorOf(u.id, req), u.id, req.params.id);
  });

  // ---- Winnings ------------------------------------------------------------------------------
  app.get("/v1/wallet", async (req) => wallet.getWallet(ctx, (await player(req)).id));
  app.post<{ Body: { amountKobo: number; bankAccountId: string; pin: string } }>("/v1/payouts", {
    schema: body({ amountKobo: int(1), bankAccountId: uuid, pin: str(6) }),
  }, async (req) => {
    authLimit(req.ip);
    const u = await player(req);
    await identity.confirmPin(ctx, u.id, req.body.pin); // step-up: PIN again for every withdrawal
    return wallet.requestPayout(ctx, actorOf(u.id, req), u, { amountKobo: req.body.amountKobo, bankAccountId: req.body.bankAccountId, idempotencyKey: idemKey(req) });
  });

  // ---- Administration ---------------------------------------------------------------------------
  app.post<{ Body: { email: string } }>("/v1/admin/dev-login", { schema: body({ email: str(200) }) }, async (req) => {
    authLimit(req.ip);
    return admin.devAdminLogin(ctx, req.body.email);
  });
  app.get("/v1/admin/dashboard", async (req) => admin.dashboard(ctx, await staff(req)));
  app.get("/v1/admin/audit", async (req) => admin.auditTrail(ctx, await staff(req)));
  app.post<{ Body: { category: string; phone?: string; idKind?: "NIN" | "BVN"; idNumber?: string; note?: string } }>("/v1/admin/exclusion-register", {
    schema: body({ category: { enum: ["STAFF", "DIRECTOR", "CONTRACTOR", "AUDITOR", "SUPPLIER", "FAMILY"] }, phone: str(20), idKind: { enum: ["NIN", "BVN"] }, idNumber: str(11), note: str(500) }, ["phone", "idKind", "idNumber", "note"]),
  }, async (req) => admin.addToExclusionRegister(ctx, await staff(req), req.body));

  app.post<{ Body: cycles.NewCycle }>("/v1/admin/cycles", {
    schema: body({ name: str(120), ticketPriceKobo: int(1), totalTickets: int(1, 1_000_000), maxTicketsPerAccount: int(1), salesOpenAt: str(40), salesCloseAt: str(40), drawAt: str(40), claimWindowDays: int(1, 365) }, ["claimWindowDays"]),
  }, async (req) => cycles.createCycle(ctx, await staff(req), req.body));
  app.post<{ Params: { id: string }; Body: cycles.NewTier }>("/v1/admin/cycles/:id/prize-tiers", {
    schema: { ...idParam, ...body({ stage: { enum: ["INSTANT", "FINAL_DRAW"] }, kind: { enum: ["CASH", "MERCHANDISE"] }, title: str(120), cashKobo: int(1), skuId: uuid, quantity: int(1), drawOrder: int(1) }, ["cashKobo", "skuId", "drawOrder"]) },
  }, async (req) => cycles.addPrizeTier(ctx, await staff(req), req.params.id, req.body));
  app.put<{ Params: { id: string }; Body: cycles.Evidence }>("/v1/admin/cycles/:id/evidence", {
    schema: { ...idParam, ...body({ financialModelRef: str(), rulesDocumentRef: str(), rulesText: str(20_000), escrowReference: str(), escrowFundedKobo: int(), auditorAdminId: uuid }) },
  }, async (req) => { await cycles.setEvidence(ctx, await staff(req), req.params.id, req.body); return { ok: true }; });

  const step = (path: string, fn: (a: admin.Admin, id: string) => Promise<unknown>) =>
    app.post<{ Params: { id: string } }>(`/v1/admin/cycles/:id/${path}`, { schema: idParam }, async (req) => (await fn(await staff(req), req.params.id)) ?? { ok: true });
  step("submit", (a, id) => cycles.submitCycle(ctx, a, id));
  step("approve", (a, id) => cycles.approveCycle(ctx, a, id));
  step("commit", (a, id) => cycles.commitCycle(ctx, a, id));
  step("open", (a, id) => cycles.openCycle(ctx, a, id));
  step("draw/sign", (a, id) => draw.signDraw(ctx, a, id));
  step("draw/execute", (a, id) => draw.executeDraw(ctx, a, id));

  app.get("/v1/admin/payouts/pending", async (req) => ({ payouts: await wallet.listPendingPayouts(ctx, await staff(req)) }));
  app.post<{ Params: { id: string }; Body: { approve: boolean; reason?: string } }>("/v1/admin/payouts/:id/decision", {
    schema: { ...idParam, ...body({ approve: { type: "boolean" }, reason: str(500) }, ["reason"]) },
  }, async (req) => wallet.decidePayout(ctx, await staff(req), req.params.id, req.body.approve, req.body.reason));

  return app;
}
