// WiiFarm Rewards admin app. Like the player app: no framework, no third-party
// code, and no HTML built from text. Every rule (roles, two-person approval,
// locking, the draw sign-offs) is enforced by the server and the database; this
// app only shows what is possible and reports refusals in plain words.

const view = document.getElementById("view");
let me = null;

// --- Helpers --------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "hidden" || k === "disabled" || k === "selected") node[k] = Boolean(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const naira = (kobo) => "₦" + ((kobo ?? 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });
const num = (n) => Number(n ?? 0).toLocaleString("en-NG");
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const can = (...roles) => roles.some((r) => me.roles.includes(r));
const ROLE_TEXT = { CYCLE_MANAGER: "Cycle manager", FINANCE: "Finance", PAYOUT_APPROVER: "Payout approver", FULFILMENT: "Fulfilment", SUPPORT: "Support", COMPLIANCE: "Compliance", AUDITOR: "Auditor (read-only)", SECURITY_ADMIN: "Security admin" };

function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 5000);
}

async function call(method, path, body) {
  const headers = { "X-WR-Client": "web" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error("No connection. Nothing was changed."), { status: 0 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? "Something went wrong."), { status: res.status, code: data?.error?.code });
  return data;
}
const get = (p) => call("GET", p), post = (p, b = {}) => call("POST", p, b), put = (p, b) => call("PUT", p, b);

/** Button/form handler wrapper: one request at a time, refusals shown as messages. */
function action(fn, done) {
  return async (event) => {
    event.preventDefault();
    const btn = event.currentTarget instanceof HTMLFormElement ? event.submitter : event.currentTarget;
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const message = await fn(event);
      if (message) toast(message);
      if (done !== false) await render();
    } catch (err) {
      if (err.status === 401) { me = null; await render(); }
      else toast(err.message);
    } finally {
      if (btn?.isConnected) btn.disabled = false;
    }
  };
}

const input = (label, props, wide) => el("label", { class: wide ? "wide" : "" }, label, el(props.rows ? "textarea" : "input", props));
const select = (label, name, options) => el("label", {}, label, el("select", { name }, options.map(([value, text]) => el("option", { value }, text))));
const v = (form, name) => form.elements[name].value.trim();
const toKobo = (naira) => Math.round(Number(naira) * 100);
const localInput = (date) => { const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const pill = (text, tone = "") => el("span", { class: "pill " + tone }, text);
const STATUS_TONE = { DRAFT: "grey", SUBMITTED: "gold", APPROVED: "gold", COMMITTED: "gold", OPEN: "", CLOSED: "gold", DRAWN: "", SETTLING: "", ARCHIVED: "grey", VOID: "red" };
const table = (head, rows) => el("table", {}, el("tr", {}, head.map((h) => el("th", { class: h.startsWith("#") ? "num" : "" }, h.replace(/^#/, "")))), rows);
const td = (content, numeric) => el("td", { class: numeric ? "num" : "" }, content);
const bar = (fraction) => { const i = el("i"); i.style.width = Math.round(Math.min(1, fraction) * 100) + "%"; return el("div", { class: "bar" }, i); };

// --- Screens --------------------------------------------------------------------------------

function login() {
  const demo = ["manager", "operations", "finance", "approver", "compliance", "auditor"];
  const form = el("form", { class: "card login", onsubmit: action(async () => { await post("/v1/admin/dev-login", { email: v(form, "email") }); me = await get("/v1/admin/me"); location.hash = "#/dashboard"; }) },
    el("h1", {}, "Admin sign-in"),
    el("div", { class: "lock" }, "Simulation sign-in by email only. The live service uses company single sign-on with a hardware security key, from an approved network."),
    el("div", { class: "form" }, input("Work email", { name: "email", type: "email", required: true, list: "demoAdmins", autocomplete: "username" }, true)),
    el("datalist", { id: "demoAdmins" }, demo.map((d) => el("option", { value: d + "@demo.wiifarm.test" }))),
    el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Sign in")),
    el("p", { class: "sub" }, "Demo accounts: " + demo.join(", ") + " @demo.wiifarm.test"));
  return [form];
}

async function dashboard() {
  const d = await get("/v1/admin/dashboard");
  const live = d.cycles.find((c) => ["OPEN", "CLOSED", "DRAWN", "SETTLING"].includes(c.status)) ?? d.cycles[0];
  const nodes = [el("h1", {}, "Dashboard"), el("p", { class: "sub" }, "All figures are calculated from ticket records and the ledger — none are typed in.")];
  if (live) {
    const liability = live.outstanding_instant_liability_kobo + live.final_draw_cash_commitment_kobo + d.totals.winnings_payable_kobo + d.totals.payouts_in_transit_kobo;
    const cover = live.escrow_funded_kobo ?? 0;
    nodes.push(el("h2", {}, live.name), el("div", { class: "tiles" },
      el("div", { class: "tile" }, el("span", {}, "Tickets sold"), el("b", {}, num(live.sold)), el("small", {}, `of ${num(live.total_tickets)} · ${num(live.remaining)} remaining`)),
      el("div", { class: "tile" }, el("span", {}, "Gross ticket revenue"), el("b", {}, naira(live.revenue_kobo)), el("small", {}, Math.round((live.sold / live.total_tickets) * 100) + "% of maximum")),
      el("div", { class: "tile" }, el("span", {}, "Prizes awarded (cash)"), el("b", {}, naira(live.prizes_awarded_kobo)), el("small", {}, `${naira(live.instant_revealed_kobo)} instant, revealed so far`)),
      el("div", { class: "tile" }, el("span", {}, "Instant prizes still in unsold or unscratched cards"), el("b", {}, naira(live.outstanding_instant_liability_kobo))),
      el("div", { class: "tile" }, el("span", {}, "Final-draw cash commitment"), el("b", {}, naira(live.final_draw_cash_commitment_kobo))),
      el("div", { class: "tile " + (cover >= liability ? "ok" : "bad") }, el("span", {}, "Outstanding prize liability"), el("b", {}, naira(liability)), el("small", {}, `escrow cover ${naira(cover)}`)),
      el("div", { class: "tile" }, el("span", {}, "Merchandise prizes to fulfil"), el("b", {}, num(live.merchandise_outstanding)))));
  }
  nodes.push(el("h2", {}, "Across all cycles"), el("div", { class: "tiles" },
    el("div", { class: "tile" }, el("span", {}, "Winnings owed to players"), el("b", {}, naira(d.totals.winnings_payable_kobo))),
    el("div", { class: "tile" }, el("span", {}, "Payouts in progress"), el("b", {}, naira(d.totals.payouts_in_transit_kobo)), el("small", {}, `${d.pending.payouts} awaiting approval`)),
    el("div", { class: "tile" }, el("span", {}, "Cash held (gateway clearing)"), el("b", {}, naira(d.totals.gateway_clearing_kobo))),
    el("div", { class: "tile " + (d.totals.ledger_balanced ? "ok" : "bad") }, el("span", {}, "Ledger"), el("b", {}, d.totals.ledger_balanced ? "Balanced" : "OUT OF BALANCE"), el("small", {}, "debits equal credits")),
    el("div", { class: "tile " + (d.pending.alerts ? "bad" : "ok") }, el("span", {}, "Compliance alerts"), el("b", {}, d.pending.alerts + " open"))));
  nodes.push(el("h2", {}, "Prize cycles"), el("div", { class: "card" }, cyclesTable(d.cycles.map((c) => ({ ...c, sold: c.sold })))));
  return nodes;
}

const cyclesTable = (cycles) => cycles.length ? table(["Cycle", "Status", "Sales", "#Sold", "#Price", "Closes", "Draw"], cycles.map((c) =>
  el("tr", {}, td(el("a", { href: "#/cycle/" + c.id }, el("b", {}, c.name))), td(pill(c.status, STATUS_TONE[c.status])), td(bar(c.sold / c.total_tickets)),
    td(`${num(c.sold)} / ${num(c.total_tickets)}`, true), td(naira(c.ticket_price_kobo), true), td(when(c.sales_close_at)), td(when(c.draw_at)))))
  : el("p", { class: "sub" }, "No cycles yet.");

async function cycles() {
  const list = (await get("/v1/admin/cycles")).cycles;
  const nodes = [el("h1", {}, "Prize cycles"), el("p", { class: "sub" }, "A cycle is drafted, approved by two other people, locked, then opened for sale."), el("div", { class: "card" }, cyclesTable(list))];
  if (can("CYCLE_MANAGER")) {
    const now = Date.now();
    const form = el("form", { class: "card", onsubmit: action(async () => {
      const r = await post("/v1/admin/cycles", {
        name: v(form, "name"), ticketPriceKobo: toKobo(v(form, "price")), totalTickets: Number(v(form, "total")), maxTicketsPerAccount: Number(v(form, "cap")),
        salesOpenAt: new Date(v(form, "open")).toISOString(), salesCloseAt: new Date(v(form, "close")).toISOString(), drawAt: new Date(v(form, "draw")).toISOString() });
      location.hash = "#/cycle/" + r.id;
    }, false) },
      el("b", {}, "New cycle"), el("p", { class: "sub" }, "All cycles are simulated. Ticket price must be ₦200–₦500."),
      el("div", { class: "form" },
        input("Name", { name: "name", required: true, maxlength: 120 }),
        input("Ticket price (₦)", { name: "price", type: "number", min: 200, max: 500, step: 50, value: 200, required: true }),
        input("Number of tickets", { name: "total", type: "number", min: 1, value: 1000, required: true }),
        input("Most tickets per player", { name: "cap", type: "number", min: 1, value: 50, required: true }),
        input("Sales open", { name: "open", type: "datetime-local", value: localInput(new Date(now)), required: true }),
        input("Sales close (or sell-out)", { name: "close", type: "datetime-local", value: localInput(new Date(now + 14 * 864e5)), required: true }),
        input("Final draw", { name: "draw", type: "datetime-local", value: localInput(new Date(now + 14 * 864e5)), required: true })),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Create draft")));
    nodes.push(form);
  }
  return nodes;
}

const FLOW = ["DRAFT", "SUBMITTED", "APPROVED", "COMMITTED", "OPEN", "CLOSED", "DRAWN", "SETTLING", "ARCHIVED"];

async function cycle(id) {
  const c = await get("/v1/admin/cycles/" + id);
  const at = FLOW.indexOf(c.status);
  const step = (path, label, message, cls = "btn") => el("button", { class: cls, onclick: action(async () => { await post(`/v1/admin/cycles/${id}/${path}`); return message; }) }, label);
  const nodes = [
    el("a", { href: "#/cycles" }, "← Prize cycles"),
    el("h1", {}, c.name),
    el("p", { class: "sub" }, `${c.mode === "SIMULATED" ? "Simulated" : c.mode} · ${num(c.total_tickets)} tickets at ${naira(c.ticket_price_kobo)} · drafted by ${c.created_by_name}`),
    el("div", { class: "flow" }, FLOW.map((s, i) => el("span", { class: i < at ? "done" : i === at ? "now" : "" }, s.charAt(0) + s.slice(1).toLowerCase()))),
  ];
  if (!c.editable) nodes.push(el("div", { class: "lock" }, "🔒 Locked. Price, quantities, prizes, odds and dates were fixed at approval and cannot be changed by anyone."));

  // Key facts
  nodes.push(el("div", { class: "tiles" },
    el("div", { class: "tile" }, el("span", {}, "Sold"), el("b", {}, `${num(c.counts.sold)} / ${num(c.total_tickets)}`), el("small", {}, `${num(c.counts.revealed)} scratched`)),
    el("div", { class: "tile" }, el("span", {}, "Sales window"), el("b", {}, when(c.sales_close_at)), el("small", {}, "opens " + when(c.sales_open_at) + " · closes then or at sell-out")),
    el("div", { class: "tile" }, el("span", {}, "Final draw"), el("b", {}, when(c.draw_at)), el("small", {}, `claims open ${c.claim_window_days} days`)),
    el("div", { class: "tile " + ((c.escrow_funded_kobo ?? 0) >= c.cashCoverRequiredKobo ? "ok" : "warn") }, el("span", {}, "Cash prizes to cover"), el("b", {}, naira(c.cashCoverRequiredKobo)), el("small", {}, c.escrow_reference ? `escrow ${c.escrow_reference}: ${naira(c.escrow_funded_kobo)}` : "escrow not recorded yet"))));

  // Prize schedule
  const tierRows = c.tiers.map((t) => el("tr", {}, td(t.stage === "INSTANT" ? "Instant" : "Final draw #" + t.draw_order), td(t.title + (t.sku_name && t.sku_name !== t.title ? ` (${t.sku_name})` : "")),
    td(t.kind === "CASH" ? naira(t.cash_kobo) : "Merchandise", true), td(num(t.quantity), true), td(num(t.awarded), true)));
  nodes.push(el("h2", {}, "Prize schedule"), el("div", { class: "card" }, c.tiers.length ? table(["Stage", "Prize", "#Value", "#Quantity", "#Awarded"], tierRows) : el("p", { class: "sub" }, "No prizes yet."),
    el("p", { class: "sub" }, "Nobody — including staff and engineers — can see which unsold or unscratched tickets hold instant prizes.")));

  if (c.status === "DRAFT" && can("CYCLE_MANAGER")) {
    const skus = (await get("/v1/admin/skus")).skus;
    const tier = el("form", { class: "card", onsubmit: action(async () => {
      const kind = v(tier, "kind"), stage = v(tier, "stage");
      const body = { stage, kind, title: v(tier, "title"), quantity: Number(v(tier, "quantity")) };
      if (kind === "CASH") body.cashKobo = toKobo(v(tier, "cash")); else body.skuId = v(tier, "sku");
      if (stage === "FINAL_DRAW") body.drawOrder = Number(v(tier, "order"));
      await post(`/v1/admin/cycles/${id}/prize-tiers`, body);
      return "Prize added.";
    }) },
      el("b", {}, "Add a prize"), el("p", { class: "sub" }, "Instant prizes are cash, ₦500–₦10,000. Final-draw prizes are drawn in the order given, major prizes first."),
      el("div", { class: "form" },
        select("Stage", "stage", [["INSTANT", "Instant (scratch)"], ["FINAL_DRAW", "Final draw"]]),
        select("Type", "kind", [["CASH", "Cash"], ["MERCHANDISE", "Merchandise"]]),
        input("Title shown to players", { name: "title", required: true, maxlength: 120 }),
        input("Cash amount (₦)", { name: "cash", type: "number", min: 1, step: 1 }),
        select("Merchandise item", "sku", skus.length ? skus.map((s) => [s.id, `${s.name} (${naira(s.advertised_value_kobo)})`]) : [["", "No items yet"]]),
        input("Quantity", { name: "quantity", type: "number", min: 1, value: 1, required: true }),
        input("Draw order (final draw only)", { name: "order", type: "number", min: 1, value: c.tiers.filter((t) => t.stage === "FINAL_DRAW").length + 1 })),
      el("div", { class: "actions" }, el("button", { class: "btn ghost", type: "submit" }, "Add prize")));
    const sku = el("form", { class: "card", onsubmit: action(async () => { await post("/v1/admin/skus", { name: v(sku, "name"), advertisedValueKobo: toKobo(v(sku, "value")) }); return "Merchandise item added."; }) },
      el("b", {}, "New merchandise item"),
      el("div", { class: "form" }, input("Name", { name: "name", required: true }), input("Advertised value (₦)", { name: "value", type: "number", min: 1, required: true })),
      el("div", { class: "actions" }, el("button", { class: "btn ghost", type: "submit" }, "Add item")));
    nodes.push(tier, sku);
  }

  // Evidence and approvals
  if (c.editable && can("CYCLE_MANAGER", "FINANCE")) {
    const auditors = (await get("/v1/admin/auditors")).auditors;
    const ev = el("form", { class: "card", onsubmit: action(async () => {
      await put(`/v1/admin/cycles/${id}/evidence`, { financialModelRef: v(ev, "model"), rulesDocumentRef: v(ev, "rulesRef"), rulesText: v(ev, "rules"), escrowReference: v(ev, "escrow"), escrowFundedKobo: toKobo(v(ev, "funded")), auditorAdminId: v(ev, "auditor") });
      return "Evidence saved.";
    }) },
      el("b", {}, "Evidence required for approval"),
      el("p", { class: "sub" }, `Cash prizes total ${naira(c.cashCoverRequiredKobo)}; the escrow or trust account must hold at least that much.`),
      el("div", { class: "form" },
        input("Financial model (document reference)", { name: "model", required: true, value: c.financial_model_ref ?? "" }),
        input("Published rules (document reference)", { name: "rulesRef", required: true, value: c.rules_document_ref ?? "" }),
        input("Escrow / trust reference", { name: "escrow", required: true, value: c.escrow_reference ?? "" }),
        input("Amount held in escrow (₦)", { name: "funded", type: "number", min: 0, required: true, value: c.escrow_funded_kobo != null ? c.escrow_funded_kobo / 100 : c.cashCoverRequiredKobo / 100 }),
        select("Independent auditor appointed", "auditor", auditors.map((a) => [a.id, a.full_name])),
        input("Rules text (its fingerprint is published)", { name: "rules", rows: 3, required: true }, true)),
      el("div", { class: "actions" }, el("button", { class: "btn ghost", type: "submit" }, "Save evidence")));
    if (c.auditor_admin_id) ev.elements.auditor.value = c.auditor_admin_id;
    nodes.push(ev);
  }
  const evidenceOk = c.financial_model_ref && c.rules_sha256 && c.auditor_admin_id && c.escrow_reference && (c.escrow_funded_kobo ?? 0) >= c.cashCoverRequiredKobo;
  nodes.push(el("h2", {}, "Approval"), el("div", { class: "card" },
    el("div", { class: "check" + (evidenceOk ? " yes" : "") }, el("i", {}, evidenceOk ? "✓" : "1"), el("div", {}, "Evidence complete and cash prizes fully funded",
      el("small", {}, c.auditor_name ? `Auditor: ${c.auditor_name} · rules fingerprint ${c.rules_sha256?.slice(0, 16)}…` : "Financial model, rules, escrow and auditor"))),
    ...["OPERATIONS", "FINANCE"].map((cap) => {
      const a = c.approvals.find((x) => x.capacity === cap);
      return el("div", { class: "check" + (a ? " yes" : "") }, el("i", {}, a ? "✓" : "2"), el("div", {}, cap === "OPERATIONS" ? "Operations approval" : "Finance approval",
        el("small", {}, a ? `${a.full_name} · ${when(a.approved_at)}` : "Must be someone other than the drafter and the other approver")));
    }),
    el("div", { class: "actions" },
      c.status === "DRAFT" && can("CYCLE_MANAGER") ? step("submit", "Submit for approval", "Submitted for approval.") : null,
      c.status === "SUBMITTED" && can("FINANCE", "CYCLE_MANAGER", "COMPLIANCE") ? step("approve", "Approve as " + (can("FINANCE") ? "Finance" : "Operations"), "Approval recorded.") : null,
      c.status === "APPROVED" && can("CYCLE_MANAGER") ? step("commit", "Generate tickets and publish fingerprint", "Tickets generated and commitments published.") : null,
      c.status === "COMMITTED" && can("CYCLE_MANAGER") ? step("open", "Open sales", "Sales are open.") : null)));

  if (c.commitment) {
    nodes.push(el("h2", {}, "Published commitments"), el("div", { class: "card mono" },
      el("div", {}, "ticket fingerprint: " + c.commitment.ticket_merkle_root), el("div", {}, "prize table: " + c.commitment.prize_table_sha256),
      el("div", {}, "draw secret (sealed): " + c.commitment.draw_secret_commitment),
      el("div", {}, `randomness: ${c.commitment.beacon_source}, round ${c.commitment.beacon_round} · engine ${c.commitment.game_core_version} · published ${when(c.commitment.published_at)}`)));
  }

  // Draw console
  if (at >= FLOW.indexOf("COMMITTED")) {
    const closed = at >= FLOW.indexOf("CLOSED"), drawn = Boolean(c.draw);
    const ops = c.signoffs.filter((s) => s.capacity === "OPERATOR"), aud = c.signoffs.find((s) => s.capacity === "AUDITOR");
    const check = (ok, label, detail) => el("div", { class: "check" + (ok ? " yes" : "") }, el("i", {}, ok ? "✓" : "·"), el("div", {}, label, el("small", {}, detail)));
    const ready = closed && c.drawTimeReached && ops.length >= 2 && aud && !drawn;
    const signed = c.signoffs.some((s) => s.admin_user_id === me.id);
    nodes.push(el("h2", {}, "Final draw"), el("div", { class: "card" },
      check(closed, "Sales closed", closed ? `${num(c.counts.sold)} tickets entered · ${num(c.counts.unsold)} unsold tickets take no part` : "Closes at sell-out or the closing time, whichever is first"),
      check(c.drawTimeReached, "Published draw time reached", when(c.draw_at)),
      check(ops.length >= 1, "First operator signed", ops[0] ? `${ops[0].full_name} · ${when(ops[0].signed_at)}` : "Cycle manager, finance or compliance"),
      check(ops.length >= 2, "Second operator signed", ops[1] ? `${ops[1].full_name} · ${when(ops[1].signed_at)}` : "Must be a different person"),
      check(Boolean(aud), "Appointed auditor countersigned", aud ? `${aud.full_name} · ${when(aud.signed_at)}` : `Only ${c.auditor_name ?? "the appointed auditor"}`),
      check(drawn, "Draw executed", drawn ? `${when(c.draw.executed_at)} over ${num(c.draw.entries_count)} entries` : "Runs once. The result cannot be re-run or edited."),
      el("div", { class: "actions" },
        closed && !drawn && !signed && can("CYCLE_MANAGER", "FINANCE", "COMPLIANCE", "AUDITOR") ? step("draw/sign", can("AUDITOR") ? "Countersign as auditor" : "Sign off as operator", "Sign-off recorded.") : null,
        closed && !drawn && can("CYCLE_MANAGER", "FINANCE", "COMPLIANCE") ? el("button", { class: "btn", disabled: !ready, onclick: action(async () => {
          if (!confirm("Execute the final draw now? It runs once and cannot be repeated.")) return;
          const r = await post(`/v1/admin/cycles/${id}/draw/execute`);
          return `Draw complete: ${r.winners} winners from ${r.entries} entries.`;
        }) }, "Execute draw") : null)));
    if (drawn) {
      const d = await get(`/v1/cycles/${id}/draw`);
      nodes.push(el("div", { class: "card" }, el("b", {}, "Winning tickets"),
        table(["Prize", "#Position", "Ticket"], d.winners.map((w) => el("tr", {}, td(w.title), td(w.position, true), td(el("span", { class: "mono" }, w.serial))))),
        el("p", { class: "sub" }, "The public results page lets anyone re-run this draw from the published data.")));
    }
  }
  return nodes;
}

async function approvals() {
  const [list, pending] = await Promise.all([get("/v1/admin/cycles"), can("FINANCE", "PAYOUT_APPROVER", "COMPLIANCE", "AUDITOR") ? get("/v1/admin/payouts/pending") : { payouts: [] }]);
  const waiting = list.cycles.filter((c) => c.status === "SUBMITTED");
  return [el("h1", {}, "Approvals"), el("p", { class: "sub" }, "Every sensitive action needs a second person. You cannot approve something you raised."),
    el("h2", {}, "Cycles awaiting approval"),
    el("div", { class: "card" }, waiting.length ? table(["Cycle", "#Tickets", "#Price", "Approvals so far", ""], waiting.map((c) =>
      el("tr", {}, td(el("b", {}, c.name)), td(num(c.total_tickets), true), td(naira(c.ticket_price_kobo), true), td(`${c.approvals} of 2`), td(el("a", { class: "btn ghost", href: "#/cycle/" + c.id }, "Review")))))
      : el("p", { class: "sub" }, "Nothing waiting.")),
    el("h2", {}, "Payouts awaiting approval"),
    el("div", { class: "card" }, payoutsTable(pending.payouts))];
}

function payoutsTable(payouts) {
  if (!payouts.length) return el("p", { class: "sub" }, "Nothing waiting.");
  const decide = (p, approve) => action(async () => {
    const body = { approve };
    if (!approve) { const reason = prompt("Reason for rejecting (the money returns to the player's winnings):"); if (!reason) return; body.reason = reason; }
    const r = await post(`/v1/admin/payouts/${p.id}/decision`, body);
    return approve ? "Payout approved and sent." : "Payout rejected; money returned to the player. (" + r.status + ")";
  });
  return table(["Player", "#Amount", "Bank name match", "Requested", ""], payouts.map((p) =>
    el("tr", {}, td("…" + p.phone_last4), td(naira(p.amount_kobo), true), td(p.name_match ? pill("Match") : pill("Mismatch", "red")), td(when(p.created_at)),
      td(can("PAYOUT_APPROVER") ? el("div", { class: "actions" }, el("button", { class: "btn", onclick: decide(p, true) }, "Approve"), el("button", { class: "btn danger", onclick: decide(p, false) }, "Reject")) : pill("Needs payout approver", "gold")))));
}

async function payouts() {
  if (!can("FINANCE", "PAYOUT_APPROVER", "COMPLIANCE", "AUDITOR")) return [el("h1", {}, "Payouts"), el("p", { class: "sub" }, "Your role does not include payouts.")];
  const p = await get("/v1/admin/payouts/pending");
  return [el("h1", {}, "Payouts"), el("p", { class: "sub" }, "Small withdrawals are sent automatically to a name-matched bank account. Larger or flagged ones wait here for a payout approver."),
    el("div", { class: "card" }, payoutsTable(p.payouts))];
}

async function auditPage() {
  const nodes = [el("h1", {}, "Audit & compliance")];
  if (can("COMPLIANCE", "AUDITOR", "FINANCE", "SECURITY_ADMIN")) {
    const c = await get("/v1/admin/compliance");
    nodes.push(el("div", { class: "tiles" },
      el("div", { class: "tile " + (c.realMoneyGate.licences ? "ok" : "warn") }, el("span", {}, "Licence on record"), el("b", {}, c.realMoneyGate.licences ? "Yes" : "None"), el("small", {}, c.realMoneyGate.licences ? "" : "real-money sales are blocked")),
      el("div", { class: "tile " + (c.realMoneyGate.certifications ? "ok" : "warn") }, el("span", {}, "Game certification on record"), el("b", {}, c.realMoneyGate.certifications ? "Yes" : "None"), el("small", {}, c.realMoneyGate.certifications ? "" : "real-money sales are blocked")),
      el("div", { class: "tile" }, el("span", {}, "Players on a break or self-excluded"), el("b", {}, num(c.activeSelfExclusions))),
      el("div", { class: "tile " + (c.alerts.some((a) => a.status === "OPEN") ? "bad" : "ok") }, el("span", {}, "Open alerts"), el("b", {}, num(c.alerts.filter((a) => a.status === "OPEN").length)))),
      el("h2", {}, "Alerts"), el("div", { class: "card" }, c.alerts.length ? table(["When", "Alert", "Severity", "Status"], c.alerts.map((a) =>
        el("tr", {}, td(when(a.created_at)), td(a.kind.replaceAll("_", " ").toLowerCase()), td(pill(a.severity, a.severity === "CRITICAL" ? "red" : "gold")), td(a.status)))) : el("p", { class: "sub" }, "No alerts.")),
      el("h2", {}, "Staff and connected-persons exclusion register"),
      el("div", { class: "card" }, c.register.length ? table(["Category", "Phone", "Identity on file", "Note", "Added"], c.register.map((r) =>
        el("tr", {}, td(r.category), td(r.phone ?? "—"), td(r.has_identity ? "Yes" : "No"), td(r.note ?? ""), td(when(r.created_at))))) : el("p", { class: "sub" }, "No entries yet.")));
    if (can("COMPLIANCE")) {
      const form = el("form", { class: "card", onsubmit: action(async () => {
        const body = { category: v(form, "category") };
        if (v(form, "phone")) body.phone = v(form, "phone");
        if (v(form, "idNumber")) { body.idKind = v(form, "idKind"); body.idNumber = v(form, "idNumber"); }
        if (v(form, "note")) body.note = v(form, "note");
        await post("/v1/admin/exclusion-register", body);
        return "Added. This person can no longer buy tickets.";
      }) },
        el("b", {}, "Add to the register"),
        el("div", { class: "form" },
          select("Category", "category", ["STAFF", "DIRECTOR", "CONTRACTOR", "AUDITOR", "SUPPLIER", "FAMILY"].map((x) => [x, x.charAt(0) + x.slice(1).toLowerCase()])),
          input("Phone", { name: "phone", inputmode: "tel" }),
          select("Identity type", "idKind", [["NIN", "NIN"], ["BVN", "BVN"]]),
          input("Identity number (stored only as a fingerprint)", { name: "idNumber", inputmode: "numeric", maxlength: 11 }),
          input("Note", { name: "note", maxlength: 500 }, true)),
        el("div", { class: "actions" }, el("button", { class: "btn ghost", type: "submit" }, "Add")));
      nodes.push(form);
    }
  }
  if (can("COMPLIANCE", "AUDITOR", "SECURITY_ADMIN")) {
    const a = await get("/v1/admin/audit");
    nodes.push(el("h2", {}, "Audit trail"),
      el("div", { class: a.chainIntact ? "note" : "note bad" }, a.chainIntact ? "✓ Audit trail intact: every record links correctly to the one before it." : `⚠ Audit trail broken at record ${a.firstBrokenSeq}. A record has been altered or removed. Escalate immediately.`),
      el("div", { class: "card" }, table(["#No.", "When", "Who", "Action", "Record"], a.entries.map((e) =>
        el("tr", {}, td(e.seq, true), td(when(e.occurred_at)), td(e.actor_type.charAt(0) + e.actor_type.slice(1).toLowerCase()), td(e.action), td(el("span", { class: "mono" }, `${e.entity_type} ${String(e.entity_id).slice(0, 8)}`)))))));
  } else nodes.push(el("p", { class: "sub" }, "The audit trail is visible to compliance, auditors and security administrators."));
  return nodes;
}

// --- Router ------------------------------------------------------------------------------------

const ROUTES = { dashboard, cycles, cycle, approvals, payouts, audit: auditPage };
let renderId = 0;

async function render() {
  const mine = ++renderId;
  const side = document.getElementById("side");
  if (!me) {
    try { me = await get("/v1/admin/me"); } catch { me = null; }
  }
  side.hidden = !me;
  if (!me) { view.replaceChildren(...login()); return; }
  document.getElementById("whoName").textContent = me.fullName;
  document.getElementById("whoRoles").textContent = me.roles.map((r) => ROLE_TEXT[r] ?? r).join(", ");
  const [name = "dashboard", arg] = location.hash.replace(/^#\/?/, "").split("/");
  const screen = ROUTES[name] ?? dashboard;
  const nav = name === "cycle" ? "cycles" : ROUTES[name] ? name : "dashboard";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.nav === nav));
  try {
    const nodes = await screen(arg);
    if (mine !== renderId) return;
    view.replaceChildren(...nodes.flat().filter(Boolean));
  } catch (err) {
    if (mine !== renderId) return;
    if (err.status === 401) { me = null; return render(); }
    view.replaceChildren(el("h1", {}, err.status === 403 ? "Not available for your role" : "Something went wrong"), el("p", { class: "sub" }, err.message));
  }
  // Badge: things waiting for a second person.
  get("/v1/admin/cycles").then(async (l) => {
    let n = l.cycles.filter((c) => c.status === "SUBMITTED").length;
    if (can("FINANCE", "PAYOUT_APPROVER", "COMPLIANCE", "AUDITOR")) n += (await get("/v1/admin/payouts/pending")).payouts.length;
    const badge = document.getElementById("apCount");
    badge.hidden = n === 0; badge.textContent = n;
  }).catch(() => {});
}

document.getElementById("signOut").addEventListener("click", async () => { await post("/v1/admin/logout").catch(() => {}); me = null; location.hash = ""; render(); });
window.addEventListener("hashchange", render);
render();
