// Inviting friends and the wallet, in the browser: an invite link fills in the
// code at sign-up, the friend's purchase pays the inviter 2.5% into their
// wallet, and the wallet pays for cards with the PIN.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { accounts, post } from "@wiifarm/api/ledger.ts";
import { withTx } from "@wiifarm/api/db.ts";
import { answerDialogs, apiPlayer, assertClean, call, newPage, playerSignIn, startStack, toast, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("an invite link fills in the code, the friend's purchase pays the inviter, and the wallet buys cards with the PIN", async () => {
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
  await f.click('button:has-text("Create account")');
  await f.waitForSelector("h1:has-text(\"Confirm it's you\")");
  await f.fill("input[name=number]", "12345670202");
  await f.fill("input[name=fullName]", "Sani Ibrahim");
  await f.fill("input[name=dob]", "1990-08-08");
  await f.click("text=Verify and continue");
  await f.waitForSelector("text=How many cards?");
  await f.click('.chips button:has-text("10")');
  await f.click('button:has-text("Pay ₦5,000")');
  await f.click("text=Confirm simulated payment");
  await f.waitForSelector(".ticket");
  await assertClean(f, "invited friend");

  // The inviter has earned 2.5% of ₦5,000 = ₦125. (A ₦500 credit is added here so a card can be bought from the wallet.)
  const inviterId = (await s.pool.query("SELECT id FROM users WHERE phone_e164 = '+2348039990101'")).rows[0].id as string;
  await withTx(s.pool, (db) => post(db, { kind: "ADJUSTMENT", reference: "test:credit:inviter", memo: "test set-up", debit: accounts.companyBank(), credit: accounts.playerWinnings(inviterId), amountKobo: 50_000 }));
  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08039990101");
  await p.click("#tabs a[data-tab=wallet]");
  await p.waitForSelector("h1:has-text('Wallet')");
  assert.equal((await p.innerText(".balance")).trim(), "₦625");
  assert.ok((await p.locator(".row b").allInnerTexts()).includes("Referral earnings"));

  // Paying from the wallet asks for the PIN again.
  await p.click("text=Buy cards from my wallet");
  await p.waitForSelector("text=How many cards?");
  await p.click('.chips button:has-text("1")');
  await p.click('button:has-text("Pay ₦500 from my wallet (₦625)")');
  await p.waitForSelector("h1:has-text('Pay from your wallet')");
  assert.match(await p.innerText("main .card"), /Wallet balance after\s+₦125/);
  await p.fill("input[name=pin]", "999999");
  await p.click('button:has-text("Confirm and buy")');
  await toast(p, /Enter your PIN/);
  await p.fill("input[name=pin]", "482915");
  await p.click('button:has-text("Confirm and buy")');
  await toast(p, /Paid from your wallet/);
  await p.waitForSelector(".ticket");
  assert.equal(await p.locator(".ticket").count(), 1);
  assert.equal((await p.innerText("#topBal")).trim(), "₦125");
  await assertClean(p, "wallet purchase");
});
