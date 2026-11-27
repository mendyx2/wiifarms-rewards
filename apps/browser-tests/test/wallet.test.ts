// Inviting friends and the wallet, in the browser: an invite link fills in the
// code at sign-up, the inviter earns 10% of the friend's cards into their
// wallet, adds money (a deposit), pays for cards from the wallet with the PIN
// (deposits first), and sees it all in the wallet history.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { answerDialogs, apiPlayer, assertClean, call, newPage, playerSignIn, startStack, toast, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("an invite link fills in the code; the inviter earns 10%, adds money, and buys cards from the wallet with the PIN", async () => {
  const inviter = await apiPlayer(s, "08039990101", "Fatima Danladi");
  const { code } = await call(s, "GET", "/v1/me/referrals", { token: inviter.token });

  // The friend opens the invite link; the code is waiting at sign-up and the address is tidied.
  const f = await newPage(s);
  answerDialogs(f);
  await f.goto(s.base + `/r/${code.toLowerCase()}`);
  await f.waitForSelector(".hero");
  assert.equal(new URL(f.url()).search, "");
  await f.click("#tabs a[data-tab=cards]");
  await f.waitForSelector("text=You were invited by a friend");
  assert.equal(await f.inputValue("input[name=ref]"), code);
  await f.fill("input[name=phone]", "0803 999 0202");
  await f.click('button:has-text("Send code")');
  await f.waitForSelector("text=your code is");
  await f.fill("input[name=code]", (await f.innerText(".note.warn")).match(/\d{6}/)![0]);
  await f.fill("input[name=pin]", "482915");
  await f.check("input[name=privacy]");
  await f.click('button:has-text("Create account")');
  await f.waitForSelector("h1:has-text(\"Confirm it's you\")");
  await f.fill("input[name=number]", "12345670202");
  await f.fill("input[name=fullName]", "Sani Ibrahim");
  await f.fill("input[name=dob]", "1990-08-08");
  await f.click("text=Verify and continue");
  await f.waitForSelector("text=How many cards?");
  await f.click('.chips button:has-text("10")');
  await f.check("input[name=rules]");
  await f.click('button:has-text("Pay ₦5,000")');
  await f.click("text=Confirm simulated payment");
  await f.waitForSelector(".ticket");
  await assertClean(f, "invited friend");

  // The inviter has earned 10% of the friend's ₦5,000: ₦500, withdrawable.
  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08039990101");
  await p.click("#tabs a[data-tab=wallet]");
  await p.waitForSelector("h1:has-text('Wallet')");
  assert.equal((await p.innerText(".balance")).trim(), "₦500");
  await p.waitForSelector(".row:has-text('You can withdraw') >> text=₦500");

  // Adding money: ₦1,000 through the (simulated) provider. Deposits are for cards, not for withdrawing.
  await p.click("summary:has-text('Add money')");
  await p.click(".chips.amounts button:has-text('₦1,000')");
  await p.selectOption("select[name=method]", "OPAY");
  await p.click('.deposit button:has-text("Continue")');
  await p.click('button:has-text("Pay ₦1,000 (simulated)")');
  await toast(p, /₦1,000 added to your wallet/);
  await p.waitForFunction(() => document.querySelector(".balance")?.textContent?.trim() === "₦1,500");
  await p.waitForSelector(".row:has-text('Deposits') >> text=₦1,000");
  await p.waitForSelector(".row:has-text('You can withdraw') >> text=₦500");

  // Paying from the wallet asks for the PIN again.
  await p.click("text=Buy cards from my wallet");
  await p.waitForSelector("text=How many cards?");
  await p.click('.chips button:has-text("1")');
  await p.check("input[name=rules]");
  await p.click('button:has-text("Pay ₦500 from my wallet (₦1,500)")');
  await p.waitForSelector("h1:has-text('Pay from your wallet')");
  assert.match(await p.innerText("main .card"), /Wallet balance after\s+₦1,000/);
  await p.fill("input[name=pin]", "999999");
  await p.click('button:has-text("Confirm and buy")');
  await toast(p, /Enter your PIN/);
  await p.fill("input[name=pin]", "482915");
  await p.click('button:has-text("Confirm and buy")');
  await toast(p, /Paid from your wallet/);
  await p.waitForSelector(".ticket");
  assert.equal(await p.locator(".ticket").count(), 1);
  assert.equal((await p.innerText("#topBal")).trim(), "₦1,000");

  // The wallet: deposits were spent first, so the ₦500 earned is still withdrawable; the history shows every kind of movement.
  await p.click("#tabs a[data-tab=wallet]");
  await p.waitForSelector(".row:has-text('Deposits') >> text=₦500");
  await p.waitForSelector(".row:has-text('You can withdraw') >> text=₦500");
  assert.deepEqual(await p.locator(".history-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-type"))), ["CARDS", "DEPOSIT", "REFERRAL"]);
  await p.click(".history-filter button:has-text('Deposits')");
  await p.waitForSelector(".history-filter button.on:has-text('Deposits')");
  await p.waitForSelector(".history-row[data-type=DEPOSIT] >> text=+₦1,000");
  assert.equal(await p.locator(".history-row").count(), 1);
  await assertClean(p, "wallet purchase");
});
