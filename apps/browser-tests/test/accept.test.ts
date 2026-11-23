// Scratching a winning card with a finger, then tapping Accept to move the prize into the wallet.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { POLICY } from "@wiifarm/api/policy.ts";
import { seedDemo } from "@wiifarm/api/seed-demo.ts";
import { answerDialogs, apiBuy, apiPlayer, assertClean, newPage, playerSignIn, scratch, startStack, toast, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("swipe to scratch a winning card, then Accept moves the prize into the wallet, once", async () => {
  // A season where every card wins ₦500, so the test always has a prize to accept. Only possible under an
  // overridden policy (all sales to instant prizes), used for this test season alone.
  const policy = s.ctx.config.policy;
  s.ctx.config.policy = { ...POLICY, prizeShareBp: 10_000, instantShareBp: 10_000 };
  const { cycleId } = await seedDemo(s.ctx, { name: "Winners' Season", tickets: 40, instant: [[50_000, 40]] });
  if (policy) s.ctx.config.policy = policy; else delete s.ctx.config.policy;
  const { token } = await apiPlayer(s, "08038880101", "Zainab Yusuf");
  await apiBuy(s, token, cycleId, 10);

  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08038880101");
  await visit(p, s.base + "/#/cards");
  await p.waitForSelector(".ticket");
  // Scratch a card with a finger: the prize shows, and is not in the wallet until accepted.
  await p.locator(".ticket").first().click();
  await scratch(p);
  await p.waitForSelector("text=Entered in the final draw");
  const amount = (await p.innerText(".result .big")).trim();
  assert.equal(amount, "₦500");
  assert.match(await p.innerText(".result"), /Tap Accept to add it to your wallet/);
  assert.equal((await p.innerText("#topBal")).trim(), "₦0");
  await p.click('button:has-text("Accept ₦")');
  await toast(p, new RegExp(`${amount.replace(/[₦,]/g, ".")} added to your wallet`));
  assert.match(await p.innerText(".result"), /Added to your wallet/);
  assert.equal(await p.locator('button:has-text("Accept ₦")').count(), 0);
  await p.waitForFunction((a) => document.getElementById("topBal")!.textContent!.trim() === a, amount);
  // Coming back to the card: still accepted, nothing to accept again.
  await p.reload();
  await p.waitForSelector("text=Added to your wallet");
  assert.equal(await p.locator('button:has-text("Accept ₦")').count(), 0);
  await assertClean(p, "accepting a prize");
});
