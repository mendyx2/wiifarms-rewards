// The independent draw report (SRS DRW-010) in the browser: generated in the
// admin app, attested by the appointed auditor, and read by a player.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { adminSignIn, answerDialogs, apiPlayer, assertClean, newPage, playerSignIn, startStack, toast, visit, wonPrize, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("the draw report is generated, attested by the auditor and published to players", async () => {
  const { token } = await apiPlayer(s, "08037770909", "Bilkisu Ahmed");
  const cycleId = await wonPrize(s, token);

  const a = await newPage(s, "desktop");
  answerDialogs(a, () => "I have reviewed the draw records and re-run the draw; this report is accurate.");
  await adminSignIn(a, s, "manager");
  await visit(a, s.base + `/admin#/cycle/${cycleId}`);
  await a.click('button:has-text("Generate the draw report")');
  await toast(a, /every check passed/);
  await a.waitForSelector("text=Waiting for the appointed auditor to attest.");
  const fingerprint = (await a.innerText("text=/Fingerprint \\(SHA-256\\)/")).split(": ")[1]!.trim();
  assert.match(fingerprint, /^[0-9a-f]{64}$/);

  await adminSignIn(a, s, "auditor");
  await visit(a, s.base + `/admin#/cycle/${cycleId}`);
  await a.click('button:has-text("Attest this report")');
  await toast(a, /Attested and published/);
  await a.waitForSelector("text=/Attested by Demo auditor/");
  await assertClean(a, "draw report (admin)");

  // The player reads it from the draw centre.
  const p = await newPage(s);
  await playerSignIn(p, s, "08037770909");
  await visit(p, s.base + `/#/draw-report/${cycleId}`);
  await p.waitForSelector("h1:has-text('Independent draw report')");
  await p.waitForSelector("text=Attested by Demo auditor, independent auditor");
  await p.waitForSelector("text=Every check in this report passed.");
  assert.ok((await p.innerText("main")).includes(fingerprint));
  assert.equal(await p.locator(".check .tick.no").count(), 1, "only the engine-certification check is open in a simulation");
  await assertClean(p, "draw report (player)");
});
