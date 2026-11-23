// Service worker for the player app: lets it open, and say clearly that it is
// offline, when there is no connection.
//
// What it keeps on the phone: only the app's own public files (page, styles,
// scripts, icons, language file) — never anything from the API, so no
// personal data, balances or card results are ever stored by it. Requests to
// /v1/ and to the staff app are not touched at all.
//
// It always tries the network first, so a player gets the newest version of
// the app whenever they are online; the saved copy is used only when offline.

const CACHE = "wiifarm-shell-v1";
const SHELL = ["/", "/app.css", "/js/app.js", "/js/api.js", "/js/verify.js", "/js/i18n.js", "/icon.svg", "/icon-192.png", "/apple-touch-icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/") || url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return;
  const key = req.mode === "navigate" ? "/" : url.pathname;
  if (!SHELL.includes(key)) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return res;
    } catch {
      const saved = await caches.match(key);
      if (saved) return saved;
      throw new Error("offline and not saved");
    }
  })());
});
