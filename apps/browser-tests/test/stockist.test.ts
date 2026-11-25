// Collecting a prize at a collection centre (SRS section 14), in the browser:
// the winner chooses a centre, Fulfilment sends the prize there, the winner
// gets a voucher, and the centre's clerk verifies it in the stockist portal,
// checks ID, takes a photo and enters the winner's code. Head office sees the
// centre's records add up.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { adminSignIn, adminToken, answerDialogs, apiBuy, apiPlayer, assertClean, call, newPage, playerSignIn, sleep, startStack, toast, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

/** A small season with one merchandise prize, run to its draw through the API (not what is under test here). */
async function wonPrize(token: string): Promise<void> {
  const [ft, mt, ot, fin, aud] = await Promise.all(["fulfilment", "manager", "operations", "finance", "auditor"].map((w) => adminToken(s, w))) as [string, string, string, string, string];
  const supplier = (await call(s, "POST", "/v1/admin/suppliers", { token: ft, body: { name: "Rice Mill" } })).id;
  const warehouse = (await call(s, "POST", "/v1/admin/warehouses", { token: ft, body: { name: "Store", address: "1 Store Road, Minna", stateCode: "NG-NI" } })).id;
  const sku = (await call(s, "POST", "/v1/admin/skus", { token: ft, body: { name: "Rice 50kg bag", advertisedValueKobo: 500_000, serialised: true } })).id;
  await call(s, "POST", "/v1/admin/stock/receive", { token: ft, body: { skuId: sku, supplierId: supplier, warehouseId: warehouse, poReference: "PO-RICE", serialNumbers: ["RICE-001"], acquisitionCostKobo: 1, landedCostKobo: 1 } });
  const now = Date.now(), close = new Date(now + 15_000).toISOString();
  const c = (await call(s, "POST", "/v1/admin/cycles", { token: mt, body: { name: "Rice Season", ticketPriceKobo: 50_000, totalTickets: 20, maxTicketsPerAccount: 20,
    salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: close, drawAt: close } })).id;
  await call(s, "POST", `/v1/admin/cycles/${c}/prize-tiers`, { token: mt, body: { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Rice 50kg bag", skuId: sku, quantity: 1, drawOrder: 1 } });
  const auditorId = (await call(s, "GET", "/v1/admin/auditors", { token: mt })).auditors[0].id;
  await call(s, "PUT", `/v1/admin/cycles/${c}/evidence`, { token: mt, body: { financialModelRef: "fm", rulesDocumentRef: "rules", rulesText: "Rice Season rules.",
    escrowReference: "ESC", escrowFundedKobo: 0, auditorAdminId: auditorId } });
  await call(s, "POST", `/v1/admin/cycles/${c}/reserve-stock`, { token: ft });
  await call(s, "POST", `/v1/admin/cycles/${c}/submit`, { token: mt });
  await call(s, "POST", `/v1/admin/cycles/${c}/approve`, { token: ot });
  await call(s, "POST", `/v1/admin/cycles/${c}/approve`, { token: fin });
  await call(s, "POST", `/v1/admin/cycles/${c}/commit`, { token: mt });
  await call(s, "POST", `/v1/admin/cycles/${c}/open`, { token: mt });
  await apiBuy(s, token, c, 5);
  await call(s, "PUT", "/v1/me/next-of-kin", { token, body: { fullName: "Musa Kin", relationship: "Brother", phone: "08030004444" } });
  await sleep(Math.max(0, Date.parse(close) - Date.now()) + 2500);
  for (const t of [mt, fin, aud]) await call(s, "POST", `/v1/admin/cycles/${c}/draw/sign`, { token: t });
  await call(s, "POST", `/v1/admin/cycles/${c}/draw/execute`, { token: mt });
}

test("a winner collects a prize at a centre: voucher, ID check, photo and code in the stockist portal; the books add up", async () => {
  const { token } = await apiPlayer(s, "08037770101", "Rakiya Umar");
  await wonPrize(token);

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
