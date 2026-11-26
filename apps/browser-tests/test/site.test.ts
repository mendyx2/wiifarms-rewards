// The public website pages (SRS WEB-001 to WEB-015), as a visitor sees them
// before signing in: the site map links every page, each one loads, fits a
// small phone, and the prize pages carry what the SRS requires.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { assertClean, assertFits, newPage, startStack, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("a visitor can reach every public page from the site map, and each prize has its own page", async () => {
  const p = await newPage(s);
  await p.goto(s.base + "/");
  await p.waitForSelector(".hero");
  await p.click("a:has-text('All pages')");
  await p.waitForSelector("h1:has-text('WiiFarm Rewards')");
  const links = await p.locator(".site-link").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  assert.equal(links.length, 14);
  for (const href of links) {
    await visit(p, s.base + "/" + href);
    await p.waitForSelector("main h1, main .hero");
  }

  // The catalogue and a prize page.
  await visit(p, s.base + "/#/prizes");
  await p.waitForSelector("h2:has-text('Mega Draw prizes')");
  await p.locator(".prize-link").first().click();
  await p.waitForSelector("h2:has-text('Redemption conditions')");
  for (const label of ["Value", "Quantity", "How it is won"]) await p.waitForSelector(`.row:has-text('${label}')`);
  await p.waitForSelector("text=No purchase, membership or payment is ever needed to claim a prize.");

  await visit(p, s.base + "/#/about");
  await p.waitForSelector("text=No licence is in force yet");
  await visit(p, s.base + "/#/help");
  await p.click("summary:has-text('Do I have to pay to collect a prize?')");
  await p.waitForSelector("text=Nobody may ask you to pay");
  await visit(p, s.base + "/#/responsible");
  await p.waitForSelector("text=Warning signs");
  await visit(p, s.base + "/#/past");
  await p.waitForSelector("text=No campaign has finished yet.");

  await assertClean(p, "public pages");
  await assertFits(p, s.base, ["/#/site", "/#/prizes", "/#/how", "/#/help", "/#/responsible", "/#/about", "/#/past", "/#/centres"], "main h1");
});
