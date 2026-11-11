// WiiFarm Rewards player app. No framework and no third-party code: small to
// download on a slow connection, and nothing here builds HTML from text, so
// content from the server can never run as script.
import { api, clearKey, stableKey } from "/js/api.js";
import { verifyDraw, verifyTicket } from "/js/verify.js";

const view = document.getElementById("view");
const state = { me: null, cycles: [], cycleId: null, cycle: null };

// The cycle the player last chose or bought into is remembered on this device,
// so they come back to its cards and its draw even after sales close.
const remembered = () => { try { return localStorage.getItem("cycle"); } catch { return null; } };
const remember = (id) => { state.cycleId = id; try { localStorage.setItem("cycle", id); } catch { /* storage unavailable */ } };

// --- Small helpers ----------------------------------------------------------------

/** Creates an element. Text is always inserted as text, never parsed as HTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "hidden" || k === "disabled" || k === "selected" || k === "open") node[k] = Boolean(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const naira = (kobo) => "₦" + (kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });
const when = (iso) => new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cashOf = (outcome) => { const m = /^CASH:(\d+)$/.exec(outcome); return m ? Number(m[1]) : 0; };

function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 3500);
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
      if (err.status === 401) { state.me = null; toast("Please sign in again."); go("login"); }
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
    state.me = { ...me, balanceKobo: (await api.get("/v1/wallet")).balanceKobo };
  } catch (err) {
    if (err.status !== 401) throw err;
    state.me = null;
  }
  const bal = document.getElementById("topBal");
  bal.hidden = !state.me;
  if (state.me) bal.textContent = naira(state.me.balanceKobo);
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
    const g = ctx.createLinearGradient(0, 0, r.width, r.height);
    g.addColorStop(0, "#b4babd"); g.addColorStop(0.5, "#e9ecee"); g.addColorStop(1, "#a9b0b3");
    ctx.fillStyle = g; ctx.fillRect(0, 0, r.width, r.height);
    ctx.fillStyle = "#6c757a"; ctx.font = "600 18px system-ui"; ctx.textAlign = "center";
    ctx.fillText("Scratch here", r.width / 2, r.height / 2 + 6);
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

// --- Screens ----------------------------------------------------------------------------

const PRIZE_ICON = (title) => /motor|bike|vehicle/i.test(title) ? "🏍️" : /freez|fridge/i.test(title) ? "🧊" : /solar|batter/i.test(title) ? "🔋" : /phone/i.test(title) ? "📱" : /rice|vita/i.test(title) ? "🌾" : /cash|₦/i.test(title) ? "💵" : "🎁";
const STATUS_TEXT = { COMMITTED: "Opening soon", OPEN: "On sale", CLOSED: "Sales closed", DRAWN: "Draw complete", SETTLING: "Draw complete", ARCHIVED: "Finished" };

async function home() {
  const c = await loadCycle();
  if (!c) return [el("h1", {}, "WiiFarm Rewards"), el("div", { class: "card" }, el("p", {}, "No prize cycle is open right now. Please check back soon."))];

  const sold = c.total_tickets - c.tickets_remaining;
  const instant = c.prizes.filter((p) => p.stage === "INSTANT").map((p) => p.cash_kobo);
  const fill = el("i");
  fill.style.width = Math.round((sold / c.total_tickets) * 100) + "%";
  const odds = c.instantWinOdds ? `1 in ${Math.round(c.instantWinOdds.outOf / c.instantWinOdds.winners)}` : "—";

  const nodes = [
    el("div", { class: "hero" },
      el("span", { class: "tag" }, `${c.name} · ${STATUS_TEXT[c.status] ?? c.status}`),
      el("div", { class: "price" }, naira(c.ticket_price_kobo), " ", el("small", {}, "per scratch card")),
      el("div", { class: "bar" }, fill),
      el("div", {}, `${c.tickets_remaining.toLocaleString("en-NG")} of ${c.total_tickets.toLocaleString("en-NG")} cards left`),
      el("div", { class: "facts" },
        el("div", {}, el("b", {}, odds), "cards win instant cash"),
        el("div", {}, el("b", {}, instant.length ? `${naira(Math.min(...instant))} – ${naira(Math.max(...instant))}` : "—"), "instant prizes"),
        el("div", {}, el("b", {}, when(c.sales_close_at)), "or when sold out"),
        el("div", {}, el("b", {}, "Final draw"), when(c.draw_at)))),
    el("div", { class: "stack" },
      c.status === "OPEN"
        ? el("a", { class: "btn gold", href: "#/" + nextStep() }, "Buy scratch cards")
        : el("a", { class: "btn gold", href: "#/draw" }, c.status === "CLOSED" ? "Sales closed — see the draw" : "See the draw"),
      el("a", { class: "btn ghost", href: "#/demo" }, "Try a free demo card")),
    el("h2", {}, "Final-draw prizes"),
    el("p", { class: "muted" }, "Every card you buy is entered automatically, win or lose."),
    el("div", { class: "prizes" }, c.prizes.filter((p) => p.stage === "FINAL_DRAW").map((p) =>
      el("div", { class: "prize" }, el("div", { class: "pic" }, PRIZE_ICON(p.title)), el("b", {}, p.title), el("span", {}, plural(p.quantity, "winner"))))),
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
  nodes.push(el("p", { class: "muted" }, "18+ only. Play within your limits. This is a simulation: no real money is taken or paid."));
  return nodes;
}

function signup() {
  let phone = "";
  const codeBlock = el("div", { hidden: true });
  const hint = el("div", { class: "note warn" });
  const phoneInput = el("input", { name: "phone", inputmode: "tel", autocomplete: "tel", placeholder: "0803 000 0000", required: true });
  const submit = el("button", { class: "btn", type: "submit" }, "Send code");
  codeBlock.append(hint,
    ...field("Enter the 6-digit code", el("input", { name: "code", inputmode: "numeric", maxlength: 6, autocomplete: "one-time-code" })),
    ...field("Choose a 6-digit PIN", el("input", { name: "pin", type: "password", inputmode: "numeric", maxlength: 6, autocomplete: "new-password" })),
    el("p", { class: "muted" }, "Avoid easy PINs like 111111 or 123456."));
  const form = el("form", { onsubmit: action(async () => {
    if (codeBlock.hidden) {
      const r = await api.post("/v1/auth/otp", { phone: val(form, "phone") });
      phone = r.phone;
      hint.textContent = r.devCode ? `Simulation: your code is ${r.devCode}. In the live service it arrives by SMS.` : "We sent a code by SMS.";
      codeBlock.hidden = false; phoneInput.readOnly = true; submit.textContent = "Create account";
      form.elements.code.focus();
    } else {
      await api.post("/v1/auth/register", { phone, code: val(form, "code"), pin: val(form, "pin") });
      await loadMe();
      go(nextStep());
    }
  }) }, ...field("Phone number", phoneInput), codeBlock, el("div", { class: "stack" }, el("p"), submit));
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
  const room = Math.min(limits.dailyKobo - spending.dailyKobo, limits.weeklyKobo - spending.weeklyKobo, limits.monthlyKobo - spending.monthlyKobo);
  const maxQty = Math.max(0, Math.min(20, c.tickets_remaining, Math.floor(room / c.ticket_price_kobo)));
  let qty = Math.min(5, Math.max(1, maxQty));

  const out = el("output", {}, qty), total = el("b"), warn = el("div", { class: "note warn", hidden: true });
  const fill = el("i");
  const pay = el("button", { class: "btn gold" });
  const refresh = () => {
    out.textContent = qty;
    total.textContent = naira(qty * c.ticket_price_kobo);
    pay.textContent = "Pay " + naira(qty * c.ticket_price_kobo);
    const over = qty > maxQty;
    warn.hidden = !over && !exclusion;
    warn.textContent = exclusion ? "You are taking a break from play, so buying is switched off."
      : maxQty === 0 ? "You have reached your spending limit for now." : `You can buy up to ${maxQty} more within your spending limit.`;
    pay.disabled = over || Boolean(exclusion);
  };
  fill.style.width = Math.min(100, (spending.dailyKobo / Math.max(1, limits.dailyKobo)) * 100) + "%";
  const set = (n) => { qty = Math.max(1, Math.min(20, n)); refresh(); };

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
      el("div", { class: "chips" }, [1, 5, 10, 20].map((n) => el("button", { onclick: () => set(n) }, n))),
      el("div", { class: "row" }, el("span", {}, "Total"), total)),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("span", {}, "Spent in the last 24 hours"), el("b", {}, `${naira(spending.dailyKobo)} of ${naira(limits.dailyKobo)}`)),
      el("div", { class: "bar light" }, fill),
      el("a", { href: "#/me", class: "muted" }, "Change my limits")),
    warn, pay,
  ];
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
        else if (r.status === "REFUNDED") {
          view.replaceChildren(el("h1", {}, "Refunded in full"),
            el("div", { class: "note warn" }, "Those cards sold out while you were paying, so no cards were issued and your payment has been refunded."),
            el("a", { class: "btn", href: "#/home" }, "Back to home"));
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
  const nodes = [el("h1", {}, "My cards"),
    el("p", { class: "muted" }, tickets.length ? `${plural(tickets.length, "card")} · ${waiting.length} to scratch` : "You have no cards yet.")];
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
      return el("a", { class: "ticket" + (t.result ? (cash ? " win" : " done") : ""), href: "#/card/" + t.id },
        el("code", {}, t.serial),
        el("b", {}, t.result ? (cash ? "Won " + naira(cash) : "No instant win") : "Tap to scratch"),
        el("span", {}, "In final draw ✓"));
    })));
  }
  if (state.cycle?.status === "OPEN") nodes.push(el("p"), el("a", { class: "btn", href: "#/" + nextStep() }, tickets.length ? "Buy more cards" : "Buy scratch cards"));
  return nodes;
}

function resultNodes(cashKobo, demo) {
  return cashKobo
    ? [el("div", { class: "muted" }, "You won"), el("div", { class: "big" }, naira(cashKobo)), el("div", { class: "muted" }, demo ? "Demo only — nothing is paid" : "Added to your winnings")]
    : [el("div", { class: "big none" }, "No instant win"), el("div", { class: "muted" }, demo ? "Demo card" : "Still in the final draw")];
}

async function card(id) {
  const tickets = (await api.get("/v1/tickets")).tickets;
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return [el("h1", {}, "Card not found"), el("a", { class: "btn", href: "#/cards" }, "My cards")];
  // The fingerprint and draw date come from the public page of the card's own cycle.
  const cycle = await api.get("/v1/cycles/" + ticket.cycleId);

  const result = el("div"), after = el("div", { hidden: true }), revealBtn = el("button", { class: "btn ghost" }, "Reveal now");
  let revealed;
  // Asks the server to disclose this card's result. Safe to repeat: the server
  // answers with the same result every time and credits a prize only once.
  const disclose = async () => {
    revealed = await api.post(`/v1/tickets/${id}/reveal`);
    result.replaceChildren(...resultNodes(revealed.ticket.result.cashKobo, false));
  };
  const showAfter = async () => {
    revealBtn.hidden = true;
    const cash = revealed.ticket.result.cashKobo;
    if (cash && !ticket.result) { navigator.vibrate?.(60); toast("You won " + naira(cash) + "!"); }
    // Checked on this phone against the fingerprint from the public cycle page.
    const verified = await verifyTicket(revealed.proof, cycle.commitment.ticket_merkle_root).catch(() => false);
    const next = tickets.find((t) => !t.result && t.id !== id);
    after.replaceChildren(
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
  after.append(el("p"), el("div", { class: "note" }, "That is how it works. On a real card the result is fixed before you buy, and your phone checks it against the published fingerprint."),
    el("div", { class: "stack" }, el("a", { class: "btn gold", href: "#/" + nextStep() }, "Buy scratch cards"), el("button", { class: "btn ghost", onclick: () => render() }, "Try another demo card")));
  return [el("h1", {}, "Demo card"), el("div", { class: "note warn" }, "Practice only. Demo cards are free, are not entered in the draw and cannot win anything."),
    surface.wrap, el("p"), el("button", { class: "btn ghost", onclick: () => surface.revealNow() }, "Reveal now"), after];
}

const BANKS = { "044": "Access Bank", "011": "First Bank", "058": "GTBank", "033": "UBA", "057": "Zenith Bank" };
const HISTORY_TEXT = { INSTANT_PRIZE: "Instant win", DRAW_PRIZE: "Final-draw prize", PAYOUT: "Withdrawal", PAYOUT_REVERSAL: "Withdrawal returned" };
const PAYOUT_TEXT = { CONFIRMED: "Sent to your bank", PENDING_APPROVAL: "Being checked", REJECTED: "Not sent — money returned", REQUESTED: "Processing", APPROVED: "Processing", SENT: "On its way", FAILED: "Failed" };

async function wallet() {
  const [w, bank] = await Promise.all([api.get("/v1/wallet"), api.get("/v1/me/bank-accounts")]);
  await loadMe();
  const usable = bank.accounts.filter((a) => a.name_match);
  const nodes = [el("h1", {}, "Winnings"),
    el("div", { class: "card" }, el("span", { class: "muted" }, "Available to withdraw"), el("div", { class: "balance" }, naira(w.balanceKobo)),
      el("p", { class: "muted" }, "Paid only to a bank account in your own verified name."))];

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
  const c = await loadCycle();
  if (!c) return [el("h1", {}, "Final draw"), el("p", { class: "muted" }, "No prize cycle yet.")];
  const mine = state.me ? await myTickets() : [];
  const drawn = ["DRAWN", "SETTLING", "ARCHIVED"].includes(c.status);
  const nodes = [el("h1", {}, "Final draw")];
  if (state.cycles.length > 1) {
    nodes.push(el("div", { class: "chips" }, state.cycles.map((x) =>
      el("button", { class: x.id === c.id ? "on" : "", onclick: () => { remember(x.id); render(); } }, x.name))));
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
    el("div", { class: "card" }, el("b", {}, "Check the draw yourself"),
      el("p", { class: "muted" }, `Your phone re-runs the draw over all ${d.entries_count} entries using the published data.`),
      el("button", { class: "btn ghost", onclick: action(async () => {
        const r = await verifyDraw(d, c.commitment.draw_secret_commitment);
        checks.replaceChildren(...r.checks.map((k) => el("div", { class: "check" }, el("span", { class: "tick" + (k.ok ? "" : " no") }, k.ok ? "✓" : "!"), k.label)),
          el("div", { class: "note" + (r.ok ? "" : " bad") }, r.ok ? "Verified: the published winners are exactly what the rules produce." : "The published result does not match. Please report this."));
      }) }, "Verify the draw"), checks));
  return nodes;
}

async function me() {
  await loadMe();
  const m = state.me;
  if (!m) return [el("h1", {}, "My account"), el("div", { class: "stack" }, el("a", { class: "btn", href: "#/signup" }, "Create an account"), el("a", { class: "btn ghost", href: "#/login" }, "Sign in"))];
  const options = [100000, 200000, 500000, 1000000, 2000000];
  const limitSelect = el("select", { name: "daily" }, options.map((v) => el("option", { value: v, selected: v === m.limits.dailyKobo }, naira(v) + " a day")));
  if (!options.includes(m.limits.dailyKobo)) limitSelect.prepend(el("option", { value: m.limits.dailyKobo, selected: true }, naira(m.limits.dailyKobo) + " a day"));
  const nok = el("form", { onsubmit: action(async () => {
    await api.put("/v1/me/next-of-kin", { fullName: val(nok, "name"), relationship: val(nok, "rel"), phone: val(nok, "phone") });
    toast("Next of kin saved."); render();
  }) },
    ...field("Full name", el("input", { name: "name", required: true })), ...field("Relationship", el("input", { name: "rel", required: true })),
    ...field("Phone", el("input", { name: "phone", inputmode: "tel", required: true })), el("p"), el("button", { class: "btn ghost", type: "submit" }, "Save next of kin"));

  return [el("h1", {}, "My account"),
    el("div", { class: "card" },
      el("div", { class: "row" }, el("div", {}, el("b", {}, m.fullName ?? "Phone ending " + m.phoneLast4), el("small", {}, m.kycTier >= 1 ? "Verified · 18+ · " + (m.stateCode === "NG-NI" ? "Niger State" : m.stateCode) : "Not verified yet")),
        m.kycTier >= 1 ? el("span", { class: "pill" }, "Verified") : el("a", { class: "btn small", href: "#/verify" }, "Verify")),
      el("div", { class: "row" }, el("div", {}, el("b", {}, "Next of kin"), el("small", {}, m.nextOfKin ? `${m.nextOfKin.full_name} · ${m.nextOfKin.relationship}` : "Not added — needed before a big prize is claimed")))),
    el("details", { class: "card" }, el("summary", {}, m.nextOfKin ? "Change next of kin" : "Add next of kin"), nok),
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
          if (!confirm("Take a 7-day break? You will not be able to buy cards until it ends, and it cannot be cancelled.")) return;
          await api.post("/v1/me/exclusion", { kind: "COOL_OFF", days: 7 }); toast("7-day break started."); render();
        }) }, "Take a 7-day break"),
        el("button", { class: "btn ghost danger", onclick: action(async () => {
          if (!confirm("Exclude yourself from play? This cannot be undone here.")) return;
          await api.post("/v1/me/exclusion", { kind: "SELF_EXCLUSION" }); toast("You are now excluded from buying."); render();
        }) }, "Exclude myself"))),
    el("button", { class: "btn ghost", onclick: action(async () => { await api.post("/v1/auth/logout"); state.me = null; await loadMe(); go("home"); }) }, "Sign out"),
  ];
}

// --- Router ---------------------------------------------------------------------------------

const ROUTES = {
  home: { screen: home, tab: "home" }, demo: { screen: demo, tab: "home" },
  signup: { screen: signup, tab: "me" }, login: { screen: login, tab: "me" },
  verify: { screen: verify, tab: "home", auth: true }, buy: { screen: buy, tab: "home", auth: true, verified: true },
  cards: { screen: cards, tab: "cards", auth: true }, card: { screen: card, tab: "cards", auth: true },
  wallet: { screen: wallet, tab: "wallet", auth: true }, draw: { screen: draw, tab: "draw" }, me: { screen: me, tab: "me" },
};

let renderId = 0;
async function render() {
  const mine = ++renderId;
  const [name = "home", arg] = location.hash.replace(/^#\/?/, "").split("/");
  let route = ROUTES[name] ?? ROUTES.home;
  if (route.auth && !state.me) route = ROUTES.signup;
  else if (route.verified && state.me.kycTier < 1) route = ROUTES.verify;
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === route.tab));
  try {
    const nodes = await route.screen(arg);
    if (mine !== renderId) return; // a newer navigation has taken over
    view.replaceChildren(...nodes.flat().filter(Boolean));
  } catch (err) {
    if (mine !== renderId) return;
    if (err.status === 401) { state.me = null; location.hash = "#/login"; return; }
    view.replaceChildren(el("h1", {}, "Something went wrong"), el("p", { class: "muted" }, err.message || "Please try again."),
      el("button", { class: "btn", onclick: () => render() }, "Try again"));
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", render);
loadMe().catch(() => {}).finally(render);
