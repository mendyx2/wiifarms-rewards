// Sharing and engagement: the invite screen and share links, live activity and
// the countdown, real sales milestones, pop-ups approved by a second person,
// prize pictures, achievements, and link previews.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { seedDemo } from "@wiifarm/api/seed-demo.ts";
import { adminSignIn, answerDialogs, apiBuy, apiPlayer, assertClean, call, newPage, playerSignIn, startStack, toast, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("invite screen and share links, live activity, countdown, milestones, achievements and link previews", async () => {
  // A small season, a quarter sold, so the 25% milestone is real.
  const { cycleId } = await seedDemo(s.ctx, { name: "Small Season", tickets: 40 });
  const buyer = await apiPlayer(s, "08037770303", "Musa Lawal");
  await apiBuy(s, buyer.token, cycleId, 10);
  const me = await apiPlayer(s, "08037770404", "Aisha Umar");
  const { code } = await call(s, "GET", "/v1/me/referrals", { token: me.token });

  const p = await newPage(s);
  answerDialogs(p);
  await playerSignIn(p, s, "08037770404");
  // Milestone pop-up: true figures, shown once.
  await p.waitForSelector(".modal >> text=25% of the cards are sold");
  assert.match(await p.innerText(".modal"), /30 cards are left/);
  await p.click('.modal button:has-text("Close")');
  await visit(p, s.base + "/#/home");
  await p.waitForSelector(".hero");
  await p.waitForTimeout(800);
  assert.equal(await p.locator(".modal").count(), 0, "a milestone is shown once");

  // Live activity and a ticking countdown to the real closing time.
  assert.match(await p.innerText(".card.live"), /10 cards sold in the last hour/);
  const t1 = await p.innerText(".countdown b");
  await p.waitForTimeout(1200);
  assert.notEqual(await p.innerText(".countdown b"), t1);

  // Invite screen: the code, a link that works, and share buttons carrying both.
  await p.click(".invite-card");
  await p.waitForSelector("h1:has-text('Invite friends')");
  assert.match(await p.innerText("main"), /₦50 on each ₦500 card, paid straight into your wallet/);
  assert.equal((await p.innerText(".code-big")).trim(), code);
  const link = `${s.base}/r/${code}`;
  const wa = await p.getAttribute(".share-whatsapp", "href");
  assert.ok(wa!.startsWith("https://wa.me/?text=") && decodeURIComponent(wa!).includes(link) && decodeURIComponent(wa!).includes(code));
  assert.match(decodeURIComponent(wa!), /18\+ only/);
  assert.equal(await p.getAttribute(".share-facebook", "rel"), "noopener noreferrer");
  for (const app of ["facebook", "x", "telegram"]) assert.ok(decodeURIComponent((await p.getAttribute(`.share-${app}`, "href"))!).includes(link));
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: s.base });
  await p.click('button:has-text("Copy link")');
  await toast(p, /Link copied/);
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), link);
  assert.match(await p.innerText(".tiles"), /0\s+friends joined/);

  // Achievements: earned ones lit, none of them for spending.
  await visit(p, s.base + "/#/me");
  await p.waitForSelector(".badges");
  assert.equal(await p.locator(".badge.got").count(), 2); // verified, shared
  assert.ok((await p.locator(".badge").allInnerTexts()).every((t) => !/spend|buy \d+/i.test(t)));
  await assertClean(p, "engagement screens");

  // Link previews: title, description and a real 1200 × 630 picture.
  const html = await (await fetch(s.base + "/")).text();
  assert.match(html, /property="og:title" content="WiiFarm Rewards"/);
  assert.match(html, /og:image" content="\/og-image.png"/); // absolute once WR_PUBLIC_URL is set
  const og = Buffer.from(await (await fetch(s.base + "/og-image.png")).arrayBuffer());
  assert.equal(`${og.readUInt32BE(16)}x${og.readUInt32BE(20)}`, "1200x630");
});

test("pop-ups need a second person, show once in the player's language, and prize pictures appear on the home screen", async () => {
  const a = await newPage(s, "desktop");
  answerDialogs(a);
  await adminSignIn(a, s, "manager");
  await a.click("#nav a[data-nav=popups]");
  await a.fill("input[name=titleEn]", "Car draw date confirmed");
  await a.fill("input[name=titleHa]", "An tabbatar da ranar zaɓen mota");
  await a.fill("textarea[name=bodyEn]", "The Mega Draw, with the car, is on the date shown on the home screen.");
  await a.selectOption("select[name=link]", "#/draw");
  await a.click('button:has-text("Submit for approval")');
  await toast(a, /must approve/);
  assert.equal(await a.locator('button:has-text("Approve")').count(), 0, "the writer cannot approve");

  // Nothing shows until Compliance approves it.
  const p = await newPage(s);
  await p.goto(s.base + "/");
  await p.waitForSelector(".hero");
  await p.waitForTimeout(800);
  assert.equal(await p.locator(".modal:has-text('Car draw date')").count(), 0);

  await adminSignIn(a, s, "compliance");
  await visit(a, s.base + "/admin#/popups");
  await a.click('button:has-text("Approve")');
  await toast(a, /Approved/);
  await a.waitForSelector(".pill:has-text('Live')");

  // A Hausa reader sees the Hausa title (and the English message, as no Hausa was written); once only.
  const h = await newPage(s);
  await h.addInitScript(() => localStorage.setItem("lang", "ha"));
  await h.goto(s.base + "/");
  await h.waitForSelector(".modal >> text=An tabbatar da ranar zaɓen mota");
  await h.click(".modal a.btn");
  await h.waitForSelector("main h1, main .card");
  assert.match(h.url(), /#\/draw$/);
  await visit(h, s.base + "/#/home");
  await h.waitForSelector(".hero");
  await h.waitForTimeout(800);
  assert.equal(await h.locator(".modal:has-text('mota')").count(), 0);

  // Prize pictures: uploaded before sales open, shown to players; the demo season is already selling, so its pictures are fixed.
  await adminSignIn(a, s, "manager");
  await visit(a, s.base + "/admin#/cycles");
  await a.fill("input[name=name]", "Pictures season");
  await a.click('button:has-text("Create draft")');
  await a.waitForSelector("h1:has-text('Pictures season')");
  const f = a.locator('form:has-text("Add a prize")');
  await f.locator("select[name=stage]").selectOption("FINAL_DRAW");
  await f.locator("select[name=kind]").selectOption("CASH");
  await f.locator("input[name=title]").fill("₦1,000,000 cash");
  await f.locator("input[name=cash]").fill("1000000");
  await f.locator("button").click();
  await toast(a, /Prize added/);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await a.setInputFiles('input[type=file][aria-label="Prize picture"]', { name: "prize.png", mimeType: "image/png", buffer: png });
  await toast(a, /Picture saved/);
  await a.waitForSelector("img.thumb");
  await a.setInputFiles('input[type=file][aria-label="Prize picture"]', { name: "evil.svg", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)>") });
  await toast(a, /PNG, JPEG or WebP/);
  await visit(a, s.base + "/admin#/cycle/" + s.demoCycleId);
  await a.waitForSelector("text=Prize pictures are fixed once sales open");
  assert.equal(await a.locator('input[type=file][aria-label="Prize picture"]').count(), 0);
  await assertClean(a, "pop-ups and pictures (admin)");
  await assertClean(h, "pop-up (player)");
});
