// The SRS affiliate model in the browser: a player applies on the affiliate
// page, Compliance approves in the admin app, and the affiliate sees their
// attribution code; fees stay off until two people switch them on. Also the
// statutory deduction on a cash prize, as the winner sees it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { POLICY } from "@wiifarm/api/policy.ts";
import { seedDemo } from "@wiifarm/api/seed-demo.ts";
import { adminSignIn, adminToken, answerDialogs, apiBuy, apiPlayer, assertClean, call, newPage, playerSignIn, scratch, startStack, toast, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("a player applies to be an affiliate, Compliance approves, and the affiliate page shows the code; fees stay off until switched on", async () => {
  const { token } = await apiPlayer(s, "08036660101", "Ibrahim Sule");
  await call(s, "POST", "/v1/me/bank-accounts", { token, body: { bankCode: "058", accountNumber: "0300000001", accountName: "Ibrahim Sule" } });

  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08036660101");
  await visit(p, s.base + "/#/invite");
  await p.click("a[href='#/affiliate']");
  // Paid work needs the liveness check first.
  await p.waitForSelector("h1:has-text('Become an affiliate')");
  await p.waitForSelector("text=not being paid yet");
  await p.click("text=Do the liveness check");
  await p.waitForSelector("main h1");
  await call(s, "POST", "/v1/me/liveness", { token });
  await visit(p, s.base + "/#/affiliate");
  await p.waitForSelector("input[name=business]");
  await p.fill("input[name=business]", "Sule Promotions");
  await p.fill("input[name=email]", "sule@example.com");
  await p.fill("textarea[name=channels]", "WhatsApp groups in Bida");
  await p.click("summary:has-text('Compliance training')");
  await p.waitForSelector("text=no downlines");
  await p.check("input[name=training]");
  await p.check("input[name=agreement]");
  await p.click('button:has-text("Apply")');
  await toast(p, /Application AFF-\d{6} sent/);
  await p.waitForSelector("text=Waiting for review");

  // Compliance approves in the admin app.
  const a = await newPage(s, "desktop");
  answerDialogs(a);
  await adminSignIn(a, s, "compliance");
  await a.click("#nav a[data-nav=affiliates]");
  await a.waitForSelector("text=Sule Promotions");
  await a.waitForSelector("text=Fees off");
  await a.click('tr:has-text("Sule Promotions") button:has-text("Approve")');
  await toast(a, /Affiliate approved/);
  await a.waitForSelector('tr:has-text("Sule Promotions") >> text=Approved');
  // Compliance asks to switch fees on; the same person cannot approve it.
  await a.fill("input[name=legal]", "LEGAL/2026/22");
  await a.fill("input[name=reason]", "Board resolution");
  await a.click('button:has-text("Request change")');
  await toast(a, /Someone else must approve/);
  await a.waitForSelector("text=Waiting for a decision");
  assert.equal(await a.locator('.card:has-text("Fee programme") button:has-text("Approve")').count(), 0);
  await assertClean(a, "admin affiliates");

  // The affiliate's page: code, link and share buttons; fees still off.
  await visit(p, s.base + "/#/affiliate");
  await p.waitForSelector("h1:has-text('Your affiliate page')");
  const code = (await p.innerText(".code-big")).trim();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.ok(decodeURIComponent((await p.getAttribute(".share-whatsapp", "href"))!).includes(`/r/${code}`));
  await p.waitForSelector("text=not being paid yet");

  // Finance approves the switch; the page now shows the fee.
  const fin = await adminToken(s, "finance");
  const change = (await call(s, "GET", "/v1/admin/affiliates", { token: fin })).programmeChanges[0];
  await call(s, "POST", `/v1/admin/affiliate-programme/changes/${change.id}/decision`, { token: fin, body: { approve: true } });
  await p.reload();
  await p.waitForSelector("text=Affiliate fees: 2.5%");
  await assertClean(p, "affiliate page");
});

test("a winner sees the statutory deduction, and only the net reaches the wallet", async () => {
  const policy = s.ctx.config.policy;
  s.ctx.config.policy = { ...POLICY, prizeShareBp: 10_000, instantShareBp: 10_000, winningsTaxBp: 1000 };
  const { cycleId } = await seedDemo(s.ctx, { name: "Deduction Season", tickets: 40, instant: [[50_000, 40]] });
  if (policy) s.ctx.config.policy = policy; else delete s.ctx.config.policy;
  const { token } = await apiPlayer(s, "08036660202", "Hauwa Bala");
  await apiBuy(s, token, cycleId, 2);

  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08036660202");
  await visit(p, s.base + `/#/rules/${cycleId}`);
  await p.waitForSelector("text=By law, 10% of every cash prize is withheld");
  await visit(p, s.base + "/#/cards");
  await p.locator(".ticket").first().click();
  await scratch(p);
  await p.waitForSelector("text=₦50 statutory deduction (10%) · ₦450 to your wallet");
  await p.click('button:has-text("Accept ₦500")');
  await toast(p, /₦450 added to your wallet/);
  await p.waitForFunction(() => document.getElementById("topBal")!.textContent!.trim() === "₦450");
  await assertClean(p, "deduction");

  const a = await newPage(s, "desktop");
  await adminSignIn(a, s, "finance");
  await a.click("#nav a[data-nav=finance]");
  await a.waitForSelector("text=Statutory deductions on winnings");
  await a.waitForSelector('tr:has-text("Deduction Season") >> text=₦50');
  await assertClean(a, "finance deductions");
});
