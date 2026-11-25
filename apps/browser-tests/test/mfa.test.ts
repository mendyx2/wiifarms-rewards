// Two-step sign-in for staff, in the browser, with it required as in
// production: first sign-in sets up an authenticator app from a QR code and
// shows the recovery codes once; later sign-ins ask for a code.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, stepAt, totpCode } from "@wiifarm/api/totp.ts";
import { answerDialogs, assertClean, newPage, startStack, toast, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack({ mfa: true }); });
after(async () => { await s?.stop(); });

test("first sign-in sets up the authenticator from a QR code; later sign-ins need a fresh code", async () => {
  const a = await newPage(s, "desktop");
  answerDialogs(a);
  const signIn = async () => {
    await a.goto(s.base + "/admin");
    await a.waitForSelector("input[name=email]");
    await a.fill("input[name=email]", "auditor@demo.wiifarm.test");
    await a.click('button:has-text("Sign in")');
  };
  await signIn();
  await a.waitForSelector("h1:has-text('Set up two-step sign-in')");
  assert.match((await a.getAttribute(".qr img", "src"))!, /^data:image\/svg\+xml;base64,/);
  const secret = base32Decode((await a.innerText(".key")).trim());
  const code = (offset = 0) => totpCode(secret, stepAt(Date.now()) + offset);
  await a.fill("input[name=code]", code() === "000000" ? "000001" : "000000");
  await a.click('button:has-text("Confirm")');
  await toast(a, /not correct/);
  await a.fill("input[name=code]", code());
  await a.click('button:has-text("Confirm")');
  await a.waitForSelector("h1:has-text('Save your recovery codes')");
  assert.equal(await a.locator(".recovery code").count(), 10);
  await a.click("text=I have saved them");
  await a.waitForSelector("h1:has-text('Dashboard')");
  await a.click("#signOut");

  // Next time: a code is asked for; the one already used is refused.
  await signIn();
  await a.waitForSelector("h1:has-text('Two-step sign-in')");
  await a.fill("input[name=code]", code());
  await a.click('button:has-text("Sign in")');
  await toast(a, /not correct/);
  await a.fill("input[name=code]", code(1));
  await a.click('button:has-text("Sign in")');
  await a.waitForSelector("h1:has-text('Dashboard')");
  await a.click("#nav a[data-nav=access]");
  await a.waitForSelector("tr:has-text('Demo auditor') >> text=Set up");
  await assertClean(a, "two-step sign-in");
});
