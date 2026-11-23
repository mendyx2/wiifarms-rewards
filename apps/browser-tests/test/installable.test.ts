// The installable app: what Android and iPhone need to put it on the home
// screen, the offline screen and its recovery, and — for safety — that the
// copy kept on the phone holds only the app's public files, never player data.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { apiBuy, apiPlayer, assertClean, newPage, playerSignIn, startStack, type Stack } from "./harness.ts";

let s: Stack;
before(async () => { s = await startStack(); });
after(async () => { await s?.stop(); });

test("the app can be installed, opens offline with a clear screen, recovers by itself, and keeps no player data on the phone", async () => {
  // What the phone needs to offer installing: a manifest with real PNG icons, including a maskable one.
  const manifest = await (await fetch(s.base + "/manifest.webmanifest")).json();
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  for (const [size, purpose] of [["192x192", "any"], ["512x512", "any"], ["512x512", "maskable"]]) {
    const icon = manifest.icons.find((i: any) => i.sizes === size && i.purpose === purpose);
    assert.ok(icon, `icon ${size} ${purpose}`);
    const r = await fetch(s.base + icon.src);
    assert.equal(r.headers.get("content-type"), "image/png");
    const png = Buffer.from(await r.arrayBuffer());
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, size, `${icon.src} is really ${size}`);
  }
  assert.equal((await fetch(s.base + "/apple-touch-icon.png")).status, 200);

  const { token } = await apiPlayer(s, "08037770101", "Safiya Musa");
  const cycleId = (await (await fetch(s.base + "/v1/cycles")).json()).cycles[0].id;
  await apiBuy(s, token, cycleId, 2);

  const p = await newPage(s);
  await p.goto(s.base + "/");
  await p.waitForSelector(".hero");
  assert.equal(await p.evaluate(async () => !!(await navigator.serviceWorker.ready).active), true, "service worker running");
  await playerSignIn(p, s, "08037770101");
  await p.goto(s.base + "/#/cards");
  await p.waitForSelector(".ticket");
  await p.goto(s.base + "/#/wallet");
  await p.waitForSelector(".balance");

  // Only the app's own public files are kept — no API answers, no staff app.
  const kept: string[] = await p.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) out.push(new URL(r.url).pathname);
    return out.sort();
  });
  assert.ok(kept.includes("/") && kept.includes("/js/app.js"), "the app itself is kept");
  assert.deepEqual(kept.filter((u) => u.startsWith("/v1/") || u.startsWith("/admin")), [], "no player data or staff app kept");

  // Offline: the app still opens, says so plainly, and keeps the tab bar.
  await p.context().setOffline(true);
  await p.reload();
  await p.waitForSelector("h1:has-text('You are offline')");
  assert.equal(await p.locator("#tabs a").count(), 5);
  await p.click("#tabs a[data-tab=cards]");
  await p.waitForSelector("h1:has-text('You are offline')");

  // Back online: the screen updates by itself, still signed in.
  await p.context().setOffline(false);
  await p.waitForSelector(".ticket", { timeout: 15_000 });

  // The offline screen is in Hausa for a Hausa player.
  await p.evaluate(() => localStorage.setItem("lang", "ha"));
  await p.context().setOffline(true);
  await p.reload();
  await p.waitForSelector("h1:has-text('Ba ka da haɗin intanet')");
  await p.context().setOffline(false);
  await p.evaluate(() => localStorage.setItem("lang", "en"));

  // The admin app is never served from the phone's copy.
  await p.context().setOffline(true);
  const adminOffline = await p.evaluate(async () => { try { await fetch("/admin/"); return "served"; } catch { return "failed"; } });
  assert.equal(adminOffline, "failed");
  await p.context().setOffline(false);

  await assertClean(p, "installable app");
});

test("Android's install prompt is offered on request, and can be put off for good on the home screen", async () => {
  const p = await newPage(s);
  await p.goto(s.base + "/#/me");
  await p.waitForSelector("h1:has-text('My account')");
  assert.equal(await p.locator(".install").count(), 0, "nothing offered until the phone allows installing");

  // Chrome on Android fires this event when the app can be installed.
  await p.evaluate(() => {
    const e: any = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = async () => { (window as any).__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(e);
  });
  await p.click('.install button:has-text("Add to home screen")');
  await p.waitForFunction(() => (window as any).__prompted === true);
  // Once used, the prompt is gone (the phone offers it again only if the player declines).
  await p.waitForSelector(".install", { state: "detached", timeout: 5000 });

  await p.evaluate(() => {
    const e: any = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = async () => {}; e.userChoice = Promise.resolve({ outcome: "dismissed" });
    window.dispatchEvent(e);
  });
  await p.goto(s.base + "/#/home");
  await p.waitForSelector(".install");
  await p.click('.install button:has-text("Not now")');
  assert.equal(await p.locator(".install").count(), 0);
  await p.reload();
  await p.waitForSelector(".hero");
  await p.evaluate(() => {
    const e: any = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = async () => {}; e.userChoice = Promise.resolve({ outcome: "dismissed" });
    window.dispatchEvent(e);
  });
  await p.goto(s.base + "/#/me");
  await p.waitForSelector(".install"); // the prompt is available, and still offered on the Me page for someone who changes their mind
  await p.goto(s.base + "/#/home");
  await p.waitForSelector(".hero");
  await p.waitForLoadState("networkidle");
  assert.equal(await p.locator(".install").count(), 0, "not offered again on the home screen after Not now");
  await assertClean(p, "install prompt");
});
