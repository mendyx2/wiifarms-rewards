// The management reports (SRS section 15) and the campaign position on the
// dashboard, in the admin app.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { adminSignIn, apiBuy, apiPlayer, assertClean, newPage, startStack, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("finance sees the campaign position and can open every report and download it", async () => {
  const { token } = await apiPlayer(s, "08037771212", "Report Buyer");
  await apiBuy(s, token, s.demoCycleId, 4);
  const a = await newPage(s, "desktop");
  await adminSignIn(a, s, "finance");
  await a.waitForSelector("text=campaign position");
  await a.waitForSelector(".tile:has-text('Realised revenue') >> text=₦2,000");
  await a.waitForSelector("text=/Operating costs \\(illustrative 20%\\)/");

  await a.click("#nav a[data-nav=reports]");
  await a.waitForSelector("h1:has-text('Reports')");
  const ids = await a.locator("a.btn:has-text('Open')").evaluateAll((as) => as.map((x) => x.getAttribute("href")));
  assert.equal(ids.length, 11, "finance sees every report except security incidents");
  for (const href of ids) {
    await visit(a, s.base + "/admin" + href);
    await a.waitForSelector("text=Download spreadsheet (CSV)");
  }
  await visit(a, s.base + "/admin#/reports/ticket-reconciliation");
  await a.waitForSelector("td:has-text('Matches')");
  const csvHref = await a.getAttribute("a:has-text('Download spreadsheet (CSV)')", "href");
  const csv = await a.evaluate(async (u) => (await fetch(u!)).text(), csvHref);
  assert.match(csv.split("\r\n")[0]!, /^Campaign,Cards,Unsold,/);
  await assertClean(a, "reports");
});
