// The player's journey in a real browser, on a phone-sized screen.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { answerDialogs, assertClean, assertFits, newPage, scratch, startStack, toast, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("a new player signs up, verifies, buys, scratches, checks each card and sees winnings that match", async () => {
  const p = await newPage(s);
  answerDialogs(p);
  await p.goto(s.base + "/");
  await p.waitForSelector(".hero");
  assert.match(await p.innerText(".hero .tag"), /Harvest Cycle 1 · On sale/);
  assert.match(await p.innerText(".facts"), /cards win instant cash/);
  assert.doesNotMatch(await p.innerText("main"), /\bLevel \d/, "players are not shown the levels");

  // A demo card costs nothing and pays nothing.
  await p.click("text=Try a free demo card");
  await p.click('button:has-text("Reveal now")');
  await p.waitForSelector("text=That is how it works");
  assert.equal(await p.locator("#topBal").isHidden(), true);

  // Signing in is required for cards; the guest is sent to sign-up.
  await p.click("#tabs a[data-tab=cards]");
  await p.waitForSelector("h1:has-text('Create your account')");
  await p.fill("input[name=phone]", "0803 123 4567");
  await p.click('button:has-text("Send code")');
  await p.waitForSelector("text=your code is");
  const code = (await p.innerText(".note.warn")).match(/\d{6}/)![0];
  await p.fill("input[name=code]", code);
  await p.fill("input[name=pin]", "111111");
  await p.click('button:has-text("Create account")');
  await toast(p, /harder to guess/);
  await p.fill("input[name=pin]", "482915");
  await p.click('button:has-text("Create account")');

  await p.waitForSelector("h1:has-text(\"Confirm it's you\")");
  await p.fill("input[name=number]", "12345678901");
  await p.fill("input[name=fullName]", "Amina Bello");
  await p.fill("input[name=dob]", "1992-03-14");
  await p.click("text=Verify and continue");
  await p.waitForSelector("text=How many cards?");

  // 10 cards (the daily maximum) at ₦500: exactly the default ₦5,000 daily spending limit.
  await p.click('.chips button:has-text("10")');
  await p.click('button:has-text("Pay ₦5,000")');
  await p.waitForSelector("text=Simulated payment");
  await p.click("text=Confirm simulated payment");
  await p.waitForSelector(".ticket");
  assert.match(await p.innerText("main p.muted"), /^10 cards · 10 to scratch/);

  // Scratching with a finger reveals the pre-set result, and the phone checks it against the published fingerprint.
  await p.locator(".ticket").first().click();
  await scratch(p);
  await p.waitForSelector("text=Entered in the final draw");
  assert.equal(await p.locator(".entered b").nth(1).innerText(), "Checked on your phone");
  const first = await p.innerText(".result");

  // Going back to the same card shows the same result; nothing is paid twice.
  await p.click("a:has-text('My cards')");
  await p.locator(".ticket").first().click();
  await p.waitForSelector("text=Checked on your phone");
  assert.equal(await p.innerText(".result"), first);

  await p.click("a:has-text('My cards')");
  await p.click("text=Reveal all");
  await p.waitForFunction(() => document.querySelectorAll(".ticket.done, .ticket.win").length === 10);
  const wins = await p.$$eval(".ticket.win b", (els) => els.map((e) => Number(e.textContent!.replace(/[^\d]/g, ""))));
  // Revealed prizes wait for the player to accept them into the wallet.
  if (wins.length) {
    assert.equal(await p.locator(".ticket.win .to-accept").count(), wins.length);
    await p.click('button:has-text("Accept all winnings")');
    await toast(p, /added to your wallet/);
    await p.waitForSelector(".ticket.win");
    assert.equal(await p.locator(".to-accept").count(), 0);
  }
  await p.click("#tabs a[data-tab=wallet]");
  await p.waitForSelector(".balance");
  assert.equal(Number((await p.innerText(".balance")).replace(/[^\d]/g, "")), wins.reduce((a, b) => a + b, 0));
  await assertClean(p, "player journey");

  // Withdrawals need the bank account in the player's own name, and the PIN.
  if (wins.length) {
    await p.fill("input[name=number]", "0123456789");
    await p.click("text=Add bank account");
    await toast(p, /Bank account added/);
    await p.waitForSelector("form.card button:has-text('Withdraw')");
    await p.fill("form.card input[name=pin]", "999999");
    await p.click('form.card button:has-text("Withdraw")');
    await toast(p, /Enter your PIN/);
    await p.fill("form.card input[name=pin]", "482915");
    await p.click('form.card button:has-text("Withdraw")');
    await p.waitForSelector("h2:has-text('Withdrawals')");
  }

  // Limits: lowering is instant, raising waits a day, and buying stops at the limit.
  await p.click("#tabs a[data-tab=me]");
  await p.waitForSelector("select[name=daily]");
  await p.selectOption("select[name=daily]", "200000");
  await p.click("text=Save limit");
  await p.waitForSelector("text=₦2,000 a day · ₦8,000 a week");
  await p.selectOption("select[name=daily]", "1000000");
  await p.click("text=Save limit");
  await p.waitForSelector("text=Increase to ₦10,000 a day starts");
  await p.goto(s.base + "/#/buy");
  await p.waitForSelector(".note.warn:not([hidden])");
  assert.match(await p.innerText(".note.warn:not([hidden])"), /bought today's maximum of 10 cards/);
  assert.match(await p.innerText("main"), /Cards today\s+10 of 10/);
  assert.equal(await p.locator("button.btn.gold").isDisabled(), true);

  // The inbox shows the bank-account security alert.
  await p.goto(s.base + "/#/inbox");
  await p.waitForSelector("h1:has-text('Messages')");
  if (wins.length) assert.ok((await p.locator(".msg b").allInnerTexts()).includes("Bank account added"));
  await assertClean(p, "limits and inbox");

  // Every player screen fits a small phone.
  await assertFits(p, s.base, ["/#/home", "/#/cards", "/#/wallet", "/#/draw", "/#/me", "/#/inbox", "/#/buy", "/#/support"], "main h1, main .hero");
});

test("session safety: the sign-in cookie is out of reach of page scripts and other sites, and signing out ends it", async () => {
  const p = await newPage(s);
  await p.goto(s.base + "/#/login");
  await p.fill("input[name=phone]", "08031234567");
  await p.fill("input[name=pin]", "482915");
  await p.click('button:has-text("Sign in")');
  await p.waitForSelector(".hero");
  assert.equal(await p.evaluate(() => document.cookie), "", "the session cookie is HttpOnly");
  // A request that changes something but lacks the app's own header — as a forged cross-site request would — is refused.
  assert.equal(await p.evaluate(async () => (await fetch("/v1/me/limits", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ dailyKobo: 1, weeklyKobo: 1, monthlyKobo: 1 }) })).status), 403);
  // The app never turns server text into HTML.
  assert.equal(await p.evaluate(async () => /innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(await (await fetch("/js/app.js")).text())), false);
  const headers = await p.evaluate(async () => { const r = await fetch("/"); return [r.headers.get("content-security-policy"), r.headers.get("x-frame-options")]; });
  assert.match(headers[0]!, /default-src 'self'/); assert.equal(headers[1], "DENY");

  await p.click("#tabs a[data-tab=me]");
  await p.click("text=Sign out");
  await p.waitForSelector(".hero");
  await p.goto(s.base + "/#/wallet");
  await p.waitForSelector("h1:has-text('Create your account')");
  assert.equal(await p.evaluate(async () => (await fetch("/v1/me")).status), 401);
  await assertClean(p, "sign-out");
});
