// The player app in Hausa: every screen is visited with the language switched
// to Hausa, and the app's own missing-translation record must stay empty.
// Values that come from the server as data — cycle and prize names, people's
// names, message texts (still composed in English) — are shown as they are and
// so are left out of the check. Error messages from the server are checked.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { answerDialogs, apiBuy, apiPlayer, assertClean, assertFits, call, playerSignIn, newPage, scratch, startStack, toast, untranslated, visit, watchServerData, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("every player screen is in Hausa, and the choice can be switched back to English", async () => {
  const p = await newPage(s);
  answerDialogs(p);
  const serverData = watchServerData(p);

  // A guest switches language on the home screen; the choice applies everywhere, including the tab bar.
  await p.goto(s.base + "/");
  await p.waitForSelector(".hero");
  await p.click('.lang button:has-text("Hausa")');
  await p.waitForSelector(".hero .tag:has-text('Ana sayarwa')");
  assert.match(await p.innerText("#tabs a[data-tab=wallet]"), /Jakar kuɗi/);
  assert.equal(await p.getAttribute("html", "lang"), "ha");
  assert.match(await p.innerText("#modeBanner"), /GWAJI/);

  await visit(p, s.base + "/#/demo");
  await p.click('button:has-text("Bayyana yanzu")');
  await p.waitForSelector("text=Haka yake aiki");
  for (const r of ["/#/signup", "/#/login", "/#/draw", "/#/me"]) { await visit(p, s.base + r); await p.waitForSelector("main h1, main .hero"); }

  // Sign-up in Hausa, including a refused PIN (an error message from the server).
  await visit(p, s.base + "/#/signup");
  await p.fill("input[name=phone]", "0803 555 0101");
  await p.click('button:has-text("Aika lamba")');
  await p.waitForSelector("text=lambarka ita ce");
  const code = (await p.innerText(".note.warn")).match(/\d{6}/)![0];
  await p.fill("input[name=code]", code);
  await p.fill("input[name=pin]", "123456");
  await p.check("input[name=privacy]");
  await p.click('button:has-text("Buɗe asusu")');
  await toast(p, /wuyar tsammani/);
  await p.fill("input[name=pin]", "482915");
  await p.click('button:has-text("Buɗe asusu")');
  await p.waitForSelector("h1:has-text('Tabbatar cewa kai ne')");
  await p.click("summary");
  await p.fill("input[name=number]", "12345670001");
  await p.fill("input[name=fullName]", "Musa Garba");
  await p.fill("input[name=dob]", "1988-05-02");
  await p.click("text=Tabbatar ka ci gaba");
  // The account was opened in Hausa, so texts and messages will be in Hausa too.
  assert.equal(await p.evaluate(async () => (await (await fetch("/v1/me")).json()).language), "ha");
  await p.waitForSelector("text=Katuna nawa?");

  // Buying, scratching and checking a card.
  await p.click('.chips button:has-text("10")');
  await p.check("input[name=rules]");
  await p.click('button:has-text("Biya ₦5,000")');
  await p.click("text=Tabbatar da biyan gwaji");
  await p.waitForSelector(".ticket");
  assert.match(await p.innerText("main p.muted"), /^kati 10 · 10 ba a karce ba/);
  await p.locator(".ticket").first().click();
  await scratch(p);
  await p.waitForSelector("text=An saka a Babban Zaɓe");
  await p.waitForSelector("text=An duba a wayarka");
  await p.click("summary");
  await p.click("a:has-text('Katuna na')");
  await p.click("text=Bayyana duka");
  await p.waitForFunction(() => document.querySelectorAll(".ticket.done, .ticket.win").length === 10);

  // Winnings, with a bank account and a refused withdrawal.
  await visit(p, s.base + "/#/wallet");
  await p.waitForSelector(".balance");
  if (await p.locator("input[name=number]").isVisible()) {
    await p.fill("input[name=number]", "0123456789");
    await p.click("button:has-text(\"Ƙara asusun banki\")");
    await toast(p, /An ƙara asusun banki/);
  }
  if (await p.locator("form.card button:has-text('Cire')").isVisible()) {
    await p.fill("form.card input[name=pin]", "999999");
    await p.click("form.card button:has-text('Cire')");
    await toast(p);
  }

  // Limits, next of kin, inbox and support.
  await visit(p, s.base + "/#/me");
  await p.waitForSelector("select[name=daily]");
  await p.selectOption("select[name=daily]", "1000000");
  await p.click("text=Ajiye iyaka");
  await p.waitForSelector("text=zai fara");
  // The page may redraw once more after saving the limit (closing the section), so open it until it stays open.
  for (let i = 0; i < 5 && !(await p.locator("input[name=name]").isVisible()); i++) {
    await p.click('summary:has-text("Ƙara magaji")');
    await p.waitForTimeout(300);
  }
  await p.fill("input[name=name]", "Halima Garba");
  await p.fill("input[name=rel]", "Matarsa");
  await p.fill("input[name=phone]", "08030002222");
  await p.click("text=Ajiye magaji");
  await toast(p, /An ajiye magaji/);
  await visit(p, s.base + "/#/inbox");
  await p.waitForSelector("h1:has-text('Saƙonni')");
  await visit(p, s.base + "/#/support");
  await p.waitForSelector("textarea");
  await p.fill("input[name=subject]", "Tambaya");
  await p.fill("textarea", "Ina son sanin lokacin zaɓe.");
  await p.click('button:has-text("Aika")');
  await toast(p, /An aika/);
  await visit(p, s.base + "/#/invite");
  await p.waitForSelector("h1:has-text('Gayyaci abokai, ka sami kuɗi')");
  await visit(p, s.base + "/#/wallet");
  await p.click("summary:has-text('Ƙara kuɗi')");
  await p.waitForSelector("text=Biya da");
  await p.click(".history-filter button:has-text('Kuɗin da aka saka')");
  for (const r of ["/#/site", "/#/prizes", "/#/how", "/#/help", "/#/responsible", "/#/about", "/#/past", "/#/centres"]) {
    await visit(p, s.base + r);
    await p.waitForSelector("main h1");
  }
  await visit(p, s.base + "/#/prizes");
  await p.locator(".prize-link").first().click();
  await p.waitForSelector("h2:has-text('Sharuɗɗan karɓa')");

  // A 7-day break: the buying screen explains that play is paused.
  await p.click("#tabs a[data-tab=me]");
  await p.waitForSelector("text=Ɗauki hutun kwana 7");
  await p.click("text=Ɗauki hutun kwana 7");
  await toast(p, /Hutun kwana 7 ya fara/);
  await visit(p, s.base + "/#/buy");
  await p.waitForSelector("text=Kana hutu daga wasa");
  await visit(p, s.base + "/#/home");
  await p.waitForSelector(".hero");

  assert.deepEqual(await untranslated(p, serverData), [], "text shown in English in Hausa mode");
  await assertClean(p, "Hausa screens");
  // Hausa phrases are longer than the English: every screen must still fit a small phone.
  await assertFits(p, s.base, ["/#/home", "/#/cards", "/#/wallet", "/#/draw", "/#/me", "/#/inbox", "/#/buy", "/#/support", "/#/demo", "/#/invite", "/#/site", "/#/prizes", "/#/how", "/#/help", "/#/responsible", "/#/about", "/#/past", "/#/centres", "/#/liveness", "/#/rules", "/#/privacy"], "main h1, main .hero");

  // Switching back: everything is English again, and the choice is remembered after a reload.
  await visit(p, s.base + "/#/home");
  await p.waitForSelector(".hero");
  await p.click('.lang button:has-text("English")');
  await p.waitForFunction(async () => (await (await fetch("/v1/me")).json()).language === "en");
  await p.waitForSelector(".hero .tag:has-text('On sale')");
  await p.reload();
  await p.waitForSelector(".hero .tag:has-text('On sale')");
  assert.match(await p.innerText("#tabs"), /Wallet/);
});

test("a returning Hausa player signs in and buys more in Hausa", async () => {
  const { token } = await apiPlayer(s, "08035550303", "Bala Idris");
  const cycleId = (await (await fetch(s.base + "/v1/cycles")).json()).cycles[0].id;
  await apiBuy(s, token, cycleId, 3);
  const p = await newPage(s);
  await p.addInitScript(() => localStorage.setItem("lang", "ha"));
  const serverData = watchServerData(p);
  await p.goto(s.base + "/#/login");
  await p.fill("input[name=phone]", "08035550303");
  await p.fill("input[name=pin]", "000000");
  await p.click('button:has-text("Shiga")');
  await toast(p, /Lambar waya ko PIN ba daidai ba ne/);
  await p.fill("input[name=pin]", "482915");
  await p.click('button:has-text("Shiga")');
  await p.waitForSelector(".hero");
  await visit(p, s.base + "/#/cards");
  await p.waitForSelector("text=kati 3 · 3 ba a karce ba");
  await visit(p, s.base + "/#/draw");
  await p.waitForSelector("text=Yadda muke tabbatar da adalci");
  assert.deepEqual(await untranslated(p, serverData), []);
  await assertClean(p, "returning Hausa player");
});

test("on a new phone, a player who reads Hausa gets the app in Hausa as soon as they sign in", async () => {
  const { token } = await apiPlayer(s, "08035550404", "Yusuf Aliyu");
  await call(s, "PUT", "/v1/me/language", { token, body: { language: "ha" } });
  const p = await newPage(s); // nothing chosen on this phone yet
  await playerSignIn(p, s, "08035550404");
  await p.waitForSelector(".hero .tag:has-text('Ana sayarwa')");
  assert.match(await p.innerText("#tabs"), /Jakar kuɗi/);
  assert.equal(await p.evaluate(() => localStorage.getItem("lang")), "ha");
  await assertClean(p, "new phone");
});
