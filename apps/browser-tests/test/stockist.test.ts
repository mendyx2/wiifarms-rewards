// Collecting a prize at a collection centre (SRS section 14), in the browser:
// the winner chooses a centre, Fulfilment sends the prize there, the winner
// gets a voucher, and the centre's clerk verifies it in the stockist portal,
// checks ID, takes a photo and enters the winner's code. Head office sees the
// centre's records add up.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { adminSignIn, answerDialogs, apiPlayer, assertClean, newPage, playerSignIn, startStack, toast, visit, wonPrize, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("a winner collects a prize at a centre: voucher, ID check, photo and code in the stockist portal; the books add up", async () => {
  const { token } = await apiPlayer(s, "08037770101", "Rakiya Umar");
  await wonPrize(s, token);

  // The winner chooses the demo collection centre.
  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08037770101");
  await visit(p, s.base + "/#/centres");
  await p.waitForSelector("text=Minna Central Stockist");
  await visit(p, s.base + "/#/wallet");
  const prize = p.locator('.card:has-text("Rice 50kg bag")');
  await prize.locator("summary").click();
  await prize.locator("select[name=method]").selectOption("COLLECTION");
  await prize.locator("select[name=centre]").selectOption({ label: "Minna Central Stockist · Minna" });
  await prize.locator("input[name=pin]").fill("482915");
  await prize.locator('button:has-text("Claim my prize")').click();
  await toast(p, /Prize claimed/);
  await p.waitForSelector("text=We are sending it to Minna Central Stockist");

  // Fulfilment sends it to the centre.
  const a = await newPage(s, "desktop");
  answerDialogs(a);
  await adminSignIn(a, s, "fulfilment");
  await visit(a, s.base + "/admin#/merchandise");
  const q = a.locator('.card:has(b:text-is("Rice 50kg bag")):has-text("Winner")');
  await q.locator('button:has-text("Send to the centre")').click();
  await toast(a, /Marked as sent/);

  // The winner has a voucher and a code.
  await p.reload();
  await p.waitForSelector(".voucher");
  const voucher = (await p.innerText(".voucher-ref")).trim();
  assert.match(voucher, /^WV-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const code = (await p.locator('.card:has-text("Rice 50kg bag") .balance').innerText()).trim();
  assert.match(code, /^\d{6}$/);
  await assertClean(p, "winner's voucher");

  // The centre's clerk: only the portal; verify, check ID, photo, code.
  const c = await newPage(s, "desktop");
  answerDialogs(c);
  await adminSignIn(c, s, "stockist");
  await c.waitForSelector("h1:has-text('Minna Central Stockist')");
  assert.deepEqual(await c.locator("#nav a:visible").allInnerTexts(), ["Stockist portal"]);
  await c.fill("input[name=voucher]", "WV-AAAA-AAAA");
  await c.click('button:has-text("Verify")');
  await toast(c, /not valid at this centre/);
  await c.fill("input[name=voucher]", voucher.toLowerCase());
  await c.click('button:has-text("Verify")');
  await c.waitForSelector("text=Winner: Rakiya Umar");
  assert.equal((await c.content()).includes(code), false, "the centre never sees the code");
  await c.selectOption("select[name=idChecked]", "VOTERS_CARD");
  await c.setInputFiles("input[name=photo]", { name: "handover.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]) });
  await c.fill("input[name=code]", code);
  await c.click('button:has-text("Confirm handover")');
  await toast(c, /Handed over and recorded/);
  await c.waitForSelector(".tile:has-text('Fulfilment rate') >> text=100%");
  // A second attempt with the same voucher is refused.
  await c.fill("input[name=voucher]", voucher);
  await c.click('button:has-text("Verify")');
  await toast(c, /already redeemed/);
  // The fee can be invoiced.
  await c.click('button:has-text("Invoice the fees")');
  await toast(c, /Invoice INV-\d{6} for ₦1,000 sent/);
  await assertClean(c, "stockist portal");

  // The winner sees it received; head office sees the records add up and pays the invoice.
  await p.reload();
  await p.waitForSelector('.card:has-text("Rice 50kg bag") .pill:has-text("Received")');
  await adminSignIn(a, s, "finance");
  await visit(a, s.base + "/admin#/centres");
  await a.waitForSelector("text=Every unit at every centre matches its handover records");
  await a.click('tr:has-text("INV-") button:has-text("Approve and pay")');
  await toast(a, /Paid \(SIMSTK-/);
  await assertClean(a, "collection centres (admin)");
});
