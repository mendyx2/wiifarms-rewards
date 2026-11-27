// Referrals in the browser: every player has a link, shares the approved
// messages written in the admin app, and earns 10% of friends' cards into
// their wallet. Complaints about promoters; and the statutory deduction on a
// cash prize, as the winner sees it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { POLICY } from "@wiifarm/api/policy.ts";
import { seedDemo } from "@wiifarm/api/seed-demo.ts";
import { adminSignIn, answerDialogs, apiBuy, apiPlayer, assertClean, call, newPage, playerSignIn, scratch, startStack, toast, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("a player shares an approved message with their link and earns 10% of a friend's cards into their wallet; staff see referrals by code", async () => {
  const { token } = await apiPlayer(s, "08036660101", "Ibrahim Sule");
  const { code } = await call(s, "GET", "/v1/me/referrals", { token });

  // A message written in the admin app by the cycle manager and approved by Compliance.
  const m = await newPage(s, "desktop");
  answerDialogs(m);
  await adminSignIn(m, s, "manager");
  await m.click("#nav a[data-nav=referrals]");
  await m.waitForSelector("text=Messages players can share");
  await m.fill("input[name=name]", "WhatsApp invite");
  await m.fill("textarea[name=bodyEn]", "Scratch, win, and every card goes into the Mega Draw! {link} 18+ only. Play responsibly.");
  await m.click('button:has-text("Submit for approval")');
  await toast(m, /Another Compliance officer must approve/);
  const a = await newPage(s, "desktop");
  answerDialogs(a);
  await adminSignIn(a, s, "compliance");
  await a.click("#nav a[data-nav=referrals]");
  await a.waitForSelector("text=No referral earnings yet");
  await a.click('tr:has-text("WhatsApp invite") button:has-text("Approve")');
  await toast(a, /players can share it now/);

  // The player's invite page: the code, the message with their own link, and nothing earned yet.
  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08036660101");
  await visit(p, s.base + "/#/invite");
  await p.waitForSelector("h1:has-text('Invite friends, earn')");
  await p.waitForSelector("text=₦50 on each ₦500 card");
  assert.equal((await p.innerText(".code-big")).trim(), code);
  await p.waitForSelector("text=No earnings yet");
  const text = await p.innerText(".material-text");
  assert.ok(text.includes(`${s.base}/r/${code}`) && !text.includes("{link}"), text);
  assert.ok(decodeURIComponent((await p.getAttribute(".material .share-whatsapp", "href"))!).includes(`/r/${code}`));

  // A friend joins with the code and buys 4 cards (₦2,000): ₦200 goes into the player's wallet.
  const friend = await apiPlayer(s, "08036660111", "Amina Friend", code);
  await apiBuy(s, friend.token, s.demoCycleId, 4);
  await visit(p, s.base + "/#/invite");
  await p.waitForSelector(".tile:has-text('earned') >> text=₦200");
  await p.waitForSelector(".tile:has-text('cards they bought') >> text=4");
  await assertClean(p, "invite page");
  await p.click("text=Open my wallet");
  await p.waitForSelector("h1:has-text('Wallet')");
  await p.waitForSelector(".row:has-text('You can withdraw') >> text=₦200");
  await p.click(".history-filter button:has-text('Referral earnings')");
  await p.waitForSelector(".history-filter button.on:has-text('Referral earnings')");
  await p.waitForSelector(".history-row[data-type=REFERRAL] >> text=+₦200");
  assert.equal(await p.locator(".history-row:not([data-type=REFERRAL])").count(), 0);

  // Staff see the player by code, never by name.
  await a.reload();
  await a.waitForSelector(`tr:has-text("${code}") >> text=₦200`);
  assert.ok(!(await a.content()).includes("Ibrahim Sule"));
  await assertClean(a, "admin referrals");
});

test("a player reports a promoter from the help page, and Compliance sees the complaint", async () => {
  await apiPlayer(s, "08036660303", "Kabiru Adamu");
  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08036660303");
  await visit(p, s.base + "/#/support");
  await p.click("summary:has-text('Report a promoter')");
  await p.selectOption("select[name=category]", "PRESSURE");
  await p.fill("textarea[name=description]", "A man at the motor park kept pushing me to buy ten cards.");
  await p.click('button:has-text("Send report")');
  await toast(p, /Report CMP-\d{6} sent/);
  await assertClean(p, "report a promoter");

  const a = await newPage(s, "desktop");
  answerDialogs(a, () => ""); // "which player?" — not known
  await adminSignIn(a, s, "compliance");
  await a.click("#nav a[data-nav=referrals]");
  await a.waitForSelector("text=Complaints about promoters");
  await a.waitForSelector("tr:has-text('motor park') >> text=Not known");
  await a.click("tr:has-text('motor park') button:has-text('Investigate')");
  await toast(a, /You are investigating/);
  await a.fill("tr:has-text('motor park') textarea[name=findings]", "Could not identify the promoter.");
  await a.click("tr:has-text('motor park') button:has-text('Conclude')");
  await toast(a, /Complaint concluded/);
  await a.waitForSelector("tr:has-text('motor park') >> text=Dismissed");
  await assertClean(a, "complaints");
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
