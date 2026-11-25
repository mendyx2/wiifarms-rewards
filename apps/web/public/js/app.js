// WiiFarm Rewards player app. No framework and no third-party code: small to
// download on a slow connection, and nothing here builds HTML from text, so
// content from the server can never run as script.
import { api, clearKey, stableKey } from "/js/api.js";
import { verifyCycle, verifyDraw, verifyTicket } from "/js/verify.js";
import { chosenHere, count as countOf, formatDate, lang, setLang, tr } from "/js/i18n.js";

const view = document.getElementById("view");
const state = { me: null, cycles: [], cycleId: null, cycle: null };

// The cycle the player last chose or bought into is remembered on this device,
// so they come back to its cards and its draw even after sales close.
const remembered = () => { try { return localStorage.getItem("cycle"); } catch { return null; } };
const remember = (id) => { state.cycleId = id; try { localStorage.setItem("cycle", id); } catch { /* storage unavailable */ } };

// --- Small helpers ----------------------------------------------------------------

const TRANSLATED_ATTRS = new Set(["placeholder", "aria-label", "title"]);

/** Creates an element. Text is always inserted as text, never parsed as HTML, and passes through tr() for the player's language. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "hidden" || k === "disabled" || k === "selected" || k === "open") node[k] = Boolean(v);
    else node.setAttribute(k, v === true ? "" : TRANSLATED_ATTRS.has(k) ? tr(String(v)) : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(typeof c === "string" ? tr(c) : String(c)));
  }
  return node;
}

const naira = (kobo) => "₦" + (kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });
const when = formatDate;
const plural = countOf;
const cashOf = (outcome) => { const m = /^CASH:(\d+)$/.exec(outcome); return m ? Number(m[1]) : 0; };

function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = tr(message);
  t.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 3500);
}

/** English / Hausa switch. The choice is kept on this phone. */
function langSwitch() {
  const pick = (l) => () => {
    setLang(l); frame(); render();
    // Texts and messages from us follow the same choice.
    if (state.me) { state.me.language = l; api.put("/v1/me/language", { language: l }).catch(() => {}); }
  };
  return el("div", { class: "lang", role: "group", "aria-label": "Language" },
    el("button", { type: "button", "aria-pressed": String(lang() === "en"), onclick: pick("en") }, "English"),
    el("button", { type: "button", "aria-pressed": String(lang() === "ha"), onclick: pick("ha") }, "Hausa"));
}

/** Translates the fixed parts of the page (banner, tab labels), keeping the English to translate from. */
function frame() {
  for (const node of [document.getElementById("modeBanner"), ...document.querySelectorAll("#tabs a")]) {
    const text = [...node.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!text) continue;
    text.en ??= text.textContent.trim();
    text.textContent = tr(text.en);
  }
}

const go = (route) => { if (location.hash === "#/" + route) render(); else location.hash = "#/" + route; };

/**
 * Wraps a button handler: the button is disabled while the request runs (so a
 * double tap cannot send it twice) and any error is shown in plain words.
 */
function action(fn) {
  return async (event) => {
    event.preventDefault();
    const btn = event.currentTarget instanceof HTMLFormElement ? event.submitter : event.currentTarget;
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await fn(event);
    } catch (err) {
      // A 401 means an expired session only when the player was signed in; on the sign-in screen it is a wrong PIN.
      if (err.status === 401 && state.me) { state.me = null; toast("Please sign in again."); go("login"); }
      // A major prize or a large withdrawal needs the selfie check first; come back here afterwards.
      else if (err.code === "LIVENESS_REQUIRED") { state.afterLiveness = location.hash; go("liveness"); }
      else toast(err.message || "Something went wrong. Please try again.");
    } finally {
      if (btn?.isConnected) btn.disabled = false;
    }
  };
}

const field = (label, input) => { const id = "f" + Math.random().toString(36).slice(2); input.id = id; return [el("label", { for: id }, label), input]; };
const val = (form, name) => form.elements[name].value.trim();

// --- Data ---------------------------------------------------------------------------

async function loadMe() {
  try {
    const me = await api.get("/v1/me");
    if (state.me?.id !== me.id) state.invite = undefined; // a different player on this phone
    if (me.language !== lang()) {
      // A choice made on this phone is kept and passed on to the account; on a new phone the account's choice is used.
      if (chosenHere()) { me.language = lang(); api.put("/v1/me/language", { language: lang() }).catch(() => {}); }
      else { setLang(me.language); frame(); }
    }
    state.me = { ...me, balanceKobo: (await api.get("/v1/wallet")).balanceKobo };
  } catch (err) {
    if (err.status !== 401) throw err;
    state.me = null;
    state.invite = undefined;
  }
  const bal = document.getElementById("topBal");
  bal.hidden = !state.me;
  if (state.me) bal.textContent = naira(state.me.balanceKobo);
  await refreshBell();
}

async function refreshBell() {
  const bell = document.getElementById("bell"), count = document.getElementById("bellCount");
  bell.hidden = !state.me;
  if (!state.me) return;
  const unread = (await api.get("/v1/notifications").catch(() => ({ unread: 0 }))).unread;
  count.hidden = unread === 0;
  count.textContent = unread > 9 ? "9+" : String(unread);
  bell.setAttribute("aria-label", tr(unread ? `Messages, ${unread} unread` : "Messages"));
}

async function inbox() {
  const box = await api.get("/v1/notifications");
  const nodes = [el("h1", {}, "Messages"),
    el("p", { class: "muted" }, "Wins, payouts, deliveries and account alerts. Important ones also come by text message. We will never ask for your PIN or a code.")];
  if (!box.items.length) nodes.push(el("div", { class: "card" }, el("p", { class: "muted" }, "No messages yet.")));
  else nodes.push(el("div", { class: "card" }, box.items.map((m) => el(m.link ? "a" : "div", { class: "msg row" + (m.read_at ? "" : " unread"), href: m.link ?? null },
    el("div", {}, el("b", {}, m.title), el("small", {}, m.body), el("small", {}, when(m.created_at)))))));
  // Seen now: clear the badge (the list above still shows which were new).
  if (box.unread) api.post("/v1/notifications/read", {}).then(refreshBell).catch(() => {});
  return nodes;
}

async function loadCycle() {
  state.cycles = (await api.get("/v1/cycles")).cycles;
  const chosen = state.cycles.find((c) => c.id === (state.cycleId ?? remembered())) ?? state.cycles.find((c) => c.status === "OPEN") ?? state.cycles[0];
  state.cycleId = chosen?.id ?? null;
  state.cycle = chosen ? await api.get("/v1/cycles/" + chosen.id) : null;
  return state.cycle;
}

const myTickets = () => api.get("/v1/tickets?cycleId=" + state.cycleId).then((r) => r.tickets);

/** Where "Buy" should lead, depending on how far the player has got. */
const nextStep = () => (!state.me ? "signup" : state.me.kycTier < 1 ? "verify" : "buy");

// --- Scratch surface (presentation only) ------------------------------------------------

/**
 * A scratch-off surface over `resultNode`. It only controls what is visible:
 * the outcome is decided by the server long before, and `onStart` merely asks
 * the server to disclose it. The surface clears once the player has scratched
 * enough AND the result has arrived.
 */
function scratchSurface(resultNode, { onStart, onDone }) {
  const canvas = el("canvas", { "aria-label": "Scratch surface. Use the Reveal now button if you prefer." });
  const wrap = el("div", { class: "scratchwrap" }, el("div", { class: "result" }, resultNode), canvas);
  const ctx = canvas.getContext("2d");
  let down = false, moves = 0, started = false, ready = false, enough = false, done = false;

  function paint() {
    const r = wrap.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    canvas.width = r.width * d; canvas.height = r.height * d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    // Silver scratch foil: brushed metal, fine grit, a diagonal sheen and an embossed label.
    const g = ctx.createLinearGradient(0, 0, r.width, r.height);
    g.addColorStop(0, "#a3abaf"); g.addColorStop(0.3, "#e4e8ea"); g.addColorStop(0.5, "#b9c0c4"); g.addColorStop(0.72, "#f0f2f3"); g.addColorStop(1, "#9aa2a6");
    ctx.fillStyle = g; ctx.fillRect(0, 0, r.width, r.height);
    for (let y = 0; y < r.height; y += 2) { ctx.fillStyle = `rgba(255,255,255,${0.04 + 0.05 * Math.random()})`; ctx.fillRect(0, y, r.width, 1); }
    for (let i = 0; i < r.width * r.height / 40; i++) {
      ctx.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,.35)" : "rgba(60,66,70,.18)";
      ctx.fillRect(Math.random() * r.width, Math.random() * r.height, 1, 1);
    }
    const sheen = ctx.createLinearGradient(0, 0, r.width, r.height);
    sheen.addColorStop(0.35, "rgba(255,255,255,0)"); sheen.addColorStop(0.5, "rgba(255,255,255,.45)"); sheen.addColorStop(0.65, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen; ctx.fillRect(0, 0, r.width, r.height);
    const label = tr("Scratch here"), cx = r.width / 2, cy = r.height / 2 + 8;
    ctx.font = "800 24px system-ui"; ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillText(label, cx, cy + 1.5);
    ctx.fillStyle = "rgba(55,62,66,.75)"; ctx.fillText(label, cx, cy);
    ctx.font = "22px system-ui"; ctx.fillStyle = "rgba(55,62,66,.55)"; ctx.fillText("✦  ✦  ✦", cx, cy - 34); ctx.fillText("✦  ✦  ✦", cx, cy + 34);
  }
  function finish() {
    if (done || !ready) return;
    done = true;
    canvas.remove();
    onDone();
  }
  function begin() {
    if (started) return;
    started = true;
    onStart().then(() => { ready = true; if (enough) finish(); }, () => { started = false; paint(); });
  }
  function scratchAt(e) {
    const r = canvas.getBoundingClientRect();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000"; // fully opaque, so the foil is removed completely where the finger passes
    ctx.beginPath(); ctx.arc(e.clientX - r.left, e.clientY - r.top, 26, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    if (++moves % 8 === 0) measure();
  }
  function measure() {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let clear = 0, n = 0;
    for (let i = 3; i < data.length; i += 160) { n++; if (data[i] === 0) clear++; }
    if (clear / n > 0.5) { enough = true; finish(); }
  }
  canvas.addEventListener("pointerdown", (e) => { down = true; canvas.setPointerCapture(e.pointerId); begin(); scratchAt(e); });
  canvas.addEventListener("pointermove", (e) => { if (down) scratchAt(e); });
  canvas.addEventListener("pointerup", () => { down = false; measure(); });
  requestAnimationFrame(paint);
  return { wrap, revealNow() { enough = true; begin(); finish(); } };
}

/** A light tap felt through the phone when a physical-looking control is pressed (where the phone supports it). */
document.addEventListener("pointerdown", (e) => {
  if (e.target instanceof Element && e.target.closest(".btn, .chips button, .qty button, .ticket, nav.tabs a, .lang button")) navigator.vibrate?.(8);
}, { passive: true });

// --- Screens ----------------------------------------------------------------------------

const PRIZE_ICON = (title) => /\bcar\b/i.test(title) ? "🚗" : /motor|bike|vehicle/i.test(title) ? "🏍️" : /freez|fridge/i.test(title) ? "🧊" : /solar|batter/i.test(title) ? "🔋" : /phone/i.test(title) ? "📱" : /rice|vita/i.test(title) ? "🌾" : /cash|₦/i.test(title) ? "💵" : "🎁";
const STATUS_TEXT = { COMMITTED: "Opening soon", OPEN: "On sale", CLOSED: "Sales closed", DRAWN: "Draw complete", SETTLING: "Draw complete", ARCHIVED: "Finished", VOID: "Cancelled" };
const VOID_TEXT = "This cycle was cancelled. Every card was refunded in full to the payment it came from. Instant prizes already revealed have been kept.";

async function home() {
  const c = await loadCycle();
  if (!c) return [langSwitch(), el("h1", {}, "WiiFarm Rewards"), el("div", { class: "card" }, el("p", {}, "No prize cycle is open right now. Please check back soon."))];

  const sold = c.total_tickets - c.tickets_remaining;
  const instant = c.prizes.filter((p) => p.stage === "INSTANT").map((p) => p.cash_kobo);
  const fill = el("i");
  fill.style.width = Math.round((sold / c.total_tickets) * 100) + "%";
  const odds = c.instantWinOdds ? `1 in ${Math.round(c.instantWinOdds.outOf / c.instantWinOdds.winners)}` : "—";

  // A winner is told straight away, whichever cycle the prize came from.
  const waiting = state.me ? (await api.get("/v1/claims")).claims.filter((p) => p.status === "ENTITLED").length : 0;
  const toAcceptKobo = state.me ? (await api.get("/v1/tickets")).tickets
    .filter((t) => t.status === "REVEALED" && t.result?.cashKobo && !t.result.acceptedAt).reduce((s, t) => s + t.result.cashKobo, 0) : 0;
  const activity = c.status === "OPEN" ? await api.get(`/v1/cycles/${c.id}/activity`).catch(() => null) : null;
  const inv = await myInvite();
  setTimeout(() => { if (location.hash === "" || location.hash === "#/home" || location.hash === "#/") popups(c).catch(() => {}); }, 400);
  const nodes = [
    langSwitch(),
    toAcceptKobo ? el("a", { class: "btn gold", href: "#/cards" }, `🎉 You have ${naira(toAcceptKobo)} in winnings to accept`) : null,
    toAcceptKobo ? el("p") : null,
    waiting ? el("a", { class: "btn gold", href: "#/wallet" }, `🎉 You have ${plural(waiting, "prize")} to claim`) : null,
    waiting ? el("p") : null,
    el("div", { class: "hero" },
      el("span", { class: "tag" }, `${c.name} · ${STATUS_TEXT[c.status] ?? c.status}`),
      el("div", { class: "price" }, naira(c.ticket_price_kobo), " ", el("small", {}, "per scratch card")),
      el("div", { class: "bar" }, fill),
      el("div", {}, `${c.tickets_remaining.toLocaleString("en-NG")} of ${c.total_tickets.toLocaleString("en-NG")} cards left`),
      el("div", { class: "facts" },
        el("div", {}, el("b", {}, odds), "cards win instant cash"),
        el("div", {}, el("b", {}, instant.length ? `${naira(Math.min(...instant))} – ${naira(Math.max(...instant))}` : "—"), "instant prizes"),
        el("div", {}, el("b", {}, when(c.sales_close_at)), "or when sold out"),
        el("div", {}, el("b", {}, "Final draw"), when(c.draw_at))),
      c.status === "OPEN" ? countdown("Sales close in", c.sales_close_at) : c.status === "CLOSED" ? countdown("Final draw in", c.draw_at) : null),
    activity && (activity.soldLastHour || activity.recentWins.length) ? el("div", { class: "card live" },
      activity.soldLastHour ? el("div", { class: "row" }, el("b", {}, `🔥 ${activity.soldLastHour.toLocaleString("en-NG")} cards sold in the last hour`)) : null,
      activity.recentWins.slice(0, 5).map((w) => el("div", { class: "row" }, el("span", {}, `🎉 ${naira(w.cashKobo)} won`), el("small", { class: "muted" }, ago(w.at))))) : null,
    el("div", { class: "stack" },
      c.status === "OPEN"
        ? el("a", { class: "btn gold", href: "#/" + nextStep() }, "Buy scratch cards")
        : c.status === "VOID" ? el("div", { class: "note warn" }, VOID_TEXT)
        : el("a", { class: "btn gold", href: "#/draw" }, c.status === "CLOSED" ? "Sales closed — see the draw" : "See the draw"),
      el("a", { class: "btn ghost", href: "#/demo" }, "Try a free demo card")),
    inv ? el("a", { class: "card invite-card", href: "#/invite" }, el("b", {}, "🤝 Invite friends"),
      el("small", {}, "Share WiiFarm Rewards with friends who are 18 or over: every card goes into the final draw.")) : null,
    el("h2", {}, "Final-draw prizes"),
    el("p", { class: "muted" }, "Every card you buy is entered automatically, win or lose."),
    el("div", { class: "prizes" }, c.prizes.filter((p) => p.stage === "FINAL_DRAW").map((p) =>
      el("div", { class: "prize" }, el("div", { class: "pic" }, p.has_image ? el("img", { src: `/v1/prize-images/${p.id}`, alt: p.title, loading: "lazy" }) : PRIZE_ICON(p.title)),
        el("b", {}, p.title), el("span", {}, plural(p.quantity, "winner"))))),
    el("h2", {}, "Instant prizes"),
    el("div", { class: "card" }, c.prizes.filter((p) => p.stage === "INSTANT").map((p) =>
      el("div", { class: "row" }, el("b", {}, naira(p.cash_kobo)), el("span", { class: "muted" }, `${p.quantity.toLocaleString("en-NG")} of ${c.total_tickets.toLocaleString("en-NG")} cards`)))),
    el("h2", {}, "Why you can trust it"),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("div", {}, el("b", {}, "Results fixed before sale"), el("small", {}, "Scratching only reveals what is already set."))),
      el("div", { class: "row" }, el("div", {}, el("b", {}, "Check every card yourself"), el("small", {}, "Your phone checks each result against the fingerprint below."))),
      el("div", { class: "row" }, el("div", {}, el("b", {}, "Independent auditor at the draw"), el("small", {}, "Anyone can re-run the draw afterwards."))),
      el("details", {}, el("summary", {}, "Published fingerprint"),
        el("div", { class: "proof" },
          el("div", {}, "cards: " + c.commitment.ticket_merkle_root),
          el("div", {}, "prize table: " + c.commitment.prize_table_sha256),
          el("div", {}, "draw secret (sealed): " + c.commitment.draw_secret_commitment),
          el("div", {}, "published " + when(c.commitment.published_at))))),
  ];
  const others = state.cycles.filter((x) => x.id !== c.id);
  if (others.length) {
    nodes.push(el("h2", {}, "Other cycles"), el("div", { class: "card" }, others.map((o) =>
      el("div", { class: "row" }, el("button", { class: "link", onclick: () => { remember(o.id); render(); } }, o.name), el("span", { class: "pill grey" }, STATUS_TEXT[o.status] ?? o.status)))));
  }
  nodes.push(installCard({ dismissible: true }));
  nodes.push(el("p", { class: "muted" }, "18+ only. Play within your limits. This is a simulation: no real money is taken or paid."),
    el("p", { class: "muted links" }, el("a", { href: `#/rules/${c.id}` }, "Game rules and odds"), " · ", el("a", { href: "#/privacy" }, "Privacy policy")));
  return nodes;
}

/** The invite code from the link the player arrived by, if any. */
function storedRef() { try { return localStorage.getItem("ref"); } catch { return null; } }
(() => {
  const ref = new URLSearchParams(location.search).get("ref");
  if (!ref) return;
  try { localStorage.setItem("ref", ref.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)); } catch { /* storage unavailable */ }
  history.replaceState(null, "", "/" + location.hash); // tidy the address
  if (!location.hash) location.hash = "#/home";
})();

function signup() {
  let phone = "";
  const codeBlock = el("div", { hidden: true });
  const hint = el("div", { class: "note warn" });
  const phoneInput = el("input", { name: "phone", inputmode: "tel", autocomplete: "tel", placeholder: "0803 000 0000", required: true });
  const submit = el("button", { class: "btn", type: "submit" }, "Send code");
  // An invite link (/r/CODE) leaves the friend's code ready here; it can also be typed.
  const invited = storedRef();
  const refInput = el("input", { name: "ref", maxlength: 12, autocomplete: "off", autocapitalize: "characters", value: invited ?? "" });
  const refBlock = invited
    ? el("div", {}, el("div", { class: "note" }, "You were invited by a friend. Their code is filled in below."), ...field("Invite code (optional)", refInput))
    : el("details", {}, el("summary", {}, "Have an invite code?"), ...field("Invite code (optional)", refInput));
  codeBlock.append(hint,
    ...field("Enter the 6-digit code", el("input", { name: "code", inputmode: "numeric", maxlength: 6, autocomplete: "one-time-code" })),
    ...field("Choose a 6-digit PIN", el("input", { name: "pin", type: "password", inputmode: "numeric", maxlength: 6, autocomplete: "new-password" })),
    el("p", { class: "muted" }, "Avoid easy PINs like 111111 or 123456."),
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "privacy" }), el("span", {}, "I have read and accept the ", el("a", { href: "#/privacy", target: "_blank" }, "privacy policy"), ".")),
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "marketing" }), el("span", {}, "Send me news and offers by text message (optional — you can change this at any time).")));
  const form = el("form", { onsubmit: action(async () => {
    if (codeBlock.hidden) {
      const r = await api.post("/v1/auth/otp", { phone: val(form, "phone"), language: lang() });
      phone = r.phone;
      hint.textContent = tr(r.devCode ? `Simulation: your code is ${r.devCode}. In the live service it arrives by SMS.` : "We sent a code by SMS.");
      codeBlock.hidden = false; phoneInput.readOnly = true; submit.textContent = tr("Create account");
      form.elements.code.focus();
    } else {
      const referralCode = val(form, "ref");
      if (!form.elements.privacy.checked) { toast("Please read and accept the privacy policy to open an account."); return; }
      await api.post("/v1/auth/register", { phone, code: val(form, "code"), pin: val(form, "pin"), language: lang(), ...(referralCode ? { referralCode } : {}),
        acceptPrivacy: true, marketing: form.elements.marketing.checked });
      try { localStorage.removeItem("ref"); } catch { /* storage unavailable */ }
      await loadMe();
      go(nextStep());
    }
  }) }, ...field("Phone number", phoneInput), refBlock, codeBlock, el("div", { class: "stack" }, el("p"), submit));
  return [
    el("div", { class: "steps" }, el("i", { class: "done" }), el("i"), el("i")),
    el("h1", {}, "Create your account"), el("p", { class: "muted" }, "Just your phone number to start."), form,
    el("p", { class: "muted center" }, el("br"), "Already have an account? ", el("a", { href: "#/login" }, "Sign in")),
  ];
}

function login() {
  const form = el("form", { onsubmit: action(async () => {
    await api.post("/v1/auth/login", { phone: val(form, "phone"), pin: val(form, "pin") });
    await loadMe();
    go("home");
  }) },
    ...field("Phone number", el("input", { name: "phone", inputmode: "tel", autocomplete: "tel", required: true })),
    ...field("PIN", el("input", { name: "pin", type: "password", inputmode: "numeric", maxlength: 6, autocomplete: "current-password", required: true })),
    el("div", { class: "stack" }, el("p"), el("button", { class: "btn", type: "submit" }, "Sign in")));
  return [el("h1", {}, "Sign in"), form,
    el("p", { class: "muted center" }, el("br"), "New here, or forgot your PIN? ", el("a", { href: "#/signup" }, "Use your phone number"))];
}

function verify() {
  const form = el("form", { onsubmit: action(async () => {
    await api.post("/v1/me/verify", { kind: val(form, "kind"), number: val(form, "number"), fullName: val(form, "fullName"), dateOfBirth: val(form, "dob"), stateCode: val(form, "state") });
    if (val(form, "nokName") && val(form, "nokPhone")) {
      await api.put("/v1/me/next-of-kin", { fullName: val(form, "nokName"), relationship: val(form, "nokRel") || "Next of kin", phone: val(form, "nokPhone") });
    }
    await loadMe();
    toast("Verified — you can buy cards now.");
    go("buy");
  }) },
    ...field("Verify with", el("select", { name: "kind" }, el("option", {}, "NIN"), el("option", {}, "BVN"))),
    ...field("Number (11 digits)", el("input", { name: "number", inputmode: "numeric", maxlength: 11, required: true })),
    el("div", { class: "note warn" }, "Simulation: in the live service your name, date of birth and location come from the identity check and your phone — you would not type them."),
    ...field("Full name", el("input", { name: "fullName", autocomplete: "name", required: true })),
    ...field("Date of birth", el("input", { name: "dob", type: "date", required: true })),
    ...field("Where you are", el("select", { name: "state" }, el("option", { value: "NG-NI" }, "Niger State"), el("option", { value: "NG-LA" }, "Lagos State (not yet available)"))),
    el("details", { class: "card" }, el("summary", {}, "Add next of kin (optional now, needed for big prizes)"),
      ...field("Full name", el("input", { name: "nokName" })),
      ...field("Relationship", el("input", { name: "nokRel", placeholder: "e.g. Sister" })),
      ...field("Phone", el("input", { name: "nokPhone", inputmode: "tel" }))),
    el("button", { class: "btn", type: "submit" }, "Verify and continue"));
  return [
    el("div", { class: "steps" }, el("i", { class: "done" }), el("i", { class: "done" }), el("i")),
    el("h1", {}, "Confirm it's you"),
    el("p", { class: "muted" }, "We must check you are 18 or over and in Niger State before you can buy."), form,
  ];
}

async function buy() {
  const c = await loadCycle();
  await loadMe();
  if (!c || c.status !== "OPEN") return [el("h1", {}, "Sales are closed"), el("a", { class: "btn", href: "#/draw" }, "See the draw")];
  const { limits, spending, exclusion } = state.me;
  const today = await api.get(`/v1/me/today?cycleId=${c.id}`);
  const leftToday = Math.max(0, today.max - today.cards);
  const room = Math.min(limits.dailyKobo - spending.dailyKobo, limits.weeklyKobo - spending.weeklyKobo, limits.monthlyKobo - spending.monthlyKobo);
  const bySpending = Math.floor(room / c.ticket_price_kobo);
  const maxQty = Math.max(0, Math.min(20, leftToday, c.tickets_remaining, bySpending));
  let qty = Math.min(5, Math.max(1, maxQty));

  const out = el("output", {}, qty), total = el("b"), warn = el("div", { class: "note warn", hidden: true });
  const fill = el("i");
  const pay = el("button", { class: "btn gold" });
  const balance = state.me.balanceKobo ?? 0;
  const fromWallet = el("button", { class: "btn ghost" });
  const refresh = () => {
    out.textContent = qty;
    total.textContent = naira(qty * c.ticket_price_kobo);
    pay.textContent = tr("Pay " + naira(qty * c.ticket_price_kobo));
    const over = qty > maxQty;
    warn.hidden = !over && !exclusion;
    warn.textContent = tr(exclusion ? "You are taking a break from play, so buying is switched off."
      : leftToday === 0 ? `You have bought today's maximum of ${today.max} cards. You can buy more tomorrow.`
      : maxQty === 0 ? "You have reached your spending limit for now."
      : leftToday <= bySpending ? `You can buy ${maxQty} more cards today.` : `You can buy up to ${maxQty} more within your spending limit.`);
    pay.disabled = over || Boolean(exclusion) || !accepted;
    const cost = qty * c.ticket_price_kobo;
    fromWallet.hidden = balance < cost || over || Boolean(exclusion) || !accepted;
    fromWallet.textContent = tr(`Pay ${naira(cost)} from my wallet (${naira(balance)})`);
  };
  fromWallet.addEventListener("click", () => view.replaceChildren(...walletStep(c, qty, balance)));
  fill.style.width = Math.min(100, (spending.dailyKobo / Math.max(1, limits.dailyKobo)) * 100) + "%";
  const set = (n) => { qty = Math.max(1, Math.min(20, today.max, n)); refresh(); };
  // The campaign's game rules are accepted once, before the first purchase (the exact version is recorded).
  let accepted = today.rulesAccepted;
  const rulesBox = accepted ? null : el("div", { class: "card" },
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "rules", onchange: action(async (e) => {
      const box = e.currentTarget;
      if (!box.checked) { accepted = false; refresh(); return; }
      await api.post(`/v1/cycles/${c.id}/rules/accept`);
      accepted = true; box.disabled = true; refresh();
    }, false) }), el("span", {}, "I have read and accept this campaign's ", el("a", { href: `#/rules/${c.id}` }, "game rules"), ".")));

  pay.addEventListener("click", action(async () => {
    const keyName = `order:${c.id}:${qty}`;
    const order = await api.post("/v1/orders", { cycleId: c.id, quantity: qty }, stableKey(keyName));
    view.replaceChildren(...paymentStep(order, keyName));
  }));
  refresh();
  return [
    el("div", { class: "steps" }, el("i", { class: "done" }), el("i", { class: "done" }), el("i", { class: "done" })),
    el("h1", {}, "How many cards?"),
    el("div", { class: "card" },
      el("div", { class: "qty" }, el("button", { "aria-label": "Fewer", onclick: () => set(qty - 1) }, "−"), out, el("button", { "aria-label": "More", onclick: () => set(qty + 1) }, "+")),
      el("div", { class: "chips" }, [1, 3, 5, 10].filter((n) => n <= today.max).map((n) => el("button", { onclick: () => set(n) }, n))),
      el("div", { class: "row" }, el("span", {}, "Total"), total),
      el("p", { class: "muted" }, "More cards, more chances: each card is one entry in the final draw.")),
    el("p", { class: "muted" }, "All sales are final. When you start paying, your cards are held for you for 15 minutes, so your payment always gets them."),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("span", {}, "Cards today"), el("b", {}, `${today.cards} of ${today.max}`)),
      el("div", { class: "row" }, el("span", {}, "Spent in the last 24 hours"), el("b", {}, `${naira(spending.dailyKobo)} of ${naira(limits.dailyKobo)}`)),
      el("div", { class: "bar light" }, fill),
      el("a", { href: "#/me", class: "muted" }, "Change my limits")),
    rulesBox, warn, pay, el("p"), fromWallet,
  ];
}

/** Paying from the wallet: the PIN again, then the cards are issued at once. */
function walletStep(c, qty, balance) {
  const cost = qty * c.ticket_price_kobo, keyName = `wallet-order:${c.id}:${qty}`;
  const form = el("form", { onsubmit: action(async () => {
    await api.post("/v1/orders", { cycleId: c.id, quantity: qty, payWith: "WALLET", pin: val(form, "pin") }, stableKey(keyName));
    clearKey(keyName);
    remember(c.id);
    toast("Paid from your wallet — your cards are ready.");
    await loadMe();
    go("cards");
  }) },
    el("div", { class: "card" },
      el("div", { class: "row" }, el("span", {}, plural(qty, "scratch card")), el("b", {}, naira(cost))),
      el("div", { class: "row" }, el("span", {}, "Wallet balance after"), el("b", {}, naira(balance - cost)))),
    ...field("Your PIN", el("input", { name: "pin", type: "password", inputmode: "numeric", maxlength: 6, autocomplete: "current-password", required: true })),
    el("p"), el("div", { class: "stack" }, el("button", { class: "btn gold", type: "submit" }, "Confirm and buy"), el("a", { class: "btn ghost", href: "#/buy" }, "Cancel")));
  return [el("h1", {}, "Pay from your wallet"), form];
}

function paymentStep(order, keyName) {
  return [
    el("h1", {}, "Pay " + naira(order.amountKobo)),
    el("div", { class: "note warn" }, "Simulated payment. No real money is taken. In the live service you would pay here by card, bank transfer or USSD."),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("span", {}, plural(order.quantity, "scratch card")), el("b", {}, naira(order.amountKobo)))),
    el("div", { class: "stack" },
      el("button", { class: "btn gold", onclick: action(async () => {
        const r = await api.post("/v1/simulated-gateway/pay", { paymentRef: order.paymentRef });
        clearKey(keyName);
        if (r.status === "FULFILLED") { remember(order.cycleId ?? state.cycleId); toast("Payment confirmed — your cards are ready."); go("cards"); }
        else if (r.status === "CREDITED_TO_WALLET") {
          // Rare: the payment arrived after the cards held for it had been released and none were left.
          await loadMe();
          view.replaceChildren(el("h1", {}, "Your money is in your wallet"),
            el("div", { class: "note warn" }, "Your payment arrived after the cards held for you had been released, and none were left. Nothing is lost: the money is in your wallet, to buy cards or withdraw."),
            el("a", { class: "btn", href: "#/wallet" }, "Open my wallet"));
        } else toast("We could not confirm that payment yet. Please try again.");
      }) }, "Confirm simulated payment"),
      el("a", { class: "btn ghost", href: "#/buy" }, "Cancel")),
  ];
}

async function cards() {
  await loadCycle();
  // Every card the player holds, in every cycle, so nothing is hidden when a new cycle opens.
  const tickets = (await api.get("/v1/tickets")).tickets;
  const waiting = tickets.filter((t) => !t.result);
  const toAccept = tickets.filter((t) => t.status === "REVEALED" && t.result?.cashKobo && !t.result.acceptedAt);
  const toAcceptKobo = toAccept.reduce((s, t) => s + t.result.cashKobo, 0);
  const nodes = [el("h1", {}, "My cards"),
    el("p", { class: "muted" }, tickets.length ? `${plural(tickets.length, "card")} · ${waiting.length} to scratch` : "You have no cards yet.")];
  if (toAccept.length) {
    nodes.push(el("button", { class: "btn gold accept", onclick: action(async () => {
      const r = await api.post("/v1/tickets/accept-all");
      toast(`${naira(r.acceptedKobo)} added to your wallet.`);
      await loadMe();
      render();
    }) }, `Accept all winnings (${naira(toAcceptKobo)})`), el("p"));
  }
  if (waiting.length > 1) {
    nodes.push(el("p", {}, el("button", { class: "btn small ghost", onclick: action(async () => {
      for (const t of waiting) await api.post(`/v1/tickets/${t.id}/reveal`);
      toast("All cards revealed.");
      await loadMe();
      render();
    }) }, "Reveal all")));
  }
  const names = new Map(state.cycles.map((c) => [c.id, c.name]));
  for (const cycleId of [...new Set(tickets.map((t) => t.cycleId))]) {
    nodes.push(el("h2", {}, names.get(cycleId) ?? "Earlier cycle"), el("div", { class: "tickets" }, tickets.filter((t) => t.cycleId === cycleId).map((t) => {
      const cash = t.result?.cashKobo ?? 0;
      if (t.status === "CANCELLED") {
        return el("a", { class: "ticket done", href: "#/card/" + t.id }, el("code", {}, t.serial),
          el("b", {}, "Cancelled"), el("span", {}, "Price refunded" + (cash ? ` · ${naira(cash)} prize` : "")));
      }
      return el("a", { class: "ticket" + (t.result ? (cash ? " win" : " done") : ""), href: "#/card/" + t.id },
        el("code", {}, t.serial),
        el("b", {}, t.result ? (cash ? "Won " + naira(cash) : "No instant win") : "Tap to scratch"),
        cash && !t.result.acceptedAt ? el("span", { class: "to-accept" }, "Tap to accept") : null,
        el("span", {}, "In final draw ✓"));
    })));
  }
  // No "buy more" prompt here: after scratching, players are not nudged to buy again (SRS section 10).
  if (state.cycle?.status === "OPEN" && !tickets.length) nodes.push(el("p"), el("a", { class: "btn", href: "#/" + nextStep() }, "Buy scratch cards"));
  return nodes;
}

/** What reaches the wallet from a cash prize after the campaign's statutory deduction (the server's rounding: down). */
const netOf = (cashKobo, taxBp) => cashKobo - Math.floor((cashKobo * (taxBp || 0)) / 10_000);

function resultNodes(cashKobo, demo, accepted = false, taxBp = 0) {
  const net = netOf(cashKobo, taxBp);
  return cashKobo
    ? [el("div", { class: "muted" }, "You won"), el("div", { class: "big" }, naira(cashKobo)),
       ...(!demo && net < cashKobo ? [el("div", { class: "muted deduction" }, `${naira(cashKobo - net)} statutory deduction (${taxBp / 100}%) · ${naira(net)} to your wallet`)] : []),
       el("div", { class: "muted" }, demo ? "Demo only — nothing is paid" : accepted ? "Added to your wallet" : "Tap Accept to add it to your wallet")]
    : [el("div", { class: "big none" }, "No instant win"), el("div", { class: "muted" }, demo ? "Demo card" : "You still qualify for the final prize draw at the end of the season")];
}

async function card(id) {
  const tickets = (await api.get("/v1/tickets")).tickets;
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return [el("h1", {}, "Card not found"), el("a", { class: "btn", href: "#/cards" }, "My cards")];
  if (ticket.status === "CANCELLED") {
    const why = (await api.get("/v1/cycles/" + ticket.cycleId)).status === "VOID" ? "CYCLE_VOID" : null;
    return [el("a", { href: "#/cards" }, "← My cards"), el("h1", {}, "Cancelled card"), el("p", { class: "muted" }, "Card ", el("code", {}, ticket.serial)),
      el("div", { class: "note warn" }, why === "CYCLE_VOID" ? VOID_TEXT : "This card was cancelled and its price refunded to the payment it came from. A cancelled card is not in the final draw."),
      ticket.result ? el("p", { class: "muted" }, ticket.result.cashKobo ? `It had revealed an instant prize of ${naira(ticket.result.cashKobo)}.` : "It had been scratched: no instant win.") : null,
      el("a", { class: "btn ghost", href: "#/me" }, "See my purchases")];
  }
  // The fingerprint and draw date come from the public page of the card's own cycle.
  const cycle = await api.get("/v1/cycles/" + ticket.cycleId);

  const result = el("div"), after = el("div", { hidden: true }), revealBtn = el("button", { class: "btn ghost" }, "Reveal now");
  let revealed;
  // Asks the server to disclose this card's result. Safe to repeat: the server
  // answers with the same result every time and credits a prize only once.
  const disclose = async () => {
    revealed = await api.post(`/v1/tickets/${id}/reveal`);
    result.replaceChildren(...resultNodes(revealed.ticket.result.cashKobo, false, Boolean(revealed.ticket.result.acceptedAt), cycle.winnings_tax_bp));
  };
  const showAfter = async () => {
    revealBtn.hidden = true;
    const cash = revealed.ticket.result.cashKobo;
    if (cash && !ticket.result) { navigator.vibrate?.(60); confetti(); toast("You won " + naira(cash) + "!"); }
    const inv = cash ? await myInvite() : null;
    // Accept moves the prize into the wallet. (If the player never taps it, it is accepted for them when the season closes.)
    const accept = cash && !revealed.ticket.result.acceptedAt ? el("button", { class: "btn gold accept", onclick: action(async () => {
      const r = await api.post(`/v1/tickets/${id}/accept`);
      revealed.ticket = r.ticket;
      result.replaceChildren(...resultNodes(cash, false, true, cycle.winnings_tax_bp));
      accept.remove();
      toast(`${naira(netOf(cash, cycle.winnings_tax_bp))} added to your wallet.`);
      await loadMe();
    }) }, `Accept ${naira(cash)}`) : null;
    // Checked on this phone against the fingerprint from the public cycle page.
    const verified = await verifyTicket(revealed.proof, cycle.commitment.ticket_merkle_root).catch(() => false);
    const next = tickets.find((t) => !t.result && t.id !== id);
    after.replaceChildren(
      accept,
      el("div", { class: "entered" }, el("span", { class: "tick" }, "✓"),
        el("div", {}, el("b", {}, "Entered in the final draw"), el("br"), el("span", { class: "muted" }, when(cycle.draw_at) + " · this card is in, win or lose"))),
      el("div", { class: "entered" }, el("span", { class: "tick" + (verified ? "" : " no") }, verified ? "✓" : "!"),
        el("div", {}, el("b", {}, verified ? "Checked on your phone" : "This result could not be verified"), el("br"),
          el("span", { class: "muted" }, verified ? "It matches the fingerprint published before sales opened." : "Please contact support and quote the card number."))),
      el("details", { class: "card" }, el("summary", {}, "Show the proof"),
        el("div", { class: "proof" },
          el("div", {}, "card: " + revealed.proof.serial), el("div", {}, "result: " + revealed.proof.outcome),
          el("div", {}, "salt: " + revealed.proof.salt), el("div", {}, `position ${revealed.proof.leafIndex}, ${revealed.proof.steps.length} proof steps`),
          el("div", {}, "fingerprint: " + cycle.commitment.ticket_merkle_root))),
      inv ? el("details", { class: "card" }, el("summary", {}, "Share your win"),
        shareBlock(tr(`I just won ${naira(cash)} on a WiiFarm Rewards scratch card! Join with my invite code ${inv.code}. 18+ only. Play responsibly.`), inv.url)) : null,
      next ? el("a", { class: "btn", href: "#/card/" + next.id }, "Next card") : el("a", { class: "btn", href: "#/cards" }, "Back to my cards"));
    after.hidden = false;
    loadMe();
  };

  const nodes = [el("a", { href: "#/cards" }, "← My cards"), el("h1", {}, ticket.result ? "Your result" : "Scratch to reveal"), el("p", { class: "muted" }, "Card ", el("code", {}, ticket.serial))];
  if (ticket.result) {
    await disclose();
    nodes.push(el("div", { class: "scratchwrap" }, el("div", { class: "result" }, result)), after);
    await showAfter();
  } else {
    const surface = scratchSurface(result, { onStart: () => disclose().catch((err) => { toast(err.message); throw err; }), onDone: showAfter });
    revealBtn.addEventListener("click", () => surface.revealNow());
    nodes.push(surface.wrap, el("p"), revealBtn, after);
  }
  return nodes;
}

function demo() {
  // A practice card. It never touches the server and can never pay anything.
  const cash = [0, 0, 0, 50000, 0, 100000, 0, 0][Math.floor(Math.random() * 8)];
  const result = el("div", {}, ...resultNodes(cash, true)), after = el("div", { hidden: true });
  const surface = scratchSurface(result, { onStart: async () => {}, onDone: () => { after.hidden = false; } });
  const accept = cash ? el("button", { class: "btn gold accept", type: "button", onclick: () => { accept.remove(); toast("Demo only — nothing is paid"); } }, `Accept ${naira(cash)}`) : null;
  after.append(el("p"), accept, el("div", { class: "note" }, "That is how it works. On a real card the result is fixed before you buy, and your phone checks it against the published fingerprint."),
    el("div", { class: "stack" }, el("a", { class: "btn gold", href: "#/" + nextStep() }, "Buy scratch cards"), el("button", { class: "btn ghost", onclick: () => render() }, "Try another demo card")));
  return [el("h1", {}, "Demo card"), el("div", { class: "note warn" }, "Practice only. Demo cards are free, are not entered in the draw and cannot win anything."),
    surface.wrap, el("p"), el("button", { class: "btn ghost", onclick: () => surface.revealNow() }, "Reveal now"), after];
}

const BANKS = { "044": "Access Bank", "011": "First Bank", "058": "GTBank", "033": "UBA", "057": "Zenith Bank" };
const HISTORY_TEXT = { INSTANT_PRIZE: "Instant win", DRAW_PRIZE: "Final-draw prize", PAYOUT: "Withdrawal", PAYOUT_REVERSAL: "Withdrawal returned",
  REFERRAL_COMMISSION: "Referral earnings", REFERRAL_REVERSAL: "Referral earnings taken back", TICKET_SALE: "Cards bought", REFUND: "Refund", ADJUSTMENT: "Adjustment" };
const PAYOUT_TEXT = { CONFIRMED: "Sent to your bank", PENDING_APPROVAL: "Being checked", REJECTED: "Not sent — money returned", REQUESTED: "Processing", APPROVED: "Processing", SENT: "On its way", FAILED: "Failed" };

const CLAIM_TEXT = { ENTITLED: "Ready to claim", ON_HOLD: "Being reviewed", VERIFIED: "Claimed — being prepared", DISPATCHED: "On its way", DELIVERED: "Received", EXPIRED: "Claim period ended", VOID: "Not available" };

/** One merchandise prize: claim it, follow it, and show the handover code when it is on its way. */
function prizeCard(p) {
  const daysLeft = Math.max(0, Math.ceil((new Date(p.expires_at) - Date.now()) / 864e5));
  const card = el("div", { class: "card" },
    el("div", { class: "row" }, el("div", {}, el("b", {}, p.title), el("small", {}, `${p.cycle} · card ${p.ticket}`), p.claimed_by_next_of_kin ? el("small", {}, "Passed to you as next of kin") : null),
      el("span", { class: "pill" + (p.status === "DELIVERED" ? "" : " gold") }, CLAIM_TEXT[p.status] ?? p.status)));
  if (p.status === "ENTITLED") {
    if (!state.me.nextOfKin) {
      card.append(el("div", { class: "note warn" }, "Add your next of kin before claiming this prize."), el("a", { class: "btn ghost", href: "#/me" }, "Add next of kin"));
      return card;
    }
    const address = el("input", { name: "address", autocomplete: "street-address", placeholder: "House, street, town" });
    const addressField = el("div", {}, ...field("Delivery address", address));
    const form = el("form", { onsubmit: action(async () => {
      const method = val(form, "method"), body = { method, pin: val(form, "pin") };
      if (method === "DELIVERY") {
        if (!val(form, "address")) { toast("Enter the delivery address."); return; }
        body.address = val(form, "address");
      }
      const r = await api.post(`/v1/claims/${p.id}/redeem`, body);
      toast(r.status === "VERIFIED" ? "Prize claimed. We will tell you when it is on its way." : "Your claim is being reviewed. We will be in touch.");
      render();
    }) },
      el("p", { class: "muted" }, `Claim within ${daysLeft} day${daysLeft === 1 ? "" : "s"} (by ${when(p.expires_at)}).`),
      ...field("How would you like it?", el("select", { name: "method", onchange: (e) => { addressField.hidden = e.target.value !== "DELIVERY"; } },
        el("option", { value: "DELIVERY" }, "Deliver it to me"), el("option", { value: "COLLECTION" }, "I will collect it"))),
      addressField,
      ...field("Your PIN", el("input", { name: "pin", type: "password", inputmode: "numeric", maxlength: 6, autocomplete: "current-password", required: true })),
      el("p"), el("button", { class: "btn gold", type: "submit" }, "Claim my prize"));
    // Folded away so a player with several prizes sees a short list first.
    card.append(el("details", {}, el("summary", {}, "Claim this prize"), form));
  } else if (p.status === "DISPATCHED") {
    card.append(
      el("p", { class: "muted" }, p.method === "DELIVERY" ? `With ${p.carrier ?? "the carrier"}${p.tracking_ref ? " · " + p.tracking_ref : ""}, to ${p.address}.` : "Ready for you to collect" + (p.carrier ? " at " + p.carrier : "") + "."),
      el("div", { class: "note warn" }, "Your handover code. Give it only to the person handing you the prize, when you have it in your hands."),
      el("div", { class: "balance center" }, p.handoverCode ?? "—"));
  } else if (p.status === "DELIVERED") {
    card.append(el("p", { class: "muted" }, `Received ${when(p.handed_over_at)}` + (p.serial_number ? ` · serial ${p.serial_number}` : "") + (p.warranty_months ? ` · ${p.warranty_months}-month warranty` : "")));
  } else if (p.status === "VERIFIED") {
    card.append(el("p", { class: "muted" }, p.method === "DELIVERY" ? "We are preparing your delivery to " + p.address + "." : "We are getting it ready for collection."));
  }
  return card;
}

async function wallet() {
  const [w, bank, prizes] = await Promise.all([api.get("/v1/wallet"), api.get("/v1/me/bank-accounts"), api.get("/v1/claims")]);
  await loadMe();
  const usable = bank.accounts.filter((a) => a.name_match);
  const nodes = [el("h1", {}, "Wallet"),
    w.owedKobo ? el("div", { class: "note bad" }, `A purchase of yours was refunded after you had withdrawn ${naira(w.owedKobo)} that its cards had won. That prize was forfeited, so this amount is owed back; new winnings will go towards it first. Our team will contact you.`) : null,
    el("div", { class: "card" }, el("span", { class: "muted" }, "Wallet balance"), el("div", { class: "balance" }, naira(w.balanceKobo)),
      el("p", { class: "muted" }, "Your winnings. Withdraw them to a bank account in your own verified name, or use them to buy cards."),
      state.me.kycTier >= 1 && w.balanceKobo > 0 ? el("a", { class: "btn small ghost", href: "#/buy" }, "Buy cards from my wallet") : null)];

  if (state.me.kycTier < 1) nodes.push(el("a", { class: "btn", href: "#/verify" }, "Verify your identity"));
  else if (w.balanceKobo >= 50000 && usable.length) {
    const amountKey = () => `payout:${val(form, "amount")}:${val(form, "account")}`;
    const form = el("form", { class: "card", onsubmit: action(async () => {
      const amountKobo = Math.round(Number(val(form, "amount")) * 100);
      const name = amountKey();
      const r = await api.post("/v1/payouts", { amountKobo, bankAccountId: val(form, "account"), pin: val(form, "pin") }, stableKey(name));
      clearKey(name);
      toast(r.status === "CONFIRMED" ? "Withdrawal sent to your bank." : "Withdrawal received. Larger amounts are checked by a second person before they are sent.");
      render();
    }) },
      el("b", {}, "Withdraw to bank"),
      ...field("Amount (₦)", el("input", { name: "amount", inputmode: "decimal", required: true, value: String(w.balanceKobo / 100) })),
      ...field("To", el("select", { name: "account" }, usable.map((a) => el("option", { value: a.id }, `${BANKS[a.bank_code] ?? a.bank_code} · ${a.resolved_name}`)))),
      ...field("Your PIN", el("input", { name: "pin", type: "password", inputmode: "numeric", maxlength: 6, autocomplete: "current-password", required: true })),
      el("p"), el("button", { class: "btn", type: "submit" }, "Withdraw"));
    nodes.push(form);
  } else if (w.balanceKobo > 0 && w.balanceKobo < 50000) nodes.push(el("p", { class: "muted" }, "The minimum withdrawal is ₦500."));

  if (state.me.kycTier >= 1) {
    const add = el("form", { onsubmit: action(async () => {
      const r = await api.post("/v1/me/bank-accounts", { bankCode: val(add, "bank"), accountNumber: val(add, "number"), accountName: val(add, "name") });
      toast(r.nameMatch ? "Bank account added." : "That account is not in your verified name, so it cannot receive winnings.");
      render();
    }) },
      ...field("Bank", el("select", { name: "bank" }, Object.entries(BANKS).map(([code, name]) => el("option", { value: code }, name)))),
      ...field("Account number (10 digits)", el("input", { name: "number", inputmode: "numeric", maxlength: 10, required: true })),
      el("div", { class: "note warn" }, "Simulation: the live service asks the bank for the account name. Here you type it; it must match your verified name."),
      ...field("Account name", el("input", { name: "name", required: true, value: state.me.fullName ?? "" })),
      el("p"), el("button", { class: "btn ghost", type: "submit" }, "Add bank account"));
    nodes.push(el("details", { class: "card", open: !usable.length && w.balanceKobo > 0 }, el("summary", {}, usable.length ? "Add another bank account" : "Add your bank account"), add));
  }

  if (prizes.claims.length) {
    // Prizes that need the player's attention come first: on its way, being prepared, ready to claim.
    const order = ["DISPATCHED", "VERIFIED", "ENTITLED", "ON_HOLD", "DELIVERED", "EXPIRED", "VOID"];
    const sorted = [...prizes.claims].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    nodes.splice(1, 0, el("h2", {}, "My prizes"), ...sorted.map(prizeCard));
  }

  nodes.push(el("h2", {}, "History"), el("div", { class: "card" }, w.history.length
    ? w.history.map((h) => el("div", { class: "row" }, el("div", {}, el("b", {}, HISTORY_TEXT[h.kind] ?? h.kind), el("small", {}, when(h.created_at))), el("b", {}, (h.amount_kobo > 0 ? "+" : "−") + naira(Math.abs(h.amount_kobo)))))
    : el("p", { class: "muted" }, "Nothing yet.")));
  if (w.payouts.length) {
    nodes.push(el("h2", {}, "Withdrawals"), el("div", { class: "card" }, w.payouts.map((p) =>
      el("div", { class: "row" }, el("div", {}, el("b", {}, naira(p.amount_kobo)), el("small", {}, when(p.created_at))), el("span", { class: "pill" + (p.status === "CONFIRMED" ? "" : " gold") }, PAYOUT_TEXT[p.status] ?? p.status)))));
  }
  return nodes;
}

async function draw() {
  await loadCycle();
  // Unless the player picked a cycle here, show the draw of the cycle they most
  // recently bought into — that is the one they are waiting for.
  const all = state.me ? (await api.get("/v1/tickets")).tickets : [];
  const drawCycleId = state.drawCycleId ?? all[0]?.cycleId ?? state.cycleId;
  const c = drawCycleId ? await api.get("/v1/cycles/" + drawCycleId) : null;
  if (!c) return [el("h1", {}, "Final draw"), el("p", { class: "muted" }, "No prize cycle yet.")];
  const mine = all.filter((t) => t.cycleId === c.id);
  const drawn = ["DRAWN", "SETTLING", "ARCHIVED"].includes(c.status);
  const nodes = [el("h1", {}, "Final draw")];
  if (c.status === "VOID") {
    if (state.cycles.length > 1) nodes.push(el("div", { class: "chips" }, state.cycles.map((x) =>
      el("button", { class: x.id === c.id ? "on" : "", onclick: () => { state.drawCycleId = x.id; render(); } }, x.name))));
    nodes.push(el("div", { class: "card" }, el("span", { class: "pill grey" }, "Cancelled"), el("p"), el("p", {}, c.name), el("p", { class: "muted" }, VOID_TEXT + " There is no final draw.")));
    return nodes;
  }
  if (state.cycles.length > 1) {
    nodes.push(el("div", { class: "chips" }, state.cycles.map((x) =>
      el("button", { class: x.id === c.id ? "on" : "", onclick: () => { state.drawCycleId = x.id; render(); } }, x.name))));
  }
  nodes.push(
    el("div", { class: "card" },
      el("span", { class: "pill" + (drawn ? "" : " gold") }, drawn ? "Draw complete" : "Scheduled · " + when(c.draw_at)),
      el("p"), el("p", {}, "Your entries in ", c.name, ": ", el("b", {}, mine.length)),
      el("p", { class: "muted" }, "The draw runs on this date even if some cards are unsold. Only cards that were bought take part.")));
  if (!drawn) {
    nodes.push(el("div", { class: "card" }, el("b", {}, "How we keep it fair"),
      el("div", { class: "check" }, el("span", { class: "tick" }, "1"), "A secret was sealed and its fingerprint published before sales opened."),
      el("div", { class: "check" }, el("span", { class: "tick" }, "2"), `It is combined with public randomness (${c.commitment.beacon_source}, round ${c.commitment.beacon_round}) that nobody can know in advance.`),
      el("div", { class: "check" }, el("span", { class: "tick" }, "3"), "Two staff and the independent auditor must sign before it runs — once only."),
      el("div", { class: "check" }, el("span", { class: "tick" }, "4"), "Afterwards your phone can re-run the whole draw here.")));
    return nodes;
  }
  const d = await api.get(`/v1/cycles/${c.id}/draw`);
  const serials = new Set(mine.map((t) => t.serial));
  const checks = el("div");
  nodes.push(el("h2", {}, "Winning cards"),
    el("div", { class: "card" }, d.winners.map((w) => el("div", { class: "row" }, el("div", {}, el("b", {}, w.title), el("small", {}, w.serial)), serials.has(w.serial) ? el("span", { class: "pill gold" }, "Yours!") : el("span")))),
    d.winners.some((w) => serials.has(w.serial)) ? el("a", { class: "btn gold", href: "#/wallet" }, "You won — see your prizes") : null, el("p"),
    el("div", { class: "card" }, el("b", {}, "Check the draw yourself"),
      el("p", { class: "muted" }, `Your phone re-runs the draw over all ${d.entries_count} entries using the published data.`),
      el("button", { class: "btn ghost", onclick: action(async () => {
        const r = await verifyDraw(d, c.commitment.draw_secret_commitment);
        checks.replaceChildren(...r.checks.map((k) => el("div", { class: "check" }, el("span", { class: "tick" + (k.ok ? "" : " no") }, k.ok ? "✓" : "!"), k.label)),
          el("div", { class: "note" + (r.ok ? "" : " bad") }, r.ok ? "Verified: the published winners are exactly what the rules produce." : "The published result does not match. Please report this."));
      }) }, "Verify the draw"), checks));
  if (c.status === "ARCHIVED") {
    // After close-out every card is published: the phone can check the whole cycle.
    const result = el("div");
    nodes.push(el("div", { class: "card" }, el("b", {}, "Check the whole cycle"),
      el("p", { class: "muted" }, `Every one of the ${c.total_tickets.toLocaleString("en-NG")} cards — sold or not — has now been published with its result. Your phone rebuilds the fingerprint published before sales opened and counts every prize.`),
      el("button", { class: "btn ghost", onclick: action(async () => {
        const cards = [];
        while (cards.length < c.total_tickets) {
          const page = await api.get(`/v1/cycles/${c.id}/tickets?offset=${cards.length}&limit=5000`);
          if (!page.tickets.length) break;
          cards.push(...page.tickets);
          result.replaceChildren(el("p", { class: "muted" }, `Downloaded ${cards.length.toLocaleString("en-NG")} of ${c.total_tickets.toLocaleString("en-NG")} cards…`));
        }
        const r = await verifyCycle(c, cards);
        result.replaceChildren(...r.checks.map((k) => el("div", { class: "check" }, el("span", { class: "tick" + (k.ok ? "" : " no") }, k.ok ? "✓" : "!"), k.label)),
          r.unsoldWins ? el("p", { class: "muted" }, `${r.unsoldWins} instant prize${r.unsoldWins === 1 ? " was" : "s were"} on cards nobody bought — they were real, just not sold.`) : null,
          el("div", { class: "note" + (r.ok ? "" : " bad") }, r.ok ? "Verified: the whole cycle is exactly what was promised before sales opened." : "Something does not match. Please report this."));
      }) }, "Check the whole cycle"), result));
  }
  return nodes;
}

const REFUND_TEXT = { CYCLE_VOID: "cycle cancelled", INELIGIBLE_PURCHASE: "not eligible to buy", DISPUTED_PAYMENT: "payment disputed", NO_TICKET_ISSUED: "credited to your wallet", DUPLICATE_CHARGE: "charged twice" };

async function purchasesSection() {
  const orders = (await api.get("/v1/orders")).orders;
  if (!orders.length) return null;
  return el("details", { class: "card" }, el("summary", {}, `My purchases (${orders.length})`), orders.map((o) =>
    el("div", { class: "row" }, el("div", {}, el("b", {}, `${plural(o.quantity, "card")} · ${o.cycle}`), el("small", {}, when(o.created_at))),
      el("div", {}, el("b", {}, naira(o.amount_kobo)), el("small", {}, o.status === "REFUNDED" ? "Refunded — " + (REFUND_TEXT[o.refund_reason] ?? "refunded") : "Paid")))));
}

const TOPICS = [["PAYMENT", "A payment or refund"], ["PRIZE", "A prize or withdrawal"], ["ACCOUNT", "My account"], ["TECHNICAL", "Something is not working"], ["COMPLAINT", "I want to make a complaint"], ["OTHER", "Something else"]];
const TICKET_TEXT = { OPEN: "Waiting for support", WAITING_PLAYER: "Support replied", CLOSED: "Closed" };

async function supportScreen() {
  const { tickets } = await api.get("/v1/support/tickets");
  const nodes = [el("h1", {}, "Help and support"),
    el("div", { class: "note" }, "Support will never ask for your PIN or a code sent to your phone. Your PIN can only be changed by you, with a code sent to your own phone."),
    el("p", { class: "muted" }, "Worried about how much you play? Lower your limits or take a break on the Me page, or ask us for help here.")];
  for (const t of tickets) {
    const reply = el("form", { onsubmit: action(async () => {
      await api.post(`/v1/support/tickets/${t.id}/messages`, { message: val(reply, "message") });
      toast("Sent."); render();
    }) }, ...field("Your reply", el("textarea", { name: "message", rows: 3, maxlength: 2000, required: true })), el("p"), el("button", { class: "btn ghost", type: "submit" }, "Send"));
    nodes.push(el("details", { class: "card", open: t.status === "WAITING_PLAYER" },
      el("summary", {}, t.subject, " ", el("span", { class: "pill" + (t.status === "WAITING_PLAYER" ? " gold" : t.status === "CLOSED" ? " grey" : "") }, TICKET_TEXT[t.status] ?? t.status)),
      t.messages.map((m) => el("div", { class: "row" }, el("div", {}, el("b", {}, m.author === "STAFF" ? "WiiFarm support" : "You"), el("small", {}, m.body), el("small", {}, when(m.created_at))))),
      t.status === "CLOSED" ? el("p", { class: "muted" }, "This request is closed. Start a new one below if you need more help.") : reply));
  }
  const form = el("form", { class: "card", onsubmit: action(async () => {
    await api.post("/v1/support/tickets", { topic: val(form, "topic"), subject: val(form, "subject"), message: val(form, "message") });
    toast("Sent. We will reply here and send you a text when we do."); render();
  }) }, el("b", {}, "Ask for help"),
    ...field("What is it about?", el("select", { name: "topic" }, TOPICS.map(([v, t]) => el("option", { value: v }, t)))),
    ...field("Subject", el("input", { name: "subject", maxlength: 120, required: true })),
    ...field("Tell us what happened", el("textarea", { name: "message", rows: 4, maxlength: 2000, required: true })),
    el("p", { class: "muted" }, "Do not include your PIN or any code. If you can, give the card number or the date and amount of the payment."),
    el("button", { class: "btn", type: "submit" }, "Send"));
  nodes.push(form);
  // Reporting a promoter (SRS AFF-009): misleading claims, targeting children, pressure, paying people to sign up.
  const report = el("form", { class: "card", onsubmit: action(async () => {
    const r = await api.post("/v1/affiliate-reports", { category: val(report, "category"), description: val(report, "description"), ...(val(report, "code") ? { code: val(report, "code") } : {}) });
    toast(`Report ${r.reference} sent. Compliance will look into it.`); render();
  }) },
    el("details", {}, el("summary", {}, "Report a promoter"),
      el("p", { class: "muted" }, "Tell us if someone promoting WiiFarm Rewards misled you, targeted children, pressured you, paid people to sign up or pretended to be us."),
      ...field("What happened?", el("select", { name: "category" }, REPORT_TOPICS.map(([v, t]) => el("option", { value: v }, t)))),
      ...field("Their code, if you know it (optional)", el("input", { name: "code", maxlength: 20, autocapitalize: "characters" })),
      ...field("Details", el("textarea", { name: "description", rows: 4, minlength: 5, maxlength: 2000, required: true })),
      el("button", { class: "btn ghost", type: "submit" }, "Send report")));
  nodes.push(report);
  return nodes;
}
const REPORT_TOPICS = [["MISLEADING", "Misleading claims"], ["UNDERAGE", "Promoting to children"], ["PRESSURE", "Pressure to play"], ["UNAPPROVED_MATERIAL", "Unofficial adverts"],
  ["PAID_SIGNUPS", "Paying people to sign up"], ["IMPERSONATION", "Pretending to be WiiFarm"], ["OTHER", "Something else"]];

async function me() {
  await loadMe();
  const m = state.me;
  if (!m) return [el("h1", {}, "My account"), langSwitch(), installCard(), el("div", { class: "stack" }, el("a", { class: "btn", href: "#/signup" }, "Create an account"), el("a", { class: "btn ghost", href: "#/login" }, "Sign in"))];
  const options = [100000, 200000, 500000, 1000000, 2000000];
  const limitSelect = el("select", { name: "daily" }, options.map((v) => el("option", { value: v, selected: v === m.limits.dailyKobo }, naira(v) + " a day")));
  if (!options.includes(m.limits.dailyKobo)) limitSelect.prepend(el("option", { value: m.limits.dailyKobo, selected: true }, naira(m.limits.dailyKobo) + " a day"));
  const nok = el("form", { onsubmit: action(async () => {
    await api.put("/v1/me/next-of-kin", { fullName: val(nok, "name"), relationship: val(nok, "rel"), phone: val(nok, "phone") });
    toast("Next of kin saved."); render();
  }) },
    ...field("Full name", el("input", { name: "name", required: true })), ...field("Relationship", el("input", { name: "rel", required: true })),
    ...field("Phone", el("input", { name: "phone", inputmode: "tel", required: true })), el("p"), el("button", { class: "btn ghost", type: "submit" }, "Save next of kin"));

  const sum = await api.get("/v1/me/summary");
  const priv = await api.get("/v1/me/privacy");
  return [el("h1", {}, "My account"),
    el("h2", {}, "My play"),
    el("div", { class: "tiles" },
      el("div", { class: "tile" }, el("b", {}, naira(sum.spentKobo)), el("span", {}, "spent on cards")),
      el("div", { class: "tile" }, el("b", {}, naira(sum.cashWonKobo)), el("span", {}, "won in cash")),
      el("div", { class: "tile" + (sum.netKobo < 0 ? " neg" : "") }, el("b", {}, (sum.netKobo < 0 ? "−" : "") + naira(Math.abs(sum.netKobo))), el("span", {}, "net position")),
      el("div", { class: "tile" }, el("b", {}, `${sum.cards} / ${sum.finalDrawEntries}`), el("span", {}, "cards / final-draw entries"))),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("div", {}, el("b", {}, m.fullName ?? "Phone ending " + m.phoneLast4), el("small", {}, m.kycTier >= 1 ? "Verified · 18+ · " + (m.stateCode === "NG-NI" ? "Niger State" : m.stateCode) : "Not verified yet")),
        m.kycTier >= 1 ? el("span", { class: "pill" }, "Verified") : el("a", { class: "btn small", href: "#/verify" }, "Verify")),
      el("div", { class: "row" }, el("div", {}, el("b", {}, "Next of kin"), el("small", {}, m.nextOfKin ? `${m.nextOfKin.full_name} · ${m.nextOfKin.relationship}` : "Not added — needed before a big prize is claimed")))),
    el("details", { class: "card" }, el("summary", {}, m.nextOfKin ? "Change next of kin" : "Add next of kin"), nok),
    el("a", { class: "btn gold", href: "#/invite" }, "Invite friends"), el("p"),
    el("h2", {}, "Achievements"), await achievements(m),
    el("a", { class: "btn ghost", href: "#/support" }, "Help and support"), el("p"),
    await purchasesSection(),
    el("h2", {}, "Play within your limits"),
    el("div", { class: "card" },
      m.exclusion ? el("div", { class: "note warn" }, m.exclusion.endsAt ? "You are on a break until " + when(m.exclusion.endsAt) + "." : "You have excluded yourself from play.") : null,
      ...field("Spending limit", limitSelect),
      el("p", { class: "muted" }, `Now: ${naira(m.limits.dailyKobo)} a day · ${naira(m.limits.weeklyKobo)} a week · ${naira(m.limits.monthlyKobo)} a month.` +
        (m.limits.pending ? ` Increase to ${naira(m.limits.pending.dailyKobo)} a day starts ${when(m.limits.pending.effectiveAt)}.` : "") + " Lowering is instant; raising takes 24 hours."),
      el("div", { class: "stack" },
        el("button", { class: "btn ghost", onclick: action(async () => {
          const daily = Number(limitSelect.value);
          const r = await api.put("/v1/me/limits", { dailyKobo: daily, weeklyKobo: daily * 4, monthlyKobo: daily * 10 });
          toast(r.pending ? "Increase requested — it starts in 24 hours." : "Limit updated."); render();
        }) }, "Save limit"),
        el("button", { class: "btn ghost", onclick: action(async () => {
          if (!confirm(tr("Take a 7-day break? You will not be able to buy cards until it ends, and it cannot be cancelled."))) return;
          await api.post("/v1/me/exclusion", { kind: "COOL_OFF", days: 7 }); toast("7-day break started."); render();
        }) }, "Take a 7-day break"),
        el("button", { class: "btn ghost danger", onclick: action(async () => {
          if (!confirm(tr("Exclude yourself from play? This cannot be undone here."))) return;
          await api.post("/v1/me/exclusion", { kind: "SELF_EXCLUSION" }); toast("You are now excluded from buying."); render();
        }) }, "Exclude myself"))),
    el("h2", {}, "Privacy"),
    el("div", { class: "card" },
      el("label", { class: "check" }, el("input", { type: "checkbox", name: "marketingPref", checked: priv.marketing, onchange: action(async (e) => {
        await api.put("/v1/me/privacy", { marketing: e.currentTarget.checked });
        return toast(e.currentTarget.checked ? "You will receive news and offers." : "You will not receive news and offers.");
      }, false) }), el("span", {}, "Send me news and offers by text message")),
      el("small", { class: "muted" }, `Privacy policy accepted (version ${priv.privacyPolicy?.version ?? "—"}). `, el("a", { href: "#/privacy" }, "Read it"))),
    el("h2", {}, "Language"), langSwitch(), installCard(),
    el("button", { class: "btn ghost", onclick: action(async () => { await api.post("/v1/auth/logout"); state.me = null; await loadMe(); go("home"); }) }, "Sign out"),
  ];
}

// --- Game rules and the privacy policy ----------------------------------------------------

async function rulesScreen(cycleId) {
  const id = cycleId ?? (await loadCycle())?.id;
  if (!id) return [el("h1", {}, "Game rules and odds"), el("p", { class: "muted" }, "No prize cycle yet.")];
  const r = await api.get(`/v1/cycles/${id}/rules`);
  return [
    el("h1", {}, "Game rules and odds"),
    el("p", { class: "muted" }, `${r.name} · version ${r.version ?? "—"}`),
    el("h2", {}, "Chances of winning"),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("b", {}, "Any instant cash prize"), el("span", {}, r.instantOneIn ? `1 in ${r.instantOneIn.toLocaleString("en-NG")}` : "—")),
      r.instant.map((t) => el("div", { class: "row" }, el("span", {}, `${naira(t.cashKobo)} (${t.winners.toLocaleString("en-NG")} prizes)`), el("span", {}, `1 in ${t.oneIn.toLocaleString("en-NG")}`))),
      el("p", { class: "muted" }, `Chances are per card, over all ${r.totalCards.toLocaleString("en-NG")} cards. Winning is not guaranteed.`)),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("b", {}, "Final draw"), el("span", {}, `${r.finalDrawPrizes.toLocaleString("en-NG")} prizes`)),
      r.finalDraw.map((t) => el("div", { class: "row" }, el("span", {}, t.title), el("span", {}, t.quantity.toLocaleString("en-NG")))),
      el("p", { class: "muted" }, `Every card is entered, win or lose, and can win at most one final-draw prize. If every card is sold, each card has about a ${r.finalDrawPercentAtFullSales}% chance; with fewer cards sold, the chance is higher. Draw: ${when(r.drawAt)}.`)),
    el("div", { class: "card" }, el("div", { class: "row" }, el("b", {}, "Deduction from cash prizes"), el("span", {}, `${r.winningsTaxPercent}%`)),
      el("p", { class: "muted" }, r.winningsTaxPercent ? `By law, ${r.winningsTaxPercent}% of every cash prize is withheld and paid to the tax authority; the rest goes to your wallet.` : "No deduction is currently withheld from cash prizes.")),
    el("h2", {}, "Rules"),
    el("div", { class: "card rules-text" }, r.text ?? "The rules for this cycle have not been published here."),
  ];
}

function privacyScreen() {
  return [
    el("h1", {}, "Privacy policy"),
    el("div", { class: "note warn" }, "Draft for legal review: this summary will be replaced by the approved privacy policy."),
    el("div", { class: "card" },
      el("p", {}, "We collect your phone number, your verified identity (name, date of birth, identity number), your location state, your bank account for payouts, and a record of your purchases, results, prizes, withdrawals and messages."),
      el("p", {}, "We use them to check that you are allowed to play, to run the games, pay prizes, keep you within your limits, meet the law and the regulator's requirements, and prevent fraud."),
      el("p", {}, "Identity and bank account numbers are stored encrypted or as one-way fingerprints. Your data is not sold. It is shared only with the identity, payment and messaging providers we use, auditors, and the authorities when the law requires."),
      el("p", {}, "News and offers are sent only if you agree, and you can stop them at any time on the Me page. You can ask Help and support for a copy of your data or to correct it.")),
  ];
}

// --- Liveness: the selfie check before a major prize or a large withdrawal -----------------

function liveness() {
  const back = state.afterLiveness ?? "#/wallet";
  return [
    el("h1", {}, "Confirm it's really you"),
    el("p", { class: "muted" }, "For a major prize or a large withdrawal we check that it is really you, so that someone with your phone and PIN cannot take it. It takes a few seconds and is done once."),
    el("div", { class: "note warn" }, "Simulation: in the live service your phone's camera takes a short live selfie, which is matched to the photo held for your identity number. Here the button stands in for it."),
    el("div", { class: "stack" },
      el("button", { class: "btn gold", onclick: action(async () => {
        await api.post("/v1/me/liveness");
        await loadMe();
        toast("Thank you — you can carry on.");
        state.afterLiveness = undefined;
        location.hash = back;
      }) }, "Take the selfie check"),
      el("a", { class: "btn ghost", href: back }, "Not now")),
  ];
}

// --- Sharing, invites and a little fun -------------------------------------------------------
//
// Everything shown here is real: the countdown is to the published closing
// time, "sold in the last hour" and "just won" come from the server, and
// milestones are the actual share of cards sold. Nothing invents urgency.

let ticker = null; // one live countdown at a time; cleared on every screen change
const enc = encodeURIComponent;
const pad2 = (n) => String(n).padStart(2, "0");

/** "3 days 04:12:09" until the given time. */
function timeLeft(iso) {
  const ms = Math.max(0, new Date(iso).getTime() - Date.now());
  const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, sec = Math.floor(ms / 1000) % 60;
  const clock = `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  return d ? tr(`${d} ${d === 1 ? "day" : "days"} ${clock}`) : clock;
}
function countdown(label, iso) {
  const out = el("b", {}, timeLeft(iso));
  clearInterval(ticker);
  ticker = setInterval(() => { if (!out.isConnected) clearInterval(ticker); else out.textContent = timeLeft(iso); }, 1000);
  return el("div", { class: "countdown", role: "timer" }, el("span", {}, label), out);
}

/** "3 min ago". */
function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 6e4);
  return tr(min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`);
}

/** The player's invite code and link (fetched once). */
async function myInvite() {
  if (!state.me) return null;
  state.invite ??= await api.get("/v1/me/referrals").catch(() => null);
  return state.invite ? { ...state.invite, url: location.origin + state.invite.link } : null;
}

/** Share buttons: the phone's own share sheet where there is one, the main apps, and copying the link. */
function shareBlock(text, url) {
  const markShared = () => { try { localStorage.setItem("shared", "1"); } catch { /* storage unavailable */ } };
  const app = (name, href) => el("a", { class: "btn small ghost share-" + name.toLowerCase(), href, target: "_blank", rel: "noopener noreferrer", onclick: markShared }, name);
  return el("div", { class: "share" },
    navigator.share ? el("button", { class: "btn gold", type: "button", onclick: async () => {
      try { await navigator.share({ title: "WiiFarm Rewards", text, url }); markShared(); } catch { /* the player closed the share sheet */ }
    } }, "Share") : null,
    el("div", { class: "share-apps" },
      app("WhatsApp", `https://wa.me/?text=${enc(text + " " + url)}`),
      app("Facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`),
      app("X", `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`),
      app("Telegram", `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`)),
    el("button", { class: "btn small ghost", type: "button", onclick: async () => {
      try { await navigator.clipboard.writeText(url); toast("Link copied."); markShared(); } catch { toast(url); }
    } }, "Copy link"));
}

const inviteText = (code) => tr(`Join me on WiiFarm Rewards: ₦500 scratch cards with instant cash prizes, and every card goes into the final draw. Use my invite code ${code}. 18+ only. Play responsibly.`);

async function invite() {
  const inv = await myInvite();
  if (!inv) return [el("h1", {}, "Invite friends"), el("p", { class: "muted" }, "Something went wrong. Please try again.")];
  return [
    el("h1", {}, "Invite friends"),
    el("p", { class: "muted" }, "Share WiiFarm Rewards with friends who are 18 or over. Inviting friends does not earn money."),
    el("div", { class: "card center" }, el("span", { class: "muted" }, "Your invite code"), el("div", { class: "code-big" }, inv.code), el("small", { class: "muted" }, inv.url)),
    shareBlock(inviteText(inv.code), inv.url),
    el("h2", {}, "Your invites"),
    el("div", { class: "tiles" },
      el("div", { class: "tile" }, el("b", {}, String(inv.friendsJoined)), el("span", {}, "friends joined")),
      el("div", { class: "tile" }, el("b", {}, String(inv.friendsWhoPlayed)), el("span", {}, "friends played"))),
    el("a", { class: "card invite-card", href: "#/affiliate" }, el("b", {}, inv.affiliateStatus ? "Your affiliate page" : "Promote WiiFarm Rewards professionally?"),
      el("small", {}, inv.affiliateStatus ? "Your attribution code, results and statements." : "Authorised affiliates are paid marketing fees. Apply to become one.")),
    el("div", { class: "note" }, "Please share responsibly: only with adults, and never pressure anyone to play."),
  ];
}

/**
 * The approved marketing texts (SRS AFF-005): the only ones an affiliate may use.
 * {link} in a text becomes the affiliate's own link; otherwise the link is added at the end.
 */
async function approvedMaterials() {
  const m = await api.get("/v1/me/affiliate/materials");
  const url = location.origin + m.link;
  const linkOnly = el("button", { class: "btn small ghost", type: "button", onclick: async () => {
    try { await navigator.clipboard.writeText(url); toast("Link copied."); } catch { toast(url); }
  } }, "Copy link");
  if (!m.materials.length) {
    return el("div", {}, el("h2", {}, "Approved materials"),
      el("div", { class: "note warn" }, "There are no approved materials yet. Until there are, share only your link, without your own wording."), linkOnly);
  }
  return el("div", {}, el("h2", {}, "Approved materials"),
    el("p", { class: "muted" }, "Use only these texts and pictures, as they are. Each one already contains your link."), linkOnly, el("p"),
    m.materials.map((x) => {
      const body = (lang() === "ha" && x.body_ha) || x.body_en;
      const text = body.includes("{link}") ? body.replaceAll("{link}", url) : `${body} ${url}`;
      return el("div", { class: "card material" },
        el("div", { class: "row" }, el("b", {}, x.name), el("span", { class: "pill grey" }, `${CHANNEL_TEXT[x.channel] ?? x.channel} · v${x.version}`)),
        x.has_image ? el("img", { class: "material-pic", src: `/v1/material-images/${x.version_id}`, alt: x.name, loading: "lazy" }) : null,
        el("p", { class: "material-text" }, text),
        el("div", { class: "share-apps" },
          el("a", { class: "btn small ghost share-whatsapp", href: `https://wa.me/?text=${enc(text)}`, target: "_blank", rel: "noopener noreferrer" }, "WhatsApp"),
          el("button", { class: "btn small ghost", type: "button", onclick: async () => {
            try { await navigator.clipboard.writeText(text); toast("Text copied."); } catch { toast(text); }
          } }, "Copy text")));
    }));
}
const CHANNEL_TEXT = { WHATSAPP: "WhatsApp", SMS: "Text message", SOCIAL: "Social media", PRINT: "Print", RADIO: "Radio" };

const AFFILIATE_STATUS = { APPLIED: "Waiting for review", APPROVED: "Approved", REJECTED: "Not approved", SUSPENDED: "Suspended", TERMINATED: "Ended" };

/** The affiliate application and, once applied, the affiliate's own page (SRS section 13). */
async function affiliateScreen() {
  const d = await api.get("/v1/me/affiliate");
  const fees = d.programme.enabled
    ? el("div", { class: "note" }, `Affiliate fees: ${d.programme.ratePercent}% of the purchases made by the players you bring, in your territory.`)
    : el("div", { class: "note warn" }, "Affiliate fees are not being paid yet: they start once they have been legally approved. Sales from your players are recorded meanwhile.");
  if (!d.affiliate) {
    if (((await api.get("/v1/me")).kycTier ?? 0) < 2) {
      return [el("h1", {}, "Become an affiliate"), fees,
        el("p", { class: "muted" }, "Affiliates are paid, so they need the liveness check and a bank account in their own verified name."),
        el("a", { class: "btn gold", href: "#/liveness" }, "Do the liveness check")];
    }
    const banks = (await api.get("/v1/me/bank-accounts")).accounts.filter((b) => b.name_match);
    if (!banks.length) {
      return [el("h1", {}, "Become an affiliate"), fees,
        el("p", { class: "muted" }, "Add a bank account in your own verified name on the Wallet page first. Your fees will be paid to it."),
        el("a", { class: "btn gold", href: "#/wallet" }, "Go to Wallet")];
    }
    const form = el("form", { class: "card stack", onsubmit: action(async (e) => {
      e.preventDefault();
      const r = await api.post("/v1/me/affiliate", {
        businessName: val(form, "business"), contactEmail: val(form, "email"), channels: val(form, "channels"), bankAccountId: val(form, "bank"),
        ...(val(form, "area") ? { territoryArea: val(form, "area") } : {}),
        acceptAgreement: form.querySelector("input[name=agreement]").checked, trainingCompleted: form.querySelector("input[name=training]").checked,
      });
      toast(`Application ${r.reference} sent. Compliance will review it.`);
      state.invite = undefined;
      render();
    }) },
      ...field("Your name or business name", el("input", { name: "business", required: true, maxlength: 120 })),
      ...field("Email address", el("input", { name: "email", type: "email", required: true, maxlength: 200 })),
      ...field("Your area in the state (optional)", el("input", { name: "area", maxlength: 120 })),
      ...field("Where you will promote (for example WhatsApp groups, market days, radio)", el("textarea", { name: "channels", required: true, maxlength: 500 })),
      ...field("Bank account for your fees", el("select", { name: "bank" }, banks.map((b) => el("option", { value: b.id }, `${BANKS[b.bank_code] ?? b.bank_code} · ${b.resolved_name}`)))),
      el("details", { class: "card" }, el("summary", {}, "Compliance training"),
        el("div", { class: "row" }, el("small", {}, "Only promote to adults (18 or over), and never to anyone on a self-exclusion list.")),
        el("div", { class: "row" }, el("small", {}, "Never promise or suggest that anyone will win, or that playing is a way to make money.")),
        el("div", { class: "row" }, el("small", {}, "Use only the approved materials and your own attribution code. Do not pay or reward people for signing up.")),
        el("div", { class: "row" }, el("small", {}, "Never ask for anyone's PIN, sign-up code or bank details, and never buy cards for other people.")),
        el("div", { class: "row" }, el("small", {}, "You earn only on the players you bring yourself. There are no downlines or recruitment bonuses."))),
      el("label", { class: "check" }, el("input", { type: "checkbox", name: "training", required: true }), " I have read and understood the compliance training"),
      el("label", { class: "check" }, el("input", { type: "checkbox", name: "agreement", required: true }), ` I accept the affiliate agreement (version ${d.agreementVersion})`),
      el("button", { class: "btn gold", type: "submit" }, "Apply"));
    return [el("h1", {}, "Become an affiliate"),
      el("p", { class: "muted" }, "Authorised affiliates promote WiiFarm Rewards in their territory. Compliance reviews every application."), fees, form];
  }
  const a = d.affiliate, st = d.stats;
  return [
    el("h1", {}, "Your affiliate page"),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("span", {}, "Reference"), el("b", {}, a.reference)),
      el("div", { class: "row" }, el("span", {}, "Status"), el("b", {}, AFFILIATE_STATUS[a.status] ?? a.status)),
      el("div", { class: "row" }, el("span", {}, "Territory"), el("b", {}, a.territory + (a.territoryArea ? ` · ${a.territoryArea}` : "")))),
    a.status === "APPLIED" ? el("div", { class: "note" }, "Compliance is reviewing your application. We will message you when it has been decided.") : null,
    a.status === "SUSPENDED" ? el("div", { class: "note warn" }, "Your affiliate account is suspended while Compliance reviews it.") : null,
    a.code ? el("div", { class: "card center" }, el("span", { class: "muted" }, "Your attribution code"), el("div", { class: "code-big" }, a.code),
      el("small", { class: "muted" }, location.origin + a.link)) : null,
    a.code ? await approvedMaterials() : null,
    a.status === "APPLIED" || a.status === "REJECTED" ? null : fees,
    a.status === "APPLIED" || a.status === "REJECTED" ? null : el("div", { class: "tiles" },
      el("div", { class: "tile" }, el("b", {}, String(st.signUps)), el("span", {}, "sign-ups")),
      el("div", { class: "tile" }, el("b", {}, String(st.buyers)), el("span", {}, "players who bought")),
      el("div", { class: "tile" }, el("b", {}, naira(st.salesKobo)), el("span", {}, "their purchases")),
      el("div", { class: "tile" }, el("b", {}, naira(st.pendingKobo)), el("span", {}, "fees to be paid")),
      el("div", { class: "tile" }, el("b", {}, naira(st.paidKobo)), el("span", {}, "fees paid"))),
    d.statements.length ? el("h2", {}, "Statements") : null,
    d.statements.length ? el("div", { class: "card" }, d.statements.map((x) => el("div", { class: "row" },
      el("div", {}, el("b", {}, x.status === "PAID" ? "Paid to your bank" : "Being approved"), el("small", {}, when(x.decided_at ?? x.created_at) + (x.payment_ref ? ` · ${x.payment_ref}` : ""))),
      el("b", {}, naira(x.amount_kobo))))) : null,
  ];
}

/** A short burst of confetti for a win (not shown to people who prefer less motion). */
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = el("canvas", { class: "confetti", "aria-hidden": "true" });
  document.body.append(c);
  const w = c.width = innerWidth, h = c.height = innerHeight, g = c.getContext("2d");
  const colours = ["#d99a1c", "#14532d", "#1c6b3c", "#f4c34d", "#e8f3ec"];
  const bits = Array.from({ length: 120 }, () => ({ x: w / 2, y: h / 3, vx: (Math.random() - 0.5) * 12, vy: Math.random() * -12 - 4, r: Math.random() * 6 + 3, c: colours[Math.floor(Math.random() * colours.length)] }));
  const start = performance.now();
  const frame = (t) => {
    g.clearRect(0, 0, w, h);
    for (const b of bits) { b.vy += 0.35; b.x += b.vx; b.y += b.vy; g.fillStyle = b.c; g.fillRect(b.x, b.y, b.r, b.r * 0.6); }
    if (t - start < 1800) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}

// Pop-ups: announcements approved by Compliance, and real sales milestones. At most one per visit to the home screen.
const seen = (key) => { try { return localStorage.getItem(key) === "1"; } catch { return true; } };
const markSeen = (key) => { try { localStorage.setItem(key, "1"); } catch { /* storage unavailable */ } };
function modal({ title, body, href, label }) {
  const close = () => box.remove();
  const box = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "modalTitle", onclick: (e) => { if (e.target === box) close(); } },
    el("div", { class: "modal-card" },
      el("b", { id: "modalTitle", class: "modal-title" }, title), el("p", {}, body),
      el("div", { class: "stack" },
        href ? el("a", { class: "btn gold", href, onclick: close }, label ?? "Show me") : null,
        el("button", { class: "btn ghost", type: "button", onclick: close }, "Close"))));
  document.body.append(box);
  box.querySelector("button, a")?.focus();
}
async function popups(c) {
  if (document.querySelector(".modal")) return;
  const flash = (await api.get("/v1/flash").catch(() => ({ messages: [] }))).messages.find((m) => !seen("flash:" + m.id));
  if (flash) {
    markSeen("flash:" + flash.id);
    const ha = lang() === "ha";
    return modal({ title: ha && flash.title_ha ? flash.title_ha : flash.title_en, body: ha && flash.body_ha ? flash.body_ha : flash.body_en, href: flash.link ?? undefined });
  }
  if (c?.status !== "OPEN") return;
  const pct = Math.floor(((c.total_tickets - c.tickets_remaining) / c.total_tickets) * 100);
  const milestone = [90, 75, 50, 25].find((m) => pct >= m);
  if (milestone && !seen(`milestone:${c.id}:${milestone}`)) {
    for (const m of [25, 50, 75, 90]) if (m <= milestone) markSeen(`milestone:${c.id}:${m}`);
    modal({ title: tr(`${milestone}% of the cards are sold`),
      body: tr(`${c.tickets_remaining.toLocaleString("en-NG")} cards are left. The final draw is on ${when(c.draw_at)}.`), href: "#/buy", label: "Buy scratch cards" });
  }
}

/** Badges for taking part — none of them for spending more. */
async function achievements(m) {
  const [tickets, inv] = await Promise.all([api.get("/v1/tickets").then((r) => r.tickets).catch(() => []), myInvite()]);
  const list = [
    ["✅", "Verified", m.kycTier >= 1],
    ["🎟️", "First card", tickets.length > 0],
    ["🪙", "First scratch", tickets.some((t) => t.result)],
    ["🎉", "Instant win", tickets.some((t) => t.result?.cashKobo > 0)],
    ["📣", "Shared", seen("shared")],
    ["🤝", "A friend joined", (inv?.friendsJoined ?? 0) > 0],
  ];
  return el("div", { class: "badges" }, list.map(([icon, name, got]) =>
    el("div", { class: "badge" + (got ? " got" : ""), "aria-label": got ? name : `${name} — not yet` }, el("span", { "aria-hidden": "true" }, icon), el("small", {}, name))));
}

// --- Router ---------------------------------------------------------------------------------

const ROUTES = {
  home: { screen: home, tab: "home" }, demo: { screen: demo, tab: "home" },
  signup: { screen: signup, tab: "me" }, login: { screen: login, tab: "me" },
  verify: { screen: verify, tab: "home", auth: true }, buy: { screen: buy, tab: "home", auth: true, verified: true },
  cards: { screen: cards, tab: "cards", auth: true }, card: { screen: card, tab: "cards", auth: true },
  wallet: { screen: wallet, tab: "wallet", auth: true }, invite: { screen: invite, tab: "me", auth: true }, affiliate: { screen: affiliateScreen, tab: "me", auth: true }, liveness: { screen: liveness, tab: "wallet", auth: true },
  rules: { screen: rulesScreen, tab: "home" }, privacy: { screen: privacyScreen, tab: "me" }, inbox: { screen: inbox, tab: "me", auth: true }, support: { screen: supportScreen, tab: "me", auth: true }, draw: { screen: draw, tab: "draw" }, me: { screen: me, tab: "me" },
};

// --- Offline and installing -------------------------------------------------------------------

function offlineScreen() {
  return [el("div", { class: "offline" },
    el("div", { class: "pic", "aria-hidden": "true" }, "📶"),
    el("h1", {}, "You are offline"),
    el("p", {}, "WiiFarm Rewards needs a connection to show your cards, results and winnings. Anything you have already bought or won is safe."),
    el("p", { class: "muted" }, "This page will update by itself when you are back online."),
    el("button", { class: "btn", onclick: () => render() }, "Try again"))];
}
window.addEventListener("online", () => { if (view.querySelector(".offline")) render(); });

// Android offers its own install prompt; it is kept until the player asks for it.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; if (/^#\/(me|home)?$/.test(location.hash || "#/")) render(); });
window.addEventListener("appinstalled", () => { installPrompt = null; });
const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const onIPhone = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const installDismissed = () => { try { return localStorage.getItem("installDismissed") === "1"; } catch { return false; } };

/** "Add to home screen", where the phone supports it and the app is not already installed. */
function installCard({ dismissible = false } = {}) {
  if (installed() || (dismissible && installDismissed())) return null;
  const notNow = dismissible ? el("button", { class: "btn small ghost", type: "button", onclick: () => {
    try { localStorage.setItem("installDismissed", "1"); } catch { /* storage unavailable */ }
    card.remove();
  } }, "Not now") : null;
  let card;
  if (installPrompt) {
    card = el("div", { class: "card install" },
      el("b", {}, "Add WiiFarm Rewards to your home screen"), el("p", { class: "muted" }, "Open it like an app, with one tap. It uses very little space."),
      el("div", { class: "row" }, el("button", { class: "btn small", type: "button", onclick: async () => {
        const p = installPrompt; installPrompt = null;
        await p.prompt(); await p.userChoice.catch(() => null); render();
      } }, "Add to home screen"), notNow));
  } else if (onIPhone()) {
    card = el("div", { class: "card install" },
      el("b", {}, "Add WiiFarm Rewards to your home screen"), el("p", { class: "muted" }, "In Safari, tap the Share button, then Add to Home Screen."), notNow);
  } else return null;
  return card;
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => { /* the app still works without it */ });

let renderId = 0;
let meLoaded = false;
async function render() {
  const mine = ++renderId;
  clearInterval(ticker);
  const [name = "home", arg] = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (!meLoaded) { await loadMe(); meLoaded = true; }
    let route = ROUTES[name] ?? ROUTES.home;
    if (route.auth && !state.me) route = ROUTES.signup;
    else if (route.verified && state.me.kycTier < 1) route = ROUTES.verify;
    document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === route.tab));
    const nodes = await route.screen(arg);
    if (mine !== renderId) return; // a newer navigation has taken over
    view.replaceChildren(...nodes.flat().filter(Boolean));
    // Keep the message badge current on every screen change (a win can arrive at any time).
    if (state.me) refreshBell().catch(() => {});
  } catch (err) {
    if (mine !== renderId) return;
    if (err.status === 401) { state.me = null; location.hash = "#/login"; return; }
    if (err.code === "OFFLINE") { view.replaceChildren(...offlineScreen()); window.scrollTo(0, 0); return; }
    view.replaceChildren(el("h1", {}, "Something went wrong"), el("p", { class: "muted" }, err.message || "Please try again."),
      el("button", { class: "btn", onclick: () => render() }, "Try again"));
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", render);
frame();
render();
