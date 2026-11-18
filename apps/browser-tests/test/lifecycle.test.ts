// A whole prize cycle through both web apps: drafting and two-person approval,
// sales, the final draw with its sign-offs, the player checking the draw on
// their phone, claiming and receiving a prize, close-out, and the player
// checking the whole cycle.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { seedDemo } from "@wiifarm/api/seed-demo.ts";
import { adminSignIn, answerDialogs, apiPlayer, assertClean, assertFits, newPage, playerSignIn, sleep, startStack, toast, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

test("from draft to archive: approvals, draw, claim, handover, close-out, and the player verifying it all", async () => {
  // A cycle that closes 30 seconds from now, so its draw can run during this test.
  const { cycleId } = await seedDemo(s.ctx, { name: "Quick Cycle", tickets: 40, closeInMinutes: 0.5 });
  const phone = "08036660021";
  await apiPlayer(s, phone, "Hauwa Sani");
  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, phone);
  // The newest open cycle is shown first; the player buys 20 of its cards.
  await p.waitForSelector(".hero .tag:has-text('Quick Cycle')");
  await p.click("text=Buy scratch cards");
  await p.click('.chips button:has-text("20")');
  await p.click('button:has-text("Pay ₦4,000")');
  await p.click("text=Confirm simulated payment");
  await p.waitForSelector(".ticket");

  // --- Meanwhile, staff draft and approve another cycle through the admin app ---
  const a = await newPage(s, "desktop");
  answerDialogs(a, () => "Reason given in test");
  await adminSignIn(a, s, "manager");
  await a.click("#nav a[data-nav=cycles]");
  await a.fill("input[name=name]", "Browser Cycle");
  await a.fill("input[name=total]", "30");
  await a.fill("input[name=close]", localInput(new Date(Date.now() + 864e5)));
  await a.fill("input[name=draw]", localInput(new Date(Date.now() + 864e5)));
  await a.click('button:has-text("Create draft")');
  await a.waitForSelector("h1:has-text('Browser Cycle')");
  const draftId = a.url().split("/cycle/")[1]!;
  const prize = async (stage: string, title: string, cash: number, qty: number) => {
    const f = a.locator('form:has-text("Add a prize")');
    await f.locator("select[name=stage]").selectOption(stage);
    await f.locator("select[name=kind]").selectOption("CASH");
    await f.locator("input[name=title]").fill(title);
    await f.locator("input[name=cash]").fill(String(cash));
    await f.locator("input[name=quantity]").fill(String(qty));
    await f.locator("button").click();
  };
  await prize("INSTANT", "₦50,000", 50000, 1);
  assert.match(await toast(a, /between ₦500 and ₦10,000/), /Instant prizes must be cash between ₦500 and ₦10,000/);
  await prize("INSTANT", "₦500", 500, 5);
  await toast(a, /Prize added/);
  await a.click('button:has-text("Submit for approval")');
  await toast(a, /Submitted/);
  await a.click('button:has-text("Approve as Operations")');
  assert.match(await toast(a, /drafted/), /the person who drafted a cycle cannot approve it/);

  await adminSignIn(a, s, "operations");
  await visit(a, s.base + "/admin#/approvals");
  await a.waitForSelector("text=Browser Cycle");
  assert.equal(await a.innerText("#apCount"), "1");
  await a.click('a:has-text("Review")');
  await a.click('button:has-text("Approve as Operations")');
  await toast(a, /Approval recorded/);

  await adminSignIn(a, s, "finance");
  await visit(a, s.base + "/admin#/cycle/" + draftId);
  const ev = a.locator('form:has-text("Evidence required")');
  await ev.locator("input[name=model]").fill("FM-1");
  await ev.locator("input[name=rulesRef]").fill("RULES-1");
  await ev.locator("input[name=escrow]").fill("ESC-1");
  await ev.locator("input[name=funded]").fill("2499");
  await ev.locator("textarea[name=rules]").fill("Rules");
  await ev.locator("button").click();
  await toast(a, /Evidence saved/);
  await a.click('button:has-text("Approve as Finance")');
  assert.match(await toast(a, /escrow/), /Cash prizes total ₦2,500 but only ₦2,499 is recorded in escrow/);
  await a.locator(`form:has-text("Evidence required") input[name=funded]`).fill("2500");
  await a.locator('form:has-text("Evidence required") textarea[name=rules]').fill("Rules");
  await a.locator('form:has-text("Evidence required") button').click();
  await toast(a, /Evidence saved/);
  await a.click('button:has-text("Approve as Finance")');
  await a.waitForSelector(".lock");
  assert.equal(await a.locator('form:has-text("Evidence required")').count(), 0, "locked after approval");
  await assertClean(a, "drafting and approval");

  // --- The quick cycle closes; the draw needs two operators and the appointed auditor ---
  await adminSignIn(a, s, "manager");
  for (let i = 0; i < 40; i++) {
    await visit(a, s.base + "/admin#/cycle/" + cycleId);
    await a.reload(); // same address: force a fresh load
    await a.waitForSelector("h2:has-text('Final draw')");
    if (await a.locator('button:has-text("Sign off as operator")').count()) break;
    await sleep(2000);
  }
  await a.click('button:has-text("Sign off as operator")');
  await toast(a, /Sign-off recorded/);
  assert.equal(await a.locator('button:has-text("Execute draw")').isDisabled(), true);
  await adminSignIn(a, s, "finance");
  await visit(a, s.base + "/admin#/cycle/" + cycleId);
  await a.click('button:has-text("Sign off as operator")');
  await toast(a, /Sign-off recorded/);
  await adminSignIn(a, s, "auditor");
  await visit(a, s.base + "/admin#/cycle/" + cycleId);
  assert.equal(await a.locator('button:has-text("Execute draw")').count(), 0, "the auditor cannot execute");
  await a.click('button:has-text("Countersign as auditor")');
  await toast(a, /Sign-off recorded/);
  await adminSignIn(a, s, "manager");
  await visit(a, s.base + "/admin#/cycle/" + cycleId);
  for (let i = 0; i < 20; i++) {
    await a.waitForSelector('button:has-text("Execute draw"):not([disabled])');
    await a.click('button:has-text("Execute draw")');
    if (/Draw complete/.test(await toast(a))) break;
    await sleep(1500); // the announced randomness round may not have happened yet
  }
  await a.waitForSelector("text=Winning tickets");
  assert.equal(await a.locator('button:has-text("Execute draw")').count(), 0, "a draw runs once");

  // --- The player is told, and checks the draw on the phone ---
  await visit(p, s.base + "/#/home");
  await p.waitForSelector("text=prizes to claim");
  await p.waitForSelector("#bellCount:not([hidden])");
  await p.click("#tabs a[data-tab=draw]");
  await p.click("text=Verify the draw");
  await p.waitForSelector("main .note:has-text('Verified')");
  assert.equal(await p.locator("main .check .tick.no").count(), 0);
  await visit(p, s.base + "/#/inbox");
  await p.waitForSelector(".msg");
  assert.ok((await p.locator(".msg b").allInnerTexts()).some((t) => t.startsWith("You won")));

  // --- Claiming a prize: next of kin first, then delivery confirmed with the PIN ---
  await visit(p, s.base + "/#/wallet");
  await p.waitForSelector("h2:has-text('My prizes')");
  await p.waitForSelector("text=Add your next of kin before claiming");
  await visit(p, s.base + "/#/me");
  await p.click('summary:has-text("Add next of kin")');
  await p.fill("input[name=name]", "Zainab Sani");
  await p.fill("input[name=rel]", "Sister");
  await p.fill("input[name=phone]", "08030001111");
  await p.click("text=Save next of kin");
  await toast(p, /Next of kin saved/);
  await visit(p, s.base + "/#/wallet");
  const moto = p.locator('.card:has-text("Electric motorcycle")');
  await moto.locator("summary").click();
  await moto.locator("input[name=address]").fill("5 Paiko Road, Minna");
  await moto.locator("input[name=pin]").fill("482915");
  await moto.locator('button:has-text("Claim my prize")').click();
  await toast(p, /Prize claimed/);

  // --- Fulfilment dispatches; only the winner sees the handover code ---
  await adminSignIn(a, s, "fulfilment");
  await visit(a, s.base + "/admin#/merchandise");
  const q = () => a.locator('.card:has(b:text-is("Electric motorcycle")):has-text("Winner")');
  await q().locator("input[name=carrier]").fill("Minna Express");
  await q().locator('button:has-text("Dispatch")').click();
  await toast(a, /Marked as sent/);
  await visit(p, s.base + "/#/wallet");
  await p.waitForSelector("text=Your handover code");
  const code = (await p.locator('.card:has-text("Electric motorcycle") .balance').innerText()).trim();
  assert.match(code, /^\d{6}$/);
  await a.reload();
  await a.waitForSelector('button:has-text("Confirm handover")');
  assert.equal((await a.content()).includes(code), false, "staff never see the code");
  await q().locator("input[name=code]").fill(code === "123456" ? "654321" : "123456");
  await q().locator("input[name=photo]").fill("photos/handover.jpg");
  await q().locator('button:has-text("Confirm handover")').click();
  await toast(a, /not correct/);
  await q().locator("input[name=code]").fill(code);
  await q().locator("input[name=photo]").fill("photos/handover.jpg");
  await q().locator('button:has-text("Confirm handover")').click();
  await toast(a, /Handover complete/);
  await p.reload();
  await p.waitForSelector('.card:has-text("Electric motorcycle") .pill:has-text("Received")');
  await assertClean(a, "draw and fulfilment (admin)");

  // --- Close-out: lapsed claims, reconciled money, two people, every card published ---
  await s.pool.query("UPDATE prize_claims SET expires_at = now() - interval '1 minute' WHERE status = 'ENTITLED'"); // as if 90 days had passed
  await adminSignIn(a, s, "finance");
  await visit(a, s.base + "/admin#/finance");
  await a.click('.note.bad button:has-text("Reconcile")');
  await toast(a, /matched/);
  await a.click('.card:has(th:has-text("Payment records")) button:has-text("Sign off")');
  await toast(a, /signed off/);
  await adminSignIn(a, s, "manager");
  await visit(a, s.base + "/admin#/cycle/" + cycleId);
  await a.waitForSelector("h2:has-text('Close-out')");
  await a.click('button:has-text("Request close-out")');
  assert.match(await toast(a, /Close-out requested/), /7 unclaimed prizes closed as expired/);
  assert.equal(await a.locator('button:has-text("Confirm and archive")').count(), 0, "the requester cannot confirm");
  await adminSignIn(a, s, "finance");
  await visit(a, s.base + "/admin#/cycle/" + cycleId);
  await a.click('button:has-text("Confirm and archive")');
  assert.match(await toast(a, /Archived/), /40 cards published/);

  await visit(p, s.base + "/#/draw");
  await p.click('button:has-text("Check the whole cycle")');
  await p.waitForSelector("main .note:has-text('the whole cycle is exactly what was promised')", { timeout: 60_000 });
  assert.equal(await p.locator("main .card:has-text('Check the whole cycle') .tick.no").count(), 0);
  await assertClean(p, "player through the whole cycle");

  // Every admin screen fits a phone.
  await assertFits(a, s.base, ["/admin#/dashboard", "/admin#/cycles", `/admin#/cycle/${cycleId}`, "/admin#/approvals", "/admin#/payouts", "/admin#/refunds",
    "/admin#/finance", "/admin#/merchandise", "/admin#/audit", "/admin#/access"], "main h1", 390);
});
