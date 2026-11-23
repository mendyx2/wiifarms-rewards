// Staff operations in the admin app, each needing two people where it matters:
// refunds, cancelling a cycle, finance, staff access, and licences.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminSignIn, answerDialogs, apiBuy, apiPlayer, assertClean, call, newPage, playerSignIn, startStack, toast, visit, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("refund one purchase, then cancel the whole cycle: requested by one person, decided by another, and the player sees it", async () => {
  const p1 = await apiPlayer(s, "08037770011", "Bala Garba");
  const p2 = await apiPlayer(s, "08037770012", "Ngozi Eze");
  await apiBuy(s, p1.token, s.demoCycleId, 3);
  await apiBuy(s, p2.token, s.demoCycleId, 2);
  const a = await newPage(s, "desktop");
  answerDialogs(a, () => "Supplier cannot deliver the motorcycle");

  // Compliance finds the purchase by phone number and asks for a refund; it cannot approve it.
  await adminSignIn(a, s, "compliance");
  await visit(a, s.base + "/admin#/refunds");
  await a.fill("input[name=phone]", "0803 777 0011");
  await a.click('button:has-text("Search")');
  await a.waitForSelector('button:has-text("Request refund")');
  await a.fill('form:has(button:has-text("Request refund")) input[name=note]', "Buyer is related to a staff member");
  await a.click('button:has-text("Request refund")');
  await toast(a, /Finance must approve it/);
  assert.equal(await a.locator('button:has-text("Approve")').count(), 0);

  // Finance approves it from the approvals queue.
  await adminSignIn(a, s, "finance");
  await a.waitForSelector("#apCount:not([hidden])");
  await visit(a, s.base + "/admin#/approvals");
  await a.click('.card:has(th:has-text("Reason")) button:has-text("Approve")');
  await toast(a, /Refunded to the original payment/);

  const p = await newPage(s);
  await playerSignIn(p, s, p1.phone);
  await p.click("#tabs a[data-tab=cards]");
  await p.waitForSelector(".ticket");
  assert.deepEqual(await p.locator(".ticket b").allInnerTexts(), ["Cancelled", "Cancelled", "Cancelled"]);
  await visit(p, s.base + "/#/me");
  await p.click('summary:has-text("My purchases")');
  assert.match(await p.locator("details .row").first().innerText(), /Refunded — not eligible to buy/);
  await assertClean(p, "player after refund");

  // Cancelling the cycle: a cycle manager asks; neither they nor a payout approver can approve; Compliance does.
  await adminSignIn(a, s, "manager");
  await visit(a, s.base + "/admin#/cycle/" + s.demoCycleId);
  await a.fill('form:has(button:has-text("Request cancellation")) input[name=reason]', "Supplier cannot deliver the motorcycle");
  await a.click('button:has-text("Request cancellation")');
  await toast(a, /A second person must approve it/);
  assert.equal(await a.locator('button:has-text("Approve cancellation")').count(), 0);
  await adminSignIn(a, s, "approver");
  await visit(a, s.base + "/admin#/cycle/" + s.demoCycleId);
  await a.waitForSelector("h2:has-text('Cancellation')");
  assert.equal(await a.locator('button:has-text("Approve cancellation")').count(), 0);
  await adminSignIn(a, s, "compliance");
  await visit(a, s.base + "/admin#/approvals");
  await a.click('.card:has(th:has-text("Status")) a:has-text("Review")');
  await a.click('button:has-text("Approve cancellation")');
  assert.match(await toast(a, /Cycle cancelled/), /1 purchase refunded \(₦400\)/);
  assert.match(await a.innerText(".note.bad"), /requested by Demo manager, approved by Demo compliance/);

  const q = await newPage(s);
  await playerSignIn(q, s, p2.phone);
  assert.match(await q.innerText(".hero .tag"), /Cancelled/);
  assert.match(await q.innerText(".note.warn"), /refunded in full to the payment it came from/);
  await q.click("#tabs a[data-tab=draw]");
  await q.waitForSelector(".pill:has-text('Cancelled')");
  await assertClean(q, "player after cancellation");
  await assertClean(a, "refunds and cancellation (admin)");
});

test("finance: reconcile a day against a statement, sign off with an explanation, record and reverse expenses, download a safe spreadsheet", async () => {
  const a = await newPage(s, "desktop");
  answerDialogs(a, () => "Statement ₦1 short; query raised with the provider");
  await adminSignIn(a, s, "finance");
  await visit(a, s.base + "/admin#/finance");
  await a.waitForSelector("h2:has-text('Daily reconciliation')");
  await a.click('.note.bad button:has-text("Reconcile")');
  await toast(a, /matched/);
  const rf = a.locator('form:has-text("Reconcile a day")');
  const collected = (await a.locator('.card:has(th:has-text("Payment records")) tr').nth(1).locator("td").nth(1).innerText()).match(/₦([\d,]+) in/)![1]!.replace(/,/g, "");
  await rf.locator("input[name=sc]").fill(String(Number(collected) - 1));
  await rf.locator("input[name=sr]").fill("0");
  await rf.locator("input[name=sp]").fill("0");
  await rf.locator("button").click();
  await toast(a, /DOES NOT MATCH/);
  await a.click('.card:has(th:has-text("Payment records")) button:has-text("Sign off")');
  await toast(a, /signed off/);
  await a.waitForSelector("text=Signed off by");

  const ef = () => a.locator('form:has-text("Record an expense")');
  await ef().locator("select[name=category]").selectOption("OTHER");
  await ef().locator("input[name=amount]").fill("12000");
  await ef().locator("input[name=description]").fill("Duplicate entry");
  await ef().locator("button").click();
  await toast(a, /Expense recorded/);
  await a.click('tr:has-text("Duplicate entry") button:has-text("Reverse")');
  await toast(a, /Both entries stay on record/);
  await ef().locator("select[name=category]").selectOption("MARKETING");
  await ef().locator("input[name=amount]").fill("75000");
  await ef().locator("input[name=payee]").fill("=HYPERLINK(\"http://evil.example\")");
  await ef().locator("input[name=description]").fill("Radio adverts");
  await ef().locator("button").click();
  await toast(a, /Expense recorded/);
  assert.match(await a.locator('.tile:has-text("Operating expenses") b').innerText(), /₦75,000/);

  const [dl] = await Promise.all([a.waitForEvent("download"), a.locator('a:has-text("Download spreadsheet")').nth(1).click()]);
  const csv = readFileSync(await dl.path(), "utf8");
  assert.equal(dl.suggestedFilename(), "operating-expenses.csv");
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"")"`), "a formula typed by staff is neutralised");
  assert.ok(csv.includes(",-12000,"), "the reversal is a negative number");
  await assertClean(a, "finance");

  await adminSignIn(a, s, "auditor");
  await visit(a, s.base + "/admin#/finance");
  await a.waitForSelector("h2:has-text('Operating expenses')");
  assert.equal(await a.locator('main button:has-text("Sign off"), main button:has-text("Reverse"), form:has-text("Record an expense")').count(), 0, "auditors only look");
  await adminSignIn(a, s, "approver");
  await visit(a, s.base + "/admin#/finance");
  await a.waitForSelector("main p.sub");
  assert.match(await a.innerText("main p.sub"), /does not include finance/);
});

test("staff access and licences: two security administrators for a role, immediate disabling, verification by someone else", async () => {
  const a = await newPage(s, "desktop");
  answerDialogs(a, () => "Left the company");
  const row = (name: string) => a.locator(`.card:has(th:has-text("Last sign-in")) tr:has-text("${name}")`);
  await adminSignIn(a, s, "security");
  await visit(a, s.base + "/admin#/access");
  await a.fill('form:has-text("New staff account") input[name=name]', "Grace Okafor");
  await a.fill('form:has-text("New staff account") input[name=email]', "grace@demo.wiifarm.test");
  await a.click('button:has-text("Create account")');
  await toast(a, /no roles/);
  await row("Grace Okafor").locator("summary").click();
  await row("Grace Okafor").locator("select[name=change]").selectOption("GRANT_ROLE:SUPPORT");
  await row("Grace Okafor").locator("input[name=reason]").fill("Joins customer support");
  await row("Grace Okafor").locator('button:has-text("Request")').click();
  await toast(a, /Another security administrator must approve it/);
  assert.equal(await a.locator('.card:has-text("Waiting for a decision") button:has-text("Approve")').count(), 0);

  await adminSignIn(a, s, "security2");
  await visit(a, s.base + "/admin#/access");
  await a.click('.card:has-text("Waiting for a decision") button:has-text("Approve")');
  await toast(a, /in effect/);
  await a.waitForSelector('tr:has-text("Grace Okafor") .pill:has-text("Support")');
  await row("Grace Okafor").locator("summary").click();
  await row("Grace Okafor").locator('button:has-text("Disable now")').click();
  await toast(a, /disabled and signed out/);
  const signIn = await fetch(s.base + "/v1/admin/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "grace@demo.wiifarm.test" }) });
  assert.equal(signIn.status, 401);

  await adminSignIn(a, s, "compliance");
  await visit(a, s.base + "/admin#/access");
  assert.equal(await a.locator('summary:has-text("Change access")').count(), 0, "Compliance sees access but cannot change it");
  const lf = a.locator('form:has-text("Record a licence")');
  await lf.locator("input[name=authority]").fill("Niger State Lottery Board (sample)");
  await lf.locator("input[name=number]").fill("NSLB-2027-001");
  await lf.locator("input[name=from]").fill(new Date(Date.now() - 864e5).toISOString().slice(0, 10));
  await lf.locator("input[name=to]").fill(new Date(Date.now() + 300 * 864e5).toISOString().slice(0, 10));
  await lf.locator("input[name=doc]").fill("docs/licences/NSLB-2027-001.pdf");
  await lf.locator("button").click();
  await toast(a, /Someone else must verify it/);
  assert.equal(await a.locator('.card:has-text("Licences") button:has-text("Verify")').count(), 0, "the recorder cannot verify");
  assert.equal(await a.locator('.tile:has-text("Niger State licence") b').innerText(), "None in force");

  await adminSignIn(a, s, "finance");
  await visit(a, s.base + "/admin#/access");
  await a.click('button:has-text("Verify")');
  await toast(a, /Verified/);
  await a.waitForSelector('.tile:has-text("Niger State licence") b:has-text("In force")');
  assert.equal(await a.locator('.tile:has-text("Real-money sales") b').innerText(), "Not available");
  await assertClean(a, "access and licences");
});

test("next-of-kin claim: Compliance opens the case, the winner is told, someone else approves after the wait, the claimant sees the prize", async () => {
  const { seedDemo } = await import("@wiifarm/api/seed-demo.ts");
  const { cycleId } = await seedDemo(s.ctx, { name: "Kin Cycle" });
  const winner = await apiPlayer(s, "08037770031", "Musa Bello");
  const claimant = await apiPlayer(s, "08037770032", "Aisha Bello");
  await call(s, "PUT", "/v1/me/next-of-kin", { token: winner.token, body: { fullName: "Aisha Bello", relationship: "Daughter", phone: claimant.phone } });
  await apiBuy(s, winner.token, cycleId, 1);
  // The winner's card won a freezer in the final draw (set up directly: the draw itself is covered by the lifecycle test).
  await s.pool.query(`INSERT INTO prize_claims (ticket_id, stage, prize_tier_id, user_id, status, expires_at)
    SELECT t.id, 'FINAL_DRAW', pt.id, t.owner_id, 'ENTITLED', now() + interval '20 days' FROM tickets t
    JOIN prize_tiers pt ON pt.cycle_id = t.cycle_id AND pt.title = 'Solar freezer 200L' WHERE t.cycle_id = $1 AND t.owner_id IS NOT NULL LIMIT 1`, [cycleId]);

  const a = await newPage(s, "desktop");
  answerDialogs(a, () => "reason");
  await adminSignIn(a, s, "compliance");
  await visit(a, s.base + "/admin#/nok");
  await a.fill('form:has-text("Find the winner") input[name=phone]', winner.phone);
  await a.click('button:has-text("Look up")');
  await a.waitForSelector('.tile:has-text("Next of kin on record") b:has-text("Aisha Bello")');
  assert.match(await a.innerText(".card:has(th:has-text('Prize waiting'))"), /Solar freezer 200L/);
  await a.fill("input[name=claimant]", claimant.phone);
  await a.fill("textarea[name=docs]", "Death certificate NPC/2026/1123\nClaimant NIN slip");
  await a.fill("textarea[name=note]", "Documents seen at the Minna office");
  await a.click('button:has-text("Open case")');
  await toast(a, /Case opened/);
  await visit(a, s.base + "/admin#/nok");
  await a.waitForSelector('.pill:has-text("Waiting until")');
  const w = await call(s, "GET", "/v1/notifications", { token: winner.token });
  assert.ok(w.items.some((i: any) => i.title === "Someone has asked to claim your prizes"), "the winner is told first");

  // A week passes without the winner signing in.
  await s.pool.query("UPDATE next_of_kin_cases SET opened_at = now() - interval '8 days'");
  await s.pool.query("UPDATE sessions SET created_at = now() - interval '9 days' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348037770031')");
  await visit(a, s.base + "/admin#/nok");
  await a.waitForSelector('.pill:has-text("Needs someone else")'); // the person who opened it cannot decide
  await adminSignIn(a, s, "finance");
  await visit(a, s.base + "/admin#/nok");
  await a.click('.card:has(th:has-text("Claimant")) button:has-text("Approve")');
  assert.match(await toast(a, /Approved/), /1 prize\(s\)/);
  await assertClean(a, "next-of-kin (admin)");

  const p = await newPage(s);
  await playerSignIn(p, s, claimant.phone);
  await visit(p, s.base + "/#/wallet");
  await p.waitForSelector("text=Passed to you as next of kin");
  assert.match(await p.innerText('.card:has-text("Solar freezer 200L")'), /Ready to claim/);
  await assertClean(p, "next-of-kin (claimant)");
});

test("support: the player asks for help, support replies, and an account is locked by one person and unlocked by another", async () => {
  const pl = await apiPlayer(s, "08037770041", "Chidi Okeke");
  const p = await newPage(s);
  await playerSignIn(p, s, pl.phone);
  await p.click("#tabs a[data-tab=me]");
  await p.click("text=Help and support");
  await p.waitForSelector("text=Support will never ask for your PIN");
  await p.selectOption("select[name=topic]", "PAYMENT");
  await p.fill("input[name=subject]", "Paid but no cards");
  await p.fill("textarea[name=message]", "I paid N1,000 this morning and got no cards.");
  await p.click('button:has-text("Send")');
  await toast(p, /We will reply here/);
  await p.waitForSelector('summary:has-text("Paid but no cards") .pill:has-text("Waiting for support")');

  const a = await newPage(s, "desktop");
  answerDialogs(a, () => "Player called from a new phone; says their old phone was stolen");
  await adminSignIn(a, s, "support");
  await visit(a, s.base + "/admin#/support");
  await a.click('a:has-text("Paid but no cards")');
  await a.waitForSelector("text=I paid N1,000 this morning");
  await a.fill("textarea[name=message]", "Your payment was refunded automatically because the cards sold out while you paid.");
  await a.click('button:has-text("Send reply")');
  await toast(a, /Reply sent/);

  await visit(p, s.base + "/#/support");
  await p.waitForSelector('summary:has-text("Paid but no cards") .pill:has-text("Support replied")');
  assert.match(await p.innerText("details[open]"), /WiiFarm support[\s\S]*refunded automatically/);
  await p.fill("details[open] textarea[name=message]", "Thank you, I see the refund.");
  await p.click('details[open] button:has-text("Send")');
  await toast(p, /Sent/);
  await assertClean(p, "support (player)");

  // A suspected takeover: support locks the account at once; only a different Compliance officer can unlock it.
  await visit(a, s.base + "/admin#/support");
  await a.fill('form:has-text("Find a player") input[name=phone]', pl.phone);
  await a.click('button:has-text("Look up")');
  await a.waitForSelector('.tile b:has-text("Chidi Okeke")');
  assert.equal((await a.content()).includes(pl.phone.slice(1)), false, "the full phone number is never shown");
  await a.click('button:has-text("Lock account")');
  await toast(a, /Account locked/);
  await a.waitForSelector("text=Locked by Demo support");
  assert.equal(await a.locator('button:has-text("Unlock")').count(), 0, "support cannot unlock");
  await visit(p, s.base + "/#/wallet");
  await p.waitForSelector("h1:has-text('Create your account'), h1:has-text('Sign in')"); // signed out at once
  await adminSignIn(a, s, "compliance");
  await visit(a, s.base + "/admin#/support");
  await a.fill('form:has-text("Find a player") input[name=phone]', pl.phone);
  await a.click('button:has-text("Look up")');
  await a.waitForSelector("text=Locked by Demo support");
  await a.click('button:has-text("Unlock")');
  await toast(a, /unlocked/);
  await playerSignIn(p, s, pl.phone);
  await assertClean(a, "support (admin)");
});
