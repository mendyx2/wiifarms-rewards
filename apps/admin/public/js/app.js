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

const naira = (kobo) => ((kobo ?? 0) < 0 ? "−₦" : "₦") + (Math.abs(kobo ?? 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });
const num = (n) => Number(n ?? 0).toLocaleString("en-NG");
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const can = (...roles) => roles.some((r) => me.roles.includes(r));
const ROLE_TEXT = { CYCLE_MANAGER: "Cycle manager", FINANCE: "Finance", PAYOUT_APPROVER: "Payout approver", FULFILMENT: "Fulfilment", SUPPORT: "Support", COMPLIANCE: "Compliance", AUDITOR: "Auditor (read-only)", SECURITY_ADMIN: "Security admin", STOCKIST: "Collection centre" };

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
      // The confirmation appears on the updated screen, not on the one being replaced.
      if (done !== false) await render();
      if (message) toast(message);
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

/** Latest reconciliation status, for those allowed to see it. */
async function reconciliationTile() {
  if (!can("FINANCE", "AUDITOR", "COMPLIANCE")) return null;
  const r = await get("/v1/admin/finance/reconciliations");
  const last = r.days[0];
  const tone = r.notReconciled.length || last?.status === "MISMATCH" ? "bad" : last && !last.signed_off_at ? "warn" : "ok";
  return el("a", { class: "tile " + tone, href: "#/finance" }, el("span", {}, "Reconciliation"),
    el("b", {}, r.notReconciled.length ? `${r.notReconciled.length} day${r.notReconciled.length === 1 ? "" : "s"} not reconciled` : last ? (last.status === "MATCHED" ? "Matched" : "Mismatch") : "Nothing to reconcile"),
    el("small", {}, last ? `${last.day}${last.signed_off_at ? " · signed off" : " · awaiting sign-off"}` : ""));
}

const EXPENSE_CATEGORIES = [["STAFF", "Staff"], ["TECHNOLOGY", "Technology"], ["MARKETING", "Marketing"], ["LOGISTICS", "Logistics"], ["LICENSING", "Licensing and regulatory"],
  ["PROFESSIONAL_FEES", "Professional fees"], ["PAYMENT_FEES", "Payment fees"], ["OTHER", "Other"]];
const catText = (c) => (EXPENSE_CATEGORIES.find((x) => x[0] === c) ?? [c, c])[1];
let summaryRange = null;
const SELLING = ["DRAFT", "SUBMITTED", "APPROVED", "COMMITTED", "OPEN"];

async function finance() {
  if (!can("FINANCE", "AUDITOR", "COMPLIANCE")) return [el("h1", {}, "Finance"), el("p", { class: "sub" }, "Your role does not include finance.")];
  const f = can("FINANCE");
  const [rec, results, expenses, cyclesList] = await Promise.all([get("/v1/admin/finance/reconciliations"), get("/v1/admin/finance/cycle-results"),
    get("/v1/admin/finance/expenses"), get("/v1/admin/cycles")]);
  if (!summaryRange) summaryRange = { from: rec.today.slice(0, 8) + "01", to: rec.today };
  const nodes = [el("h1", {}, "Finance"), el("p", { class: "sub" }, "Every figure here is calculated from records that cannot be edited. Days follow Nigerian time.")];

  // Reconciliation
  const money = (t) => t ? `${naira(t.collectedKobo)} in · ${naira(t.refundedKobo)} refunded · ${naira(t.paidOutKobo)} paid out` : "—";
  const signOff = (day, status) => action(async () => {
    const body = { day };
    if (status !== "MATCHED") { const note = prompt("The figures do not match. Explain the difference:"); if (!note) return; body.note = note; }
    await post("/v1/admin/finance/reconciliations/sign-off", body);
    return `${day} signed off.`;
  });
  nodes.push(el("h2", {}, "Daily reconciliation"),
    el("p", { class: "sub" }, "Money through the payment provider each day, counted from the payment, refund and payout records and separately from the ledger — and, once a real provider is connected, against its own statement. Any difference raises a Compliance alert. Yesterday is reconciled automatically; Finance reviews and signs off."));
  if (rec.notReconciled.length) {
    nodes.push(el("div", { class: "note bad" }, `Not yet reconciled: ${rec.notReconciled.join(", ")}`,
      f ? el("div", { class: "actions" }, rec.notReconciled.slice(0, 5).map((day) => el("button", { class: "btn ghost", onclick: action(async () => {
        const r = await post("/v1/admin/finance/reconciliations", { day }); return `${day}: ${r.status === "MATCHED" ? "matched" : "DOES NOT MATCH — see below"}`;
      }) }, "Reconcile " + day))) : null));
  }
  nodes.push(el("div", { class: "card" }, rec.days.length ? table(["Day", "Payment records", "Ledger", "Provider statement", "Result", ""], rec.days.map((r) =>
    el("tr", {}, td(el("b", {}, r.day)), td(money(r.figures.records)), td(money(r.figures.ledger)), td(r.figures.statement ? money(r.figures.statement) : el("span", { class: "sub" }, "not entered")),
      td([pill(r.status === "MATCHED" ? "Matched" : "Mismatch", r.status === "MATCHED" ? "" : "red"), r.note ? el("div", { class: "sub" }, r.note) : null]),
      td(r.signed_off_at ? el("span", { class: "sub" }, `Signed off by ${r.signed_off_by_name}, ${when(r.signed_off_at)}`)
        : f ? el("button", { class: "btn" + (r.status === "MATCHED" ? "" : " danger"), onclick: signOff(r.day, r.status) }, "Sign off") : pill("Awaiting sign-off", "gold")))))
    : el("p", { class: "sub" }, "No days reconciled yet.")));
  if (f) {
    const form = el("form", { class: "card", onsubmit: action(async () => {
      const body = { day: v(form, "day") };
      if (v(form, "sc") || v(form, "sr") || v(form, "sp")) body.statement = { collectedKobo: toKobo(v(form, "sc") || 0), refundedKobo: toKobo(v(form, "sr") || 0), paidOutKobo: toKobo(v(form, "sp") || 0) };
      const r = await post("/v1/admin/finance/reconciliations", body);
      return `${r.day}: ${r.status === "MATCHED" ? "matched" : "DOES NOT MATCH — a Compliance alert has been raised"}`;
    }) }, el("b", {}, "Reconcile a day"),
      el("p", { class: "sub" }, "Optionally enter the totals from the payment provider's statement for that day. Leave them empty to compare records with the ledger only."),
      el("div", { class: "form" }, input("Day", { name: "day", type: "date", required: true, value: rec.today, max: rec.today }),
        input("Statement: collected (₦)", { name: "sc", type: "number", min: 0, step: "0.01" }), input("Statement: refunded (₦)", { name: "sr", type: "number", min: 0, step: "0.01" }),
        input("Statement: paid out (₦)", { name: "sp", type: "number", min: 0, step: "0.01" }), el("button", { class: "btn ghost", type: "submit" }, "Reconcile")));
    nodes.push(form);
  }

  // Cycle results
  nodes.push(el("h2", {}, "Results by cycle"),
    el("div", { class: "card" }, table(["Cycle", "#Net revenue", "#Cash prizes", "#Merchandise (landed cost)", "#Expenses", "#Contribution", "#Prizes / revenue"], results.cycles.filter((c) => c.gross_sales_kobo || c.operating_expenses_kobo || c.merchandise_cost_kobo).map((c) =>
      el("tr", {}, td([el("b", {}, c.name), " ", pill(c.status, STATUS_TONE[c.status]), el("div", { class: "sub" }, `${num(c.cards_sold)} cards · sales ${naira(c.gross_sales_kobo)} · refunds ${naira(c.refunds_kobo)}`)]),
        td(naira(c.net_revenue_kobo), true), td([naira(c.instant_prizes_kobo + c.draw_cash_prizes_kobo - c.forfeited_prizes_kobo), c.forfeited_prizes_kobo ? el("div", { class: "sub" }, `after ${naira(c.forfeited_prizes_kobo)} forfeited`) : null], true),
        td(naira(c.merchandise_cost_kobo), true), td(naira(c.operating_expenses_kobo), true),
        td([el("b", { class: c.contribution_kobo < 0 ? "neg" : "" }, naira(c.contribution_kobo)), SELLING.includes(c.status) ? el("div", { class: "sub" }, "so far") : null], true),
        // While cards are still selling, all prizes are already committed but most revenue is still to come.
        td(c.prize_payout_ratio === null || SELLING.includes(c.status) ? "—" : Math.round(c.prize_payout_ratio * 100) + "%", true)))),
      el("p", { class: "sub" }, "Cash prizes come from the ledger. Merchandise is the landed cost of the units committed to the cycle, counted in full from approval, so a cycle still on sale shows a loss until its cards are sold. Payment provider fees are not yet included: they are recorded as expenses until a real provider is connected."),
      el("div", { class: "actions" }, el("a", { class: "btn ghost", href: "/v1/admin/finance/cycle-results.csv", download: "cycle-results.csv" }, "Download spreadsheet (CSV)"))));

  // Period summary
  const summaryBox = el("div");
  const showSummary = async () => {
    const [s, dd] = await Promise.all([get(`/v1/admin/finance/summary?from=${summaryRange.from}&to=${summaryRange.to}`),
      get(`/v1/admin/reports/deductions?from=${summaryRange.from}&to=${summaryRange.to}`)]);
    summaryBox.replaceChildren(el("div", { class: "tiles" },
      el("div", { class: "tile" }, el("span", {}, "Collected"), el("b", {}, naira(s.collected_kobo)), el("small", {}, `${num(s.purchases)} purchases`)),
      el("div", { class: "tile" }, el("span", {}, "Refunded"), el("b", {}, naira(s.refunded_kobo))),
      el("div", { class: "tile" }, el("span", {}, "Cash prizes awarded"), el("b", {}, naira(s.cash_prizes_kobo))),
      el("div", { class: "tile" }, el("span", {}, "Paid out to winners"), el("b", {}, naira(s.paid_out_kobo))),
      el("div", { class: "tile" }, el("span", {}, "Affiliate fees"), el("b", {}, naira(s.affiliate_fees_kobo))),
      el("div", { class: "tile" }, el("span", {}, "Operating expenses"), el("b", {}, naira(s.operating_expenses_kobo))),
      el("div", { class: "tile " + (s.result_kobo >= 0 ? "ok" : "warn") }, el("span", {}, "Result (before merchandise)"), el("b", {}, naira(s.result_kobo))),
      el("div", { class: "tile " + (s.days_mismatched ? "bad" : "ok") }, el("span", {}, "Reconciliation"), el("b", {}, `${s.days_signed_off} signed off`), el("small", {}, `${s.days_mismatched} with differences`))),
      s.expensesByCategory.length ? el("p", { class: "sub" }, "Expenses: " + s.expensesByCategory.map((x) => `${catText(x.category)} ${naira(x.amount_kobo)}`).join(" · ")) : null,
      el("h3", {}, "Statutory deductions on winnings"),
      dd.warning ? el("div", { class: "note bad" }, dd.warning) : null,
      el("p", { class: "sub" }, `${num(dd.totals.awards)} cash awards · ${naira(dd.totals.gross_kobo)} gross · ${naira(dd.totals.deduction_kobo)} withheld · ${naira(dd.totals.net_kobo)} paid to winners. Held for the tax authority now: ${naira(dd.heldForAuthorityKobo)}.`),
      dd.days.length ? table(["Day", "Cycle", "#Rate", "#Awards", "#Gross", "#Withheld", "#Net"], dd.days.map((x) => el("tr", {},
        td(x.day), td(x.cycle), td(`${x.rate_bp / 100}%`, true), td(num(x.awards), true), td(naira(x.gross_kobo), true), td(naira(x.deduction_kobo), true), td(naira(x.net_kobo), true)))) : null);
  };
  const range = el("form", { class: "form", onsubmit: action(async () => { summaryRange = { from: v(range, "from"), to: v(range, "to") }; await showSummary(); }, false) },
    input("From", { name: "from", type: "date", value: summaryRange.from }), input("To", { name: "to", type: "date", value: summaryRange.to }), el("button", { class: "btn ghost", type: "submit" }, "Show"));
  await showSummary();
  nodes.push(el("h2", {}, "Period summary"), el("div", { class: "card" }, range, el("p"), summaryBox));

  // Operating expenses
  nodes.push(el("h2", {}, "Operating expenses"));
  if (f) {
    const form = el("form", { class: "card", onsubmit: action(async () => {
      const body = { category: v(form, "category"), description: v(form, "description"), amountKobo: toKobo(v(form, "amount")), incurredOn: v(form, "date") };
      if (v(form, "cycle")) body.cycleId = v(form, "cycle"); if (v(form, "payee")) body.payee = v(form, "payee"); if (v(form, "doc")) body.documentRef = v(form, "doc");
      await post("/v1/admin/finance/expenses", body);
      return "Expense recorded.";
    }) }, el("b", {}, "Record an expense"), el("p", { class: "sub" }, "Entries cannot be edited or deleted. A mistake is corrected with a reversal, and both stay on record."),
      el("div", { class: "form" },
        select("Category", "category", EXPENSE_CATEGORIES), input("Amount (₦)", { name: "amount", type: "number", min: 0.01, step: "0.01", required: true }),
        input("Date incurred", { name: "date", type: "date", value: rec.today, max: rec.today, required: true }),
        select("Charge to cycle", "cycle", [["", "Company overhead (no cycle)"], ...cyclesList.cycles.map((c) => [c.id, c.name])]),
        input("Paid to", { name: "payee" }), input("Invoice / receipt reference", { name: "doc" }),
        input("Description", { name: "description", required: true, maxlength: 500 }, true)),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Record expense")));
    nodes.push(form);
  }
  const reverse = (e) => action(async () => {
    const reason = prompt(`Reverse "${e.description}" (${naira(e.amount_kobo)})? Give the reason:`); if (!reason) return;
    await post(`/v1/admin/finance/expenses/${e.id}/reverse`, { reason }); return "Expense reversed. Both entries stay on record.";
  });
  nodes.push(el("div", { class: "card" }, expenses.expenses.length ? table(["Date", "Category", "Description", "Cycle", "#Amount", "Recorded by", ""], expenses.expenses.map((e) =>
    el("tr", {}, td(e.incurred_on), td(catText(e.category)), td([e.description, e.payee || e.document_ref ? el("div", { class: "sub" }, [e.payee, e.document_ref].filter(Boolean).join(" · ")) : null]),
      td(e.cycle ?? "Overhead"), td((e.reverses ? "−" : "") + naira(e.amount_kobo), true), td(e.recorded_by_name),
      td(e.reverses ? pill("Reversal", "grey") : e.reversed_by ? pill("Reversed", "grey") : f ? el("button", { class: "btn ghost", onclick: reverse(e) }, "Reverse") : ""))))
    : el("p", { class: "sub" }, "No expenses recorded yet."),
    el("div", { class: "actions" }, el("a", { class: "btn ghost", href: "/v1/admin/finance/expenses.csv", download: "operating-expenses.csv" }, "Download spreadsheet (CSV)"))));
  return nodes;
}

const ACCESS_TEXT = { GRANT_ROLE: "Give role", REVOKE_ROLE: "Remove role", ENABLE: "Re-enable account" };

async function access() {
  const nodes = [el("h1", {}, "Access & licences")];
  const sec = can("SECURITY_ADMIN");

  // --- Staff access ---
  if (can("SECURITY_ADMIN", "COMPLIANCE", "AUDITOR")) {
    const s = await get("/v1/admin/staff");
    const roleName = (r) => ROLE_TEXT[r] ?? r;
    nodes.push(el("h2", {}, "Staff access"),
      el("p", { class: "sub" }, "Changing anyone's access needs two security administrators, and nobody can change their own. Disabling an account is immediate and signs it out everywhere; re-enabling needs two people. There must always be at least two security administrators."));
    const pending = s.requests.filter((q) => q.status === "PENDING");
    if (pending.length) {
      nodes.push(el("div", { class: "card" }, el("b", {}, "Waiting for a decision"), table(["Person", "Change", "Reason", "Requested by", ""], pending.map((q) =>
        el("tr", {}, td(q.target_name), td(ACCESS_TEXT[q.action] + (q.role ? `: ${roleName(q.role)}` : "")), td(q.reason), td(`${q.requested_by_name} · ${when(q.requested_at)}`),
          td(sec && q.requested_by !== me.id && q.admin_user_id !== me.id ? el("div", { class: "actions" },
            el("button", { class: "btn", onclick: action(async () => { await post(`/v1/admin/staff/requests/${q.id}/decision`, { approve: true }); return "Approved. The change is in effect."; }) }, "Approve"),
            el("button", { class: "btn danger", onclick: action(async () => {
              const reason = prompt("Reason for rejecting:"); if (!reason) return;
              await post(`/v1/admin/staff/requests/${q.id}/decision`, { approve: false, reason }); return "Rejected. Nothing changed.";
            }) }, "Reject")) : pill(q.requested_by === me.id ? "Needs another security admin" : "Needs a security admin", "gold")))))));
    }
    nodes.push(el("div", { class: "card" }, table(["Person", "Roles", "Status", "Last sign-in", ""], s.staff.map((a) => {
      let actions = "";
      if (sec && a.id !== me.id) {
        const form = el("form", { onsubmit: action(async () => {
          const [act, role] = v(form, "change").split(":");
          await post("/v1/admin/staff/requests", { adminUserId: a.id, action: act, ...(role ? { role } : {}), reason: v(form, "reason") });
          return "Request made. Another security administrator must approve it.";
        }) }, el("div", { class: "form" },
          select("Change", "change", a.status === "DISABLED" ? [["ENABLE", "Re-enable account"]]
            : [...s.roles.filter((r) => !a.roles.includes(r)).map((r) => [`GRANT_ROLE:${r}`, `Give: ${roleName(r)}`]), ...a.roles.map((r) => [`REVOKE_ROLE:${r}`, `Remove: ${roleName(r)}`])]),
          input("Reason", { name: "reason", required: true, maxlength: 500 }), el("button", { class: "btn ghost", type: "submit" }, "Request")),
          a.status === "ACTIVE" ? el("div", { class: "actions" }, el("button", { class: "btn danger", type: "button", onclick: action(async () => {
            const reason = prompt(`Disable ${a.full_name} now? They are signed out everywhere at once. Reason:`); if (!reason) return;
            await post(`/v1/admin/staff/${a.id}/disable`, { reason }); return `${a.full_name} disabled and signed out.`;
          }) }, "Disable now")) : null);
        actions = el("details", {}, el("summary", {}, "Change access"), form);
      }
      return el("tr", {}, td([el("b", {}, a.full_name), el("div", { class: "sub" }, a.email)]), td(a.roles.length ? a.roles.map((r) => pill(roleName(r), r === "SECURITY_ADMIN" ? "gold" : "")) : el("span", { class: "sub" }, "No roles")),
        td(a.status === "ACTIVE" ? pill("Active") : pill("Disabled", "red")), td(when(a.last_sign_in)), td(a.id === me.id ? el("span", { class: "sub" }, "You") : actions));
    }))));
    if (sec) {
      const form = el("form", { class: "card", onsubmit: action(async () => {
        await post("/v1/admin/staff", { email: v(form, "email"), fullName: v(form, "name") });
        return "Account created with no roles. Request the roles it needs above.";
      }) }, el("b", {}, "New staff account"), el("p", { class: "sub" }, "The account starts with no roles. In the live service it signs in through company single sign-on."),
        el("div", { class: "form" }, input("Full name", { name: "name", required: true }), input("Work email", { name: "email", type: "email", required: true }), el("button", { class: "btn ghost", type: "submit" }, "Create account")));
      nodes.push(form);
    }
    const decided = s.requests.filter((q) => q.status !== "PENDING");
    if (decided.length) nodes.push(el("details", { class: "card" }, el("summary", {}, `History of access changes (${decided.length})`), table(["When", "Person", "Change", "Requested by", "Decision"], decided.map((q) =>
      el("tr", {}, td(when(q.decided_at)), td(q.target_name), td([ACCESS_TEXT[q.action] + (q.role ? `: ${roleName(q.role)}` : ""), el("div", { class: "sub" }, q.reason)]), td(q.requested_by_name),
        td([pill(q.status.toLowerCase(), q.status === "APPROVED" ? "" : "grey"), el("div", { class: "sub" }, `${q.decided_by_name}${q.decision_reason ? ": " + q.decision_reason : ""}`)]))))));
  }

  // --- Licences and certifications ---
  if (can("COMPLIANCE", "FINANCE", "AUDITOR", "SECURITY_ADMIN")) {
    const L = await get("/v1/admin/licensing");
    const state = (x) => x.status === "REVOKED" ? pill("Revoked", "red") : x.status === "PENDING" ? pill("Awaiting verification", "gold") : x.in_force ? pill("In force") : pill("Verified, not in date", "grey");
    const verifyBtn = (kind, x) => x.status === "PENDING" && can("COMPLIANCE", "FINANCE") && x.recorded_by !== me.id
      ? el("button", { class: "btn", onclick: action(async () => {
        if (!confirm("Have you checked the original document and its details? Verifying makes this record count towards the real-money gate.")) return;
        await post(`/v1/admin/${kind}/${x.id}/verify`); return "Verified.";
      }) }, "Verify") : null;
    const revokeBtn = (kind, x) => x.status !== "REVOKED" && can("COMPLIANCE") ? el("button", { class: "btn danger", onclick: action(async () => {
      const reason = prompt("Reason for revoking (takes effect at once):"); if (!reason) return;
      await post(`/v1/admin/${kind}/${x.id}/revoke`, { reason }); return "Revoked. A Compliance alert has been raised.";
    }) }, "Revoke") : null;
    const who = (x) => el("div", { class: "sub" }, `Recorded by ${x.recorded_by_name}` + (x.verified_by_name ? ` · verified by ${x.verified_by_name}` : "") + (x.revoke_reason ? ` · revoked: ${x.revoke_reason}` : ""));
    nodes.push(el("h2", {}, "Licences and certifications"),
      el("div", { class: "tiles" },
        el("div", { class: "tile " + (L.gate.licenceInForce ? "ok" : "warn") }, el("span", {}, "Niger State licence"), el("b", {}, L.gate.licenceInForce ? "In force" : "None in force")),
        el("div", { class: "tile " + (L.gate.engineCertified ? "ok" : "warn") }, el("span", {}, "Game engine certification"), el("b", {}, L.gate.engineCertified ? "Certified" : "Not certified"), el("small", {}, L.currentEngineVersion)),
        el("div", { class: "tile warn" }, el("span", {}, "Real-money sales"), el("b", {}, "Not available"), el("small", {}, "Phase 2 is simulation only, whatever the records say"))),
      el("p", { class: "sub" }, "Compliance records each licence and certificate with its document; someone else in Compliance or Finance checks the original and verifies it. Only verified, in-date, unrevoked records open the real-money gate, and the database enforces this. Records cannot be edited or deleted; revoking takes effect at once."),
      el("div", { class: "card" }, el("b", {}, "Licences"), L.licences.length ? table(["Licence", "Valid", "Document", "Status", ""], L.licences.map((x) =>
        el("tr", {}, td([el("b", {}, x.licence_number), el("div", { class: "sub" }, `${x.authority} · ${x.state_code === "NG-NI" ? "Niger State" : x.state_code}`), who(x)]), td(`${x.valid_from} to ${x.valid_to}`), td(el("span", { class: "mono" }, x.document_ref)),
          td(state(x)), td(el("div", { class: "actions" }, verifyBtn("licences", x), revokeBtn("licences", x))))))
        : el("p", { class: "sub" }, "No licence recorded.")),
      el("div", { class: "card" }, el("b", {}, "Certifications"), L.certifications.length ? table(["Certificate", "Component", "Valid", "Status", ""], L.certifications.map((x) =>
        el("tr", {}, td([el("b", {}, x.certificate_ref), el("div", { class: "sub" }, x.lab), who(x)]), td([x.component.replace("_", " ").toLowerCase(), el("div", { class: "mono" }, x.component_version)]),
          td(`${x.valid_from} to ${x.valid_to ?? "no end date"}`), td(state(x)), td(el("div", { class: "actions" }, verifyBtn("certifications", x), revokeBtn("certifications", x))))))
        : el("p", { class: "sub" }, "No certification recorded.")));
    if (can("COMPLIANCE")) {
      const lf = el("form", { class: "card", onsubmit: action(async () => {
        await post("/v1/admin/licences", { stateCode: "NG-NI", authority: v(lf, "authority"), licenceNumber: v(lf, "number"), validFrom: v(lf, "from"), validTo: v(lf, "to"), documentRef: v(lf, "doc") });
        return "Licence recorded. Someone else must verify it.";
      }) }, el("b", {}, "Record a licence (Niger State)"), el("div", { class: "form" },
        input("Issuing authority", { name: "authority", required: true }), input("Licence number", { name: "number", required: true }),
        input("Valid from", { name: "from", type: "date", required: true }), input("Valid to", { name: "to", type: "date", required: true }),
        input("Document reference", { name: "doc", required: true }), el("button", { class: "btn ghost", type: "submit" }, "Record licence")));
      const cf = el("form", { class: "card", onsubmit: action(async () => {
        const b = { component: v(cf, "component"), componentVersion: v(cf, "version"), lab: v(cf, "lab"), certificateRef: v(cf, "ref"), validFrom: v(cf, "from") };
        if (v(cf, "to")) b.validTo = v(cf, "to");
        await post("/v1/admin/certifications", b); return "Certification recorded. Someone else must verify it.";
      }) }, el("b", {}, "Record a certification"), el("div", { class: "form" },
        select("Component", "component", [["GAME_CORE", "Game engine"], ["DRAW", "Final draw"], ["PLATFORM_SECURITY", "Platform security"]]),
        input("Exact version certified", { name: "version", required: true, value: L.currentEngineVersion }), input("Test lab", { name: "lab", required: true }),
        input("Certificate reference", { name: "ref", required: true }), input("Valid from", { name: "from", type: "date", required: true }), input("Valid to (if any)", { name: "to", type: "date" }),
        el("button", { class: "btn ghost", type: "submit" }, "Record certification")));
      nodes.push(el("div", { class: "grid2" }, lf, cf));
    }
  }
  if (nodes.length === 1) nodes.push(el("p", { class: "sub" }, "Your role does not include access or licensing."));
  return nodes;
}

let nokLookup = "";
async function nokPage() {
  if (!can("COMPLIANCE", "FINANCE", "AUDITOR", "SUPPORT")) return [el("h1", {}, "Next of kin"), el("p", { class: "sub" }, "Your role does not include next-of-kin claims.")];
  const nodes = [el("h1", {}, "Next-of-kin claims"),
    el("p", { class: "sub" }, "When a winner has died or cannot be reached, the next of kin they recorded may receive their waiting prizes and winnings. Compliance opens a case with the documents; the winner is told at once; after a 7-day wait someone else in Compliance or Finance decides. If the winner signs in during the wait, the case cannot go ahead.")];

  // Look up a winner
  const found = el("div");
  const showLookup = async (phone) => {
    const r = await get("/v1/admin/nok/lookup?phone=" + encodeURIComponent(phone));
    const kids = [
      el("div", { class: "tiles" },
        el("div", { class: "tile" }, el("span", {}, "Winner"), el("b", {}, r.winner.name ?? "Not verified"), el("small", {}, `${r.winner.phone} · ${r.winner.status.toLowerCase()}`)),
        el("div", { class: "tile " + (r.nextOfKin ? "ok" : "warn") }, el("span", {}, "Next of kin on record"), el("b", {}, r.nextOfKin ? r.nextOfKin.name : "None recorded"), el("small", {}, r.nextOfKin ? `${r.nextOfKin.relationship} · ${r.nextOfKin.phone}` : "No one can claim through this process")),
        el("div", { class: "tile" }, el("span", {}, "Winnings not withdrawn"), el("b", {}, naira(r.winningsKobo)))),
      r.waitingPrizes.length ? table(["Prize waiting", "Cycle", "Claim by"], r.waitingPrizes.map((p) => el("tr", {}, td(p.title), td(p.cycle), td(when(p.expires_at))))) : el("p", { class: "sub" }, "No prizes waiting to be claimed."),
    ];
    if (can("COMPLIANCE") && r.nextOfKin) {
      const form = el("form", { onsubmit: action(async () => {
        const docs = v(form, "docs").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
        const c = await post("/v1/admin/nok/cases", { winnerPhone: phone, claimantPhone: v(form, "claimant"), reason: v(form, "reason"), documents: docs, note: v(form, "note") });
        return `Case opened. The winner has been told. It can be decided from ${when(c.decideFrom)} by someone else.`;
      }) }, el("h2", {}, "Open a case"), el("div", { class: "form" },
        select("Reason", "reason", [["DECEASED", "The winner has died"], ["UNREACHABLE", "The winner cannot be reached"]]),
        input("Claimant's phone (must be the next of kin on record)", { name: "claimant", inputmode: "tel", required: true }),
        input("Documents seen (one per line: death certificate, claimant ID, record of attempts to reach the winner)", { name: "docs", rows: 3, required: true }, true),
        input("Case notes", { name: "note", rows: 2, required: true }, true)),
        el("p", { class: "sub" }, "The claimant needs their own account with verified identity, matching the recorded name."),
        el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Open case")));
      kids.push(form);
    }
    found.replaceChildren(el("div", { class: "card" }, ...kids));
  };
  const lookup = el("form", { class: "card", onsubmit: action(async () => { nokLookup = v(lookup, "phone"); await showLookup(nokLookup); }, false) },
    el("b", {}, "Find the winner"), el("div", { class: "form" }, input("Winner's phone number", { name: "phone", inputmode: "tel", required: true, value: nokLookup }), el("button", { class: "btn ghost", type: "submit" }, "Look up")));
  nodes.push(lookup, found);
  if (nokLookup) showLookup(nokLookup).catch(() => {});

  // Cases
  if (can("COMPLIANCE", "FINANCE", "AUDITOR")) {
    const { cases } = await get("/v1/admin/nok/cases");
    const decide = (c, approve) => action(async () => {
      const body = { approve };
      if (approve && !confirm("Pass the winner's waiting prizes and winnings to the claimant? This cannot be undone.")) return;
      if (!approve) { const reason = prompt("Reason for rejecting:"); if (!reason) return; body.reason = reason; }
      const r = await post(`/v1/admin/nok/cases/${c.id}/decision`, body);
      return approve ? `Approved: ${r.transferred.prizeClaims.length} prize(s) and ${naira(r.transferred.winningsKobo)} passed to the claimant.` : "Rejected. Nothing was passed on.";
    });
    nodes.push(el("h2", {}, "Cases"), el("div", { class: "card" }, cases.length ? table(["Winner", "Claimant", "Reason and documents", "Opened", "Status", ""], cases.map((c) => {
      const ready = new Date(c.decide_from).getTime() <= Date.now();
      let act = "";
      if (c.status === "OPEN") {
        if (c.winner_signed_in_since) act = el("div", {}, pill("Winner signed in — contact them", "red"), can("COMPLIANCE", "FINANCE") && c.opened_by !== me.id ? el("div", { class: "actions" }, el("button", { class: "btn danger", onclick: decide(c, false) }, "Reject")) : null);
        else if (!ready) act = pill("Waiting until " + when(c.decide_from), "gold");
        else if (can("COMPLIANCE", "FINANCE") && c.opened_by !== me.id) act = el("div", { class: "actions" }, el("button", { class: "btn", onclick: decide(c, true) }, "Approve"), el("button", { class: "btn danger", onclick: decide(c, false) }, "Reject"));
        else act = pill(c.opened_by === me.id ? "Needs someone else" : "Needs Compliance or Finance", "gold");
      }
      return el("tr", {}, td(`${c.winner_name ?? "—"} (${c.winner_phone})`), td(`${c.claimant_name} (${c.claimant_phone})`),
        td([c.reason === "DECEASED" ? "Winner has died" : "Winner unreachable", el("div", { class: "sub" }, c.documents.join(", ")), el("div", { class: "sub" }, c.note)]),
        td(`${c.opened_by_name} · ${when(c.opened_at)}`),
        td([pill(c.status.toLowerCase(), c.status === "APPROVED" ? "" : c.status === "OPEN" ? "gold" : "grey"),
          c.decided_by_name ? el("div", { class: "sub" }, `${c.decided_by_name}${c.decision_reason ? ": " + c.decision_reason : ""}`) : null,
          c.transferred ? el("div", { class: "sub" }, `${c.transferred.prizeClaims.length} prize(s), ${naira(c.transferred.winningsKobo)} passed on`) : null]),
        td(act));
    })) : el("p", { class: "sub" }, "No cases.")));
  }
  return nodes;
}

const TOPIC_TEXT = { PAYMENT: "Payment", PRIZE: "Prize", ACCOUNT: "Account", TECHNICAL: "Technical", COMPLAINT: "Complaint", OTHER: "Other" };
const TICKET_TONE = { OPEN: "gold", WAITING_PLAYER: "", CLOSED: "grey" };
const TICKET_STATUS = { OPEN: "Needs reply", WAITING_PLAYER: "Waiting for player", CLOSED: "Closed" };
let supportLookup = "", supportFilter = "";

async function supportPage() {
  if (!can("SUPPORT", "COMPLIANCE", "AUDITOR")) return [el("h1", {}, "Support"), el("p", { class: "sub" }, "Your role does not include support.")];
  const act = can("SUPPORT", "COMPLIANCE");
  const nodes = [el("h1", {}, "Support"),
    el("div", { class: "lock" }, "Never reset a PIN, change a phone number, raise a limit or move money for a caller — and never ask for a PIN or a code. Players do those themselves, with a code sent to their own phone. If you suspect someone is trying to take over an account, lock it.")];

  // Player lookup
  const found = el("div");
  const show = async (phone) => {
    const r = await get("/v1/admin/support/player?phone=" + encodeURIComponent(phone));
    const pl = r.player;
    const kids = [el("div", { class: "tiles" },
      el("div", { class: "tile " + (r.lock ? "bad" : pl.status === "ACTIVE" ? "ok" : "warn") }, el("span", {}, pl.phone), el("b", {}, pl.name ?? "Not verified"),
        el("small", {}, `${r.lock ? "Locked" : pl.status === "ACTIVE" ? "Active" : pl.status.toLowerCase()} · ${pl.verified ? "verified" : "not verified"} · since ${when(pl.since)}${pl.pinLocked ? " · PIN locked after wrong attempts" : ""}`)),
      el("div", { class: "tile" }, el("span", {}, "Spending limit"), el("b", {}, r.limits ? naira(r.limits.daily_kobo) + " a day" : "—"), el("small", {}, r.exclusion ? `On a ${r.exclusion.kind === "COOL_OFF" ? "break" : "self-exclusion"}${r.exclusion.ends_at ? " until " + when(r.exclusion.ends_at) : ""}` : "")),
      el("div", { class: "tile" }, el("span", {}, "Winnings"), el("b", {}, naira(r.winningsKobo)), el("small", {}, r.owedKobo ? `owes ${naira(r.owedKobo)}` : "")),
      el("div", { class: "tile" }, el("span", {}, "Cards"), el("b", {}, num(r.cards.total)), el("small", {}, `${num(r.cards.revealed)} scratched · ${num(r.cards.cancelled)} cancelled`)))];
    if (r.lock) {
      kids.push(el("div", { class: "note bad" }, `Locked by ${r.lock.locked_by_name} on ${when(r.lock.locked_at)}: ${r.lock.reason}`));
      if (can("COMPLIANCE")) kids.push(el("div", { class: "actions" }, el("button", { class: "btn", onclick: action(async () => {
        const reason = prompt("How was the player's identity confirmed?"); if (!reason) return;
        await post(`/v1/admin/support/player/${pl.id}/unlock`, { reason }); await show(phone); return "Account unlocked.";
      }, false) }, "Unlock (Compliance, not the person who locked it)")));
    } else if (act && pl.status === "ACTIVE") {
      kids.push(el("div", { class: "actions" }, el("button", { class: "btn danger", onclick: action(async () => {
        const reason = prompt("Why lock this account? (It signs the player out everywhere at once.)"); if (!reason) return;
        await post(`/v1/admin/support/player/${pl.id}/lock`, { reason }); await show(phone); return "Account locked and signed out. Compliance must unlock it.";
      }, false) }, "Lock account")));
    }
    const sect = (title, rows, head, fn) => rows.length ? [el("h2", {}, title), table(head, rows.map(fn))] : [];
    kids.push(...sect("Purchases", r.orders, ["When", "Cycle", "#Cards", "#Amount", "Status"], (o) => el("tr", {}, td(when(o.created_at)), td(o.cycle), td(num(o.quantity), true), td(naira(o.amount_kobo), true), td(o.status.toLowerCase()))),
      ...sect("Prizes", r.claims, ["Prize", "Status", "Claim by"], (c) => el("tr", {}, td(c.title + (c.claimed_by_next_of_kin ? " (next of kin)" : "")), td(c.status.toLowerCase()), td(when(c.expires_at)))),
      ...sect("Withdrawals", r.payouts, ["When", "#Amount", "Status"], (p) => el("tr", {}, td(when(p.created_at)), td(naira(p.amount_kobo), true), td(p.status.toLowerCase()))),
      ...sect("Bank accounts", r.bankAccounts, ["Bank code", "Name matches", "Usable from"], (b) => el("tr", {}, td(b.bank_code), td(b.name_match ? "Yes" : "No"), td(when(b.usable_from)))),
      ...sect("Text messages sent", r.texts, ["When", "Message", "Status"], (t) => el("tr", {}, td(when(t.created_at)), td(t.body), td(t.status.toLowerCase()))),
      ...sect("Requests", r.tickets, ["Updated", "Subject", "Status"], (t) => el("tr", {}, td(when(t.updated_at)), td(el("a", { href: "#/ticket/" + t.id }, t.subject)), td(TICKET_STATUS[t.status]))));
    found.replaceChildren(el("div", { class: "card" }, ...kids));
  };
  const look = el("form", { class: "card", onsubmit: action(async () => { supportLookup = v(look, "phone"); await show(supportLookup); }, false) },
    el("b", {}, "Find a player"), el("p", { class: "sub" }, "Every lookup is recorded in the audit trail."),
    el("div", { class: "form" }, input("Phone number", { name: "phone", inputmode: "tel", required: true, value: supportLookup }), el("button", { class: "btn ghost", type: "submit" }, "Look up")));
  nodes.push(look, found);
  if (supportLookup) show(supportLookup).catch(() => {});

  // Queue
  const { tickets } = await get("/v1/admin/support/tickets" + (supportFilter ? "?status=" + supportFilter : ""));
  nodes.push(el("h2", {}, "Requests"),
    el("div", { class: "chips" }, [["", "All"], ["OPEN", "Needs reply"], ["WAITING_PLAYER", "Waiting for player"], ["CLOSED", "Closed"]].map(([v2, t]) =>
      el("button", { class: "btn ghost" + (supportFilter === v2 ? " on" : ""), onclick: () => { supportFilter = v2; render(); } }, t))),
    el("div", { class: "card" }, tickets.length ? table(["Updated", "Player", "Topic", "Subject", "Status"], tickets.map((t) =>
      el("tr", {}, td(when(t.updated_at)), td(`${t.player_name ?? "—"} (${t.player_phone})`), td(TOPIC_TEXT[t.topic]),
        td([el("a", { href: "#/ticket/" + t.id }, t.subject), t.escalated ? " " : null, t.escalated ? pill("Compliance", "red") : null]),
        td(pill(TICKET_STATUS[t.status], TICKET_TONE[t.status]))))) : el("p", { class: "sub" }, "No requests.")));
  return nodes;
}

async function ticketPage(id) {
  const t = await get("/v1/admin/support/tickets/" + id);
  const act = can("SUPPORT", "COMPLIANCE") && t.status !== "CLOSED";
  const nodes = [el("a", { href: "#/support" }, "← Support"), el("h1", {}, t.subject),
    el("p", { class: "sub" }, `${t.player_name ?? "—"} (${t.player_phone}) · ${TOPIC_TEXT[t.topic]} · opened ${when(t.created_at)} · `, pill(TICKET_STATUS[t.status], TICKET_TONE[t.status]), t.escalated ? " " : null, t.escalated ? pill("Passed to Compliance", "red") : null),
    el("div", { class: "card" }, t.messages.map((m) => el("div", { class: "check" + (m.author === "STAFF" ? " yes" : "") }, el("i", {}, m.author === "STAFF" ? "S" : "P"),
      el("div", {}, m.body, el("small", {}, `${m.author === "STAFF" ? m.staff_name : "Player"} · ${when(m.created_at)}`)))))];
  if (act) {
    const form = el("form", { class: "card", onsubmit: action(async (e) => {
      const close = e.submitter?.dataset.close === "1";
      await post(`/v1/admin/support/tickets/${id}/reply`, { message: v(form, "message"), close });
      return close ? "Replied and closed. The player has been told." : "Reply sent. The player has been told by text.";
    }) }, el("div", { class: "form" }, input("Reply (the player sees it in the app; the text only says a reply is waiting)", { name: "message", rows: 4, required: true, maxlength: 2000 }, true)),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Send reply"), el("button", { class: "btn ghost", type: "submit", "data-close": "1" }, "Send and close")));
    nodes.push(form, el("div", { class: "actions" },
      el("button", { class: "btn ghost", onclick: action(async () => { await post(`/v1/admin/support/tickets/${id}/close`); return "Closed."; }) }, "Close without reply"),
      can("SUPPORT") && !t.escalated ? el("button", { class: "btn danger", onclick: action(async () => {
        const reason = prompt("Why does Compliance need to look at this?"); if (!reason) return;
        await post(`/v1/admin/support/tickets/${id}/escalate`, { reason }); return "Passed to Compliance.";
      }) }, "Pass to Compliance") : null));
  }
  return nodes;
}

async function dashboard() {
  const d = await get("/v1/admin/dashboard");
  const live = d.cycles.find((c) => ["OPEN", "CLOSED", "DRAWN", "SETTLING"].includes(c.status)) ?? d.cycles[0];
  const nodes = [el("h1", {}, "Dashboard"), el("p", { class: "sub" }, "All figures are calculated from ticket records and the ledger — none are typed in.")];
  if (live && !live.winnings_tax_bp) {
    nodes.push(el("div", { class: "note bad" }, "The deduction rate on winnings is 0% for this campaign. Confirm the statutory rate with legal and finance and set it (WR_WINNINGS_TAX_BP) before the next campaign is created; it is fixed on each campaign when it is created."));
  }
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
    el("div", { class: "tile" }, el("span", {}, "Deductions held for the tax authority"), el("b", {}, naira(d.totals.deductions_held_kobo))),
    el("div", { class: "tile" }, el("span", {}, "Affiliate fees owed"), el("b", {}, naira(d.totals.affiliate_fees_owed_kobo)), el("small", {}, `${d.pending.affiliate_applications} applications to review`)),
    el("div", { class: "tile " + (d.totals.ledger_balanced ? "ok" : "bad") }, el("span", {}, "Ledger"), el("b", {}, d.totals.ledger_balanced ? "Balanced" : "OUT OF BALANCE"), el("small", {}, "debits equal credits")),
    el("div", { class: "tile " + (d.pending.alerts ? "bad" : "ok") }, el("span", {}, "Compliance alerts"), el("b", {}, d.pending.alerts + " open")),
    await reconciliationTile()));
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
        name: v(form, "name"), ticketPriceKobo: toKobo(v(form, "price")), totalTickets: Number(v(form, "total")), maxTicketsPerAccount: Number(v(form, "cap")), levels: Number(v(form, "levels")),
        salesOpenAt: new Date(v(form, "open")).toISOString(), salesCloseAt: new Date(v(form, "close")).toISOString(), drawAt: new Date(v(form, "draw")).toISOString() });
      location.hash = "#/cycle/" + r.id;
    }, false) },
      el("b", {}, "New cycle"), el("p", { class: "sub" }, "All cycles are simulated. Ticket price must be ₦200–₦500. Company policy fixed on each cycle: prizes total at most 50% of full sell-out sales, instant cash at most 5% of that, and each player can buy at most 10 cards a day. A season runs 90 days. Cards are sold in levels, one after another, each holding an equal share of the instant prizes (players are not shown the levels). Defaults are the inaugural campaign (SRS): 2,686,000 cards at ₦500."),
      el("div", { class: "form" },
        input("Name", { name: "name", required: true, maxlength: 120 }),
        input("Ticket price (₦)", { name: "price", type: "number", min: 200, max: 500, step: 50, value: 500, required: true }),
        input("Number of tickets", { name: "total", type: "number", min: 1, max: 10000000, value: 2686000, required: true }),
        input("Most tickets per player in the season", { name: "cap", type: "number", min: 1, value: 900, required: true }),
        input("Levels (instant cash released level by level)", { name: "levels", type: "number", min: 1, max: 20, value: 4, required: true }),
        input("Sales open", { name: "open", type: "datetime-local", value: localInput(new Date(now)), required: true }),
        input("Sales close (or sell-out)", { name: "close", type: "datetime-local", value: localInput(new Date(now + 90 * 864e5)), required: true }),
        input("Final draw", { name: "draw", type: "datetime-local", value: localInput(new Date(now + 90 * 864e5)), required: true })),
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
  if (c.status === "VOID") {
    const v = c.voidRequests.find((x) => x.status === "APPROVED");
    nodes.push(el("div", { class: "note bad" }, `This cycle was cancelled${v ? ` on ${when(v.decided_at)} (requested by ${v.requested_by_name}, approved by ${v.decided_by_name}): ${v.reason}` : ""}. ` +
      `${num(c.refunds.n)} purchases refunded in full (${naira(c.refunds.kobo)}). Instant prizes already revealed were honoured.`));
  }
  if (!c.editable && c.status !== "VOID") nodes.push(el("div", { class: "lock" }, "🔒 Locked. Price, quantities, prizes, odds and dates were fixed at approval and cannot be changed by anyone."));

  // Key facts
  nodes.push(el("div", { class: "tiles" },
    el("div", { class: "tile" }, el("span", {}, "Sold"), el("b", {}, `${num(c.counts.sold)} / ${num(c.total_tickets)}`), el("small", {}, `${num(c.counts.revealed)} scratched`)),
    el("div", { class: "tile" }, el("span", {}, "Sales window"), el("b", {}, when(c.sales_close_at)), el("small", {}, "opens " + when(c.sales_open_at) + " · closes then or at sell-out")),
    el("div", { class: "tile" }, el("span", {}, "Final draw"), el("b", {}, when(c.draw_at)), el("small", {}, `claims open ${c.claim_window_days} days`)),
    c.level && c.level.levels > 1 ? el("div", { class: "tile" }, el("span", {}, "Level on sale (staff only)"), el("b", {}, `${c.level.current} of ${c.level.levels}`),
      el("small", {}, `${num(c.level.leftInLevel)} of ${num(c.level.size)} cards left · ${naira(c.level.instantCashInLevelKobo)} instant cash in this level`)) : null,
    el("div", { class: "tile " + ((c.escrow_funded_kobo ?? 0) >= c.cashCoverRequiredKobo ? "ok" : "warn") }, el("span", {}, "Cash prizes to cover"), el("b", {}, naira(c.cashCoverRequiredKobo)), el("small", {}, c.escrow_reference ? `escrow ${c.escrow_reference}: ${naira(c.escrow_funded_kobo)}` : "escrow not recorded yet"))));

  // Prize budget: company policy, fixed on the cycle when drafted.
  const b = c.budget;
  const meter = (label, used, cap, note) => el("div", { class: "tile " + (used > cap ? "warn" : "ok") }, el("span", {}, label),
    el("b", {}, `${naira(used)} of ${naira(cap)}`), el("small", {}, used > cap ? `${naira(used - cap)} over — approval will be refused` : `${naira(cap - used)} unallocated · ${note}`));
  nodes.push(el("h2", {}, "Prize budget"), el("div", { class: "tiles" },
    el("div", { class: "tile" }, el("span", {}, "Prize money"), el("b", {}, naira(b.poolKobo)), el("small", {}, `${b.prizeShareBp / 100}% of ${naira(b.fullSalesKobo)} full sell-out sales`)),
    meter("Instant cash", b.instantKobo, b.instantBudgetKobo, `${b.instantShareBp / 100}% of prize money`),
    meter("Final draw (merchandise at advertised value)", b.drawKobo, b.drawBudgetKobo, "the rest of the prize money")),
    el("p", { class: "sub" }, `If not every card sells, the advertised prizes are still given, so prizes become a larger share of actual sales. Each player can buy at most ${num(c.max_tickets_per_day)} cards a day.`));

  // Prize schedule
  // Pictures can be added or replaced until sales open (the database enforces this).
  const picturesOpen = ["DRAFT", "SUBMITTED", "APPROVED", "COMMITTED"].includes(c.status) && can("CYCLE_MANAGER");
  const picture = (t) => [t.has_image ? el("img", { class: "thumb", src: `/v1/prize-images/${t.id}?v=${Date.now()}`, alt: t.title }) : el("span", { class: "sub" }, "none"),
    picturesOpen && t.stage === "FINAL_DRAW" ? imageUpload(t.id) : null];
  const tierRows = c.tiers.map((t) => el("tr", {}, td(t.stage === "INSTANT" ? "Instant" : "Final draw #" + t.draw_order), td(t.title + (t.sku_name && t.sku_name !== t.title ? ` (${t.sku_name})` : "")),
    td(t.kind === "CASH" ? naira(t.cash_kobo) : "Merchandise", true), td(num(t.quantity), true), td(num(t.awarded), true), td(t.stage === "FINAL_DRAW" ? picture(t) : "")));
  nodes.push(el("h2", {}, "Prize schedule"), el("div", { class: "card" }, c.tiers.length ? table(["Stage", "Prize", "#Value", "#Quantity", "#Awarded", "Picture"], tierRows) : el("p", { class: "sub" }, "No prizes yet."),
    el("p", { class: "sub" }, picturesOpen ? "Final-draw prizes can have a picture (PNG, JPEG or WebP, up to 1 MB) until sales open." : "Prize pictures are fixed once sales open."),
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

  // Merchandise prizes must be covered by stock in the warehouse before approval.
  if (c.stockCover.length) {
    const covered = c.stockCover.every((x) => x.reserved >= x.needed);
    nodes.push(el("h2", {}, "Merchandise prizes secured"), el("div", { class: "card" },
      table(["Item", "#Needed", "#Reserved for this cycle", "#Free in warehouse"], c.stockCover.map((x) =>
        el("tr", {}, td(x.item), td(num(x.needed), true), td(x.reserved >= x.needed ? pill(`${x.reserved} ✓`) : pill(`${x.reserved} of ${x.needed}`, "red"), true), td(num(x.inStock), true)))),
      el("p", { class: "sub" }, covered ? "Every merchandise prize is in the warehouse and set aside for this cycle. It cannot be released while the cycle is live."
        : "Not yet covered. The cycle cannot be approved until Fulfilment has received and reserved the stock."),
      c.editable && !covered && can("FULFILMENT") ? el("div", { class: "actions" }, el("button", { class: "btn", onclick: action(async () => {
        const r = await post(`/v1/admin/cycles/${id}/reserve-stock`);
        return r.complete ? "Stock reserved for every merchandise prize." : "Reserved what is available. More stock must be received first.";
      }) }, "Reserve stock for this cycle")) : null));
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
    c.stockCover.length ? el("div", { class: "check" + (c.stockCover.every((x) => x.reserved >= x.needed) ? " yes" : "") }, el("i", {}, c.stockCover.every((x) => x.reserved >= x.needed) ? "✓" : "·"),
      el("div", {}, "Merchandise prizes in the warehouse and reserved", el("small", {}, "Confirmed by Fulfilment, not by the people drafting or approving"))) : null,
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

  // Cancelling the cycle (two people)
  if (["APPROVED", "COMMITTED", "OPEN", "CLOSED"].includes(c.status)) {
    const pending = c.voidRequests.find((x) => x.status === "PENDING");
    const box = el("div", { class: "card" }, el("b", {}, "Cancel this cycle"),
      el("p", { class: "sub" }, "Only for serious reasons (regulator instruction, a prize that cannot be delivered, an integrity problem). Every purchase is refunded in full to the payment it came from; instant prizes already revealed stay with their winners; reserved merchandise goes back into stock. It needs two different people and is reported to Compliance."));
    if (pending) {
      box.append(el("div", { class: "note bad" }, `Cancellation requested by ${pending.requested_by_name} on ${when(pending.requested_at)}: ${pending.reason}`));
      if (can("FINANCE", "COMPLIANCE") && pending.requested_by !== me.id) {
        box.append(el("div", { class: "actions" },
          el("button", { class: "btn danger", onclick: action(async () => {
            if (!confirm(`Cancel "${c.name}" and refund every purchase? This cannot be undone.`)) return;
            const r = await post(`/v1/admin/cycles/${id}/void/decision`, { approve: true });
            return `Cycle cancelled. ${r.refunds} purchase${r.refunds === 1 ? "" : "s"} refunded (${naira(r.refundedKobo)}).`;
          }) }, "Approve cancellation"),
          el("button", { class: "btn ghost", onclick: action(async () => {
            const reason = prompt("Why should the cycle continue?"); if (!reason) return;
            await post(`/v1/admin/cycles/${id}/void/decision`, { approve: false, reason }); return "Cancellation rejected. The cycle continues.";
          }) }, "Reject")));
      } else box.append(el("p", { class: "sub" }, pending.requested_by === me.id ? "Waiting for someone else in Finance or Compliance to decide." : "Waiting for Finance or Compliance to decide."));
    } else if (can("CYCLE_MANAGER", "COMPLIANCE")) {
      const form = el("form", { onsubmit: action(async () => { await post(`/v1/admin/cycles/${id}/void`, { reason: v(form, "reason") }); return "Cancellation requested. A second person must approve it."; }) },
        el("div", { class: "form" }, input("Reason", { name: "reason", required: true, maxlength: 1000 }, true)),
        el("div", { class: "actions" }, el("button", { class: "btn danger", type: "submit" }, "Request cancellation")));
      box.append(form);
    }
    const past = c.voidRequests.filter((x) => x.status === "REJECTED");
    if (past.length) box.append(el("p", { class: "sub" }, past.map((x) => `Earlier request by ${x.requested_by_name} rejected by ${x.decided_by_name}: ${x.decision_reason}`).join(" · ")));
    nodes.push(el("h2", {}, "Cancellation"), box);
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

  // Close-out and archive (two people)
  if (["DRAWN", "SETTLING", "ARCHIVED"].includes(c.status)) {
    const box = el("div", { class: "card" });
    if (c.status === "ARCHIVED") {
      box.append(el("div", { class: "check yes" }, el("i", {}, "✓"), el("div", {}, "Archived",
        el("small", {}, `Requested by ${c.archive_requested_by_name} on ${when(c.archive_requested_at)} · confirmed by ${c.archived_by_name} on ${when(c.archived_at)}`))),
        el("p", { class: "sub" }, `All ${num(c.total_tickets)} cards — sold, unsold and cancelled — are published with their outcomes. Anyone can rebuild the fingerprint and count the prizes; players can do it from the Draw page of the app.`),
        el("div", { class: "actions" }, el("a", { class: "btn ghost", href: `/v1/cycles/${id}/tickets`, target: "_blank", rel: "noopener" }, "Open the published card list")));
    } else {
      const checks = (await get(`/v1/admin/cycles/${id}/archive`)).checks;
      const ready = checks.every((x) => x.ok);
      box.append(el("p", { class: "sub" }, "When every prize is resolved and the money is reconciled, the cycle is closed out: every card's outcome is published so anyone can check the whole cycle, and merchandise from prizes that lapsed unclaimed goes back into stock. A cycle manager or Compliance requests it; someone in Finance confirms."),
        ...checks.map((x) => el("div", { class: "check" + (x.ok ? " yes" : "") }, el("i", {}, x.ok ? "✓" : "·"), el("div", {}, x.label, el("small", {}, x.detail)))));
      if (c.status === "DRAWN" && can("CYCLE_MANAGER", "COMPLIANCE")) {
        box.append(el("div", { class: "actions" }, el("button", { class: "btn", disabled: !ready, onclick: action(async () => {
          const r = await post(`/v1/admin/cycles/${id}/archive/request`);
          return "Close-out requested." + (r.expiredClaims ? ` ${r.expiredClaims} unclaimed prize${r.expiredClaims === 1 ? "" : "s"} closed as expired.` : "") + " Finance must confirm.";
        }) }, "Request close-out")));
      }
      if (c.status === "SETTLING") {
        box.prepend(el("div", { class: "note" }, `Close-out requested by ${c.archive_requested_by_name} on ${when(c.archive_requested_at)}.`));
        if (can("FINANCE") && c.archive_requested_by !== me.id) {
          box.append(el("div", { class: "actions" }, el("button", { class: "btn", disabled: !ready, onclick: action(async () => {
            if (!confirm("Archive this cycle and publish every card? This is permanent.")) return;
            const r = await post(`/v1/admin/cycles/${id}/archive/confirm`);
            return `Archived. ${num(r.published)} cards published` + (r.stockReleased ? `; ${r.stockReleased} merchandise unit${r.stockReleased === 1 ? "" : "s"} back in stock.` : ".");
          }) }, "Confirm and archive")));
        } else box.append(el("p", { class: "sub" }, c.archive_requested_by === me.id ? "Waiting for someone in Finance to confirm." : "Waiting for Finance to confirm."));
      }
    }
    nodes.push(el("h2", {}, "Close-out"), box);
  }
  return nodes;
}

async function approvals() {
  const [list, pending] = await Promise.all([get("/v1/admin/cycles"), can("FINANCE", "PAYOUT_APPROVER", "COMPLIANCE", "AUDITOR") ? get("/v1/admin/payouts/pending") : { payouts: [] }]);
  const waiting = list.cycles.filter((c) => c.status === "SUBMITTED");
  const voids = list.cycles.filter((c) => c.void_pending);
  const refundReqs = can("FINANCE", "COMPLIANCE", "AUDITOR") ? (await get("/v1/admin/refunds?status=AWAITING_APPROVAL")).refunds : [];
  return [el("h1", {}, "Approvals"), el("p", { class: "sub" }, "Every sensitive action needs a second person. You cannot approve something you raised."),
    el("h2", {}, "Cycles awaiting approval"),
    el("div", { class: "card" }, waiting.length ? table(["Cycle", "#Tickets", "#Price", "Approvals so far", ""], waiting.map((c) =>
      el("tr", {}, td(el("b", {}, c.name)), td(num(c.total_tickets), true), td(naira(c.ticket_price_kobo), true), td(`${c.approvals} of 2`), td(el("a", { class: "btn ghost", href: "#/cycle/" + c.id }, "Review")))))
      : el("p", { class: "sub" }, "Nothing waiting.")),
    el("h2", {}, "Payouts awaiting approval"),
    el("div", { class: "card" }, payoutsTable(pending.payouts)),
    el("h2", {}, "Refunds awaiting approval"),
    el("div", { class: "card" }, refundsTable(refundReqs)),
    el("h2", {}, "Cycle cancellations awaiting approval"),
    el("div", { class: "card" }, voids.length ? table(["Cycle", "Status", ""], voids.map((c) => el("tr", {}, td(el("b", {}, c.name)), td(pill(c.status, STATUS_TONE[c.status])), td(el("a", { class: "btn ghost", href: "#/cycle/" + c.id }, "Review")))))
      : el("p", { class: "sub" }, "Nothing waiting."))];
}

const REFUND_REASON = { INELIGIBLE_PURCHASE: "Not eligible to buy", DISPUTED_PAYMENT: "Disputed payment", CYCLE_VOID: "Cycle cancelled", NO_TICKET_ISSUED: "Paid, no card issued", DUPLICATE_CHARGE: "Charged twice" };
const REFUND_TONE = { AWAITING_APPROVAL: "gold", CONFIRMED: "", REJECTED: "grey" };

function refundsTable(rows) {
  if (!rows.length) return el("p", { class: "sub" }, "Nothing waiting.");
  const decide = (r, approve) => action(async () => {
    const body = { approve };
    if (approve && !confirm(`Refund ${naira(r.amount_kobo)} and cancel ${r.quantity} card(s)? Any prizes they won are forfeited.`)) return;
    if (!approve) { const reason = prompt("Reason for rejecting the refund:"); if (!reason) return; body.reason = reason; }
    await post(`/v1/admin/refunds/${r.id}/decision`, body);
    return approve ? "Refunded to the original payment. Cards cancelled." : "Refund rejected. The purchase stands.";
  });
  return table(["Player", "Cycle", "#Amount", "Reason", "Requested", "Status", ""], rows.map((r) =>
    el("tr", {}, td(`${r.player_name ?? "—"} (${r.player_phone})`), td(`${r.cycle} · ${r.quantity} card${r.quantity === 1 ? "" : "s"}`), td(naira(r.amount_kobo), true),
      td([REFUND_REASON[r.reason] ?? r.reason, r.note ? el("div", { class: "sub" }, r.note) : null]),
      td(r.requested_by_name ? `${r.requested_by_name} · ${when(r.created_at)}` : "Automatic · " + when(r.created_at)),
      td([pill(r.status === "AWAITING_APPROVAL" ? "Awaiting approval" : r.status.toLowerCase(), REFUND_TONE[r.status]), r.decision_reason ? el("div", { class: "sub" }, r.decision_reason) : null]),
      td(r.status === "AWAITING_APPROVAL" && can("FINANCE") && r.requested_by !== me.id
        ? el("div", { class: "actions" }, el("button", { class: "btn", onclick: decide(r, true) }, "Approve"), el("button", { class: "btn danger", onclick: decide(r, false) }, "Reject"))
        : r.status === "AWAITING_APPROVAL" ? pill("Needs Finance", "gold") : ""))));
}

let lastSearch = "";
async function refunds() {
  if (!can("COMPLIANCE", "FINANCE", "AUDITOR", "SUPPORT")) return [el("h1", {}, "Refunds"), el("p", { class: "sub" }, "Your role does not include refunds.")];
  const nodes = [el("h1", {}, "Refunds"),
    el("p", { class: "sub" }, "Compliance requests a refund; Finance approves it. Money only ever goes back to the payment it came from. The purchase's cards are cancelled and any prizes they won are forfeited.")];
  const results = el("div");
  const search = el("form", { class: "card", onsubmit: action(async () => {
    lastSearch = v(search, "phone");
    const r = await get("/v1/admin/orders?phone=" + encodeURIComponent(lastSearch));
    results.replaceChildren(ordersTable(r.orders));
  }, false) }, el("b", {}, "Find a purchase"),
    el("div", { class: "form" }, input("Player's phone number", { name: "phone", inputmode: "tel", required: true, value: lastSearch }), el("button", { class: "btn ghost", type: "submit" }, "Search")), results);
  nodes.push(search);
  if (can("COMPLIANCE", "FINANCE", "AUDITOR")) {
    const all = (await get("/v1/admin/refunds")).refunds;
    nodes.push(el("h2", {}, "Awaiting approval"), el("div", { class: "card" }, refundsTable(all.filter((r) => r.status === "AWAITING_APPROVAL"))),
      el("h2", {}, "History"), el("div", { class: "card" }, refundsTable(all.filter((r) => r.status !== "AWAITING_APPROVAL"))));
  }
  if (lastSearch) get("/v1/admin/orders?phone=" + encodeURIComponent(lastSearch)).then((r) => results.replaceChildren(ordersTable(r.orders))).catch(() => {});
  return nodes;
}

function ordersTable(orders) {
  if (!orders.length) return el("p", { class: "sub" }, "No purchases found for that number.");
  return table(["When", "Player", "Cycle", "#Cards", "#Amount", "Status", ""], orders.map((o) => {
    let actionCell = "";
    if (o.status === "FULFILLED" && !o.refund_status && can("COMPLIANCE")) {
      const form = el("form", { onsubmit: action(async () => {
        await post(`/v1/admin/orders/${o.id}/refund`, { reason: v(form, "reason"), note: v(form, "note") });
        return "Refund requested. Finance must approve it before any money moves.";
      }) }, el("div", { class: "form" },
        select("Reason", "reason", [["INELIGIBLE_PURCHASE", "Not eligible to buy"], ["DISPUTED_PAYMENT", "Disputed payment"]]),
        input("Note (required)", { name: "note", required: true, maxlength: 1000 }),
        el("button", { class: "btn danger", type: "submit" }, "Request refund")));
      actionCell = form;
    }
    return el("tr", {}, td(when(o.created_at)), td(`${o.player_name ?? "—"} (${o.player_phone})`), td(o.cycle), td(num(o.quantity), true), td(naira(o.amount_kobo), true),
      td([pill(o.status.toLowerCase(), o.status === "FULFILLED" ? "" : "grey"), o.refund_status ? el("div", { class: "sub" }, `refund: ${o.refund_status.toLowerCase().replace("_", " ")}`) : null]), td(actionCell));
  }));
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

const CLAIM_TONE = { ENTITLED: "gold", ON_HOLD: "red", VERIFIED: "gold", DISPATCHED: "gold", DELIVERED: "", EXPIRED: "grey", VOID: "grey" };
const CLAIM_TEXT = { ENTITLED: "Waiting for winner", ON_HOLD: "On hold", VERIFIED: "Claimed — to dispatch", DISPATCHED: "Out for handover", DELIVERED: "Handed over", EXPIRED: "Expired unclaimed", VOID: "Void" };

async function merchandise() {
  const [inv, queue] = await Promise.all([get("/v1/admin/inventory"), get("/v1/admin/fulfilment")]);
  const f = can("FULFILMENT");
  const sum = (key) => inv.items.reduce((n, i) => n + i[key], 0);
  const nodes = [el("h1", {}, "Merchandise"), el("p", { class: "sub" }, "Every prize item, what it cost, where it is, and who it went to."),
    el("div", { class: "tiles" },
      el("div", { class: "tile" }, el("span", {}, "Free in warehouse"), el("b", {}, num(sum("in_stock")))),
      el("div", { class: "tile" }, el("span", {}, "Reserved as prizes"), el("b", {}, num(sum("reserved")))),
      el("div", { class: "tile " + (queue.claims.some((x) => x.status === "VERIFIED") ? "warn" : "") }, el("span", {}, "Claimed — to dispatch"), el("b", {}, num(queue.claims.filter((x) => x.status === "VERIFIED").length))),
      el("div", { class: "tile" }, el("span", {}, "Out for handover"), el("b", {}, num(queue.claims.filter((x) => x.status === "DISPATCHED").length))),
      el("div", { class: "tile" }, el("span", {}, "Handed over"), el("b", {}, num(sum("delivered")))),
      el("div", { class: "tile" }, el("span", {}, "Stock held (landed cost)"), el("b", {}, naira(sum("stock_value_kobo")))))];

  // Redemptions
  nodes.push(el("h2", {}, "Prize redemptions"));
  if (!queue.claims.length) nodes.push(el("div", { class: "card" }, el("p", { class: "sub" }, "No merchandise prizes have been won yet.")));
  for (const q of queue.claims) {
    const card = el("div", { class: "card" },
      el("div", { class: "actions" }, el("b", {}, q.title), pill(CLAIM_TEXT[q.status] ?? q.status, CLAIM_TONE[q.status]), el("span", { class: "sub" }, `${q.cycle} · ticket ${q.ticket}`)),
      el("p", { class: "sub" }, `Winner: ${q.winner_name ?? "—"} (…${q.winner_phone_last4}) · claim by ${when(q.expires_at)}` + (q.serial_number ? ` · serial ${q.serial_number}` : "") +
        (q.method ? ` · ${q.method === "DELIVERY" ? "delivery to " + q.address : "collection"}` : "") + (q.carrier ? ` · ${q.carrier} ${q.tracking_ref ?? ""}` : "") + (q.handed_over_at ? ` · handed over ${when(q.handed_over_at)}` : "")));
    if (f && q.status === "VERIFIED") {
      const form = el("form", { onsubmit: action(async () => {
        const body = {}; if (form.elements.carrier && v(form, "carrier")) body.carrier = v(form, "carrier"); if (form.elements.tracking && v(form, "tracking")) body.trackingRef = v(form, "tracking");
        await post(`/v1/admin/fulfilment/${q.id}/dispatch`, body);
        return "Marked as sent. The winner now has a one-time handover code in their app.";
      }) }, el("div", { class: "form" },
        q.centre_name ? el("p", { class: "sub" }, `Goes to ${q.centre_name}: the unit is moved there (recorded) and the winner gets a collection voucher.`)
          : input(q.method === "DELIVERY" ? "Carrier" : "Collection point (optional)", { name: "carrier" }),
        q.centre_name ? null : input("Tracking reference (optional)", { name: "tracking" }),
        el("button", { class: "btn", type: "submit" }, q.method === "DELIVERY" ? "Dispatch" : "Send to the centre")));
      card.append(form);
    }
    if (f && q.status === "DISPATCHED") {
      const form = el("form", { onsubmit: action(async () => {
        const photoBase64 = await fileBase64(form);
        if (!photoBase64) throw new Error("Take a photo of the handover.");
        const body = { code: v(form, "code"), photoBase64, ...(v(form, "idChecked") ? { idChecked: v(form, "idChecked") } : {}) };
        if (v(form, "warranty")) body.warrantyDocumentRef = v(form, "warranty");
        await post(`/v1/admin/fulfilment/${q.id}/handover`, body);
        return "Handover complete and recorded.";
      }) }, el("p", { class: "sub" }, "Ask the winner for the code shown in their app. Staff cannot see it. Five wrong codes lock the handover."),
        el("div", { class: "form" },
          input("Winner's handover code", { name: "code", inputmode: "numeric", maxlength: 6, required: true, autocomplete: "off" }),
          select("Photo ID checked", "idChecked", [...(q.centre_name ? [] : [["", "Not checked (delivery)"]]), ...ID_TYPES]),
          el("label", {}, "Handover photo", el("input", { type: "file", name: "photo", accept: "image/png,image/jpeg,image/webp", capture: "environment", required: true })),
          input("Warranty document (optional)", { name: "warranty" }),
          el("button", { class: "btn", type: "submit" }, "Confirm handover")));
      card.append(form);
    }
    nodes.push(card);
  }

  // Stock
  nodes.push(el("h2", {}, "Items"), el("div", { class: "card" }, inv.items.length ? table(["Item", "#Advertised value", "#Avg landed cost", "#Free", "#Reserved", "#With winners", "#Handed over", "Warranty"], inv.items.map((i) =>
    el("tr", {}, td(el("b", {}, i.name)), td(naira(i.advertised_value_kobo), true), td(i.avg_landed_cost_kobo ? naira(i.avg_landed_cost_kobo) : "—", true), td(num(i.in_stock), true), td(num(i.reserved), true),
      td(num(i.with_winners), true), td(num(i.delivered), true), td(i.warranty_months ? i.warranty_months + " months" : "—")))) : el("p", { class: "sub" }, "No items yet.")));

  if (f) {
    const receive = el("form", { class: "card", onsubmit: action(async () => {
      const serials = v(receive, "serials").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
      const body = { skuId: v(receive, "sku"), supplierId: v(receive, "supplier"), warehouseId: v(receive, "warehouse"), poReference: v(receive, "po"),
        acquisitionCostKobo: toKobo(v(receive, "cost")), landedCostKobo: toKobo(v(receive, "landed")) };
      if (serials.length) body.serialNumbers = serials; else body.quantity = Number(v(receive, "qty"));
      const r = await post("/v1/admin/stock/receive", body);
      return `${r.received} unit${r.received === 1 ? "" : "s"} received into stock.`;
    }) },
      el("b", {}, "Receive stock"), el("p", { class: "sub" }, "Record goods when they physically arrive. Costs and serial numbers cannot be edited afterwards."),
      inv.items.length && inv.suppliers.length && inv.warehouses.length ? [el("div", { class: "form" },
        select("Item", "sku", inv.items.map((i) => [i.id, i.name + (i.serialised ? " (serial numbers)" : "")])),
        select("Supplier", "supplier", inv.suppliers.map((s) => [s.id, s.name])), select("Warehouse", "warehouse", inv.warehouses.map((w) => [w.id, w.name])),
        input("Purchase order reference", { name: "po", required: true }),
        input("Purchase cost per unit (₦)", { name: "cost", type: "number", min: 0, required: true }), input("Landed cost per unit (₦)", { name: "landed", type: "number", min: 0, required: true }),
        input("Quantity (if no serial numbers)", { name: "qty", type: "number", min: 1, value: 1 }),
        input("Serial numbers, one per line", { name: "serials", rows: 3 }, true)),
        el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Receive"))] : el("p", { class: "sub" }, "Add an item, a supplier and a warehouse first."));
    const item = el("form", { class: "card", onsubmit: action(async () => {
      await post("/v1/admin/skus", { name: v(item, "name"), advertisedValueKobo: toKobo(v(item, "value")), serialised: item.elements.serialised.checked, warrantyMonths: Number(v(item, "warranty") || 0) });
      return "Item added.";
    }) }, el("b", {}, "New item"), el("div", { class: "form" },
      input("Name", { name: "name", required: true }), input("Advertised value (₦)", { name: "value", type: "number", min: 1, required: true }), input("Warranty (months)", { name: "warranty", type: "number", min: 0, value: 0 }),
      el("label", {}, "Tracked by serial number", el("input", { type: "checkbox", name: "serialised" })), el("button", { class: "btn ghost", type: "submit" }, "Add item")));
    const supplier = el("form", { class: "card", onsubmit: action(async () => { const b = { name: v(supplier, "name") }; if (v(supplier, "country")) b.country = v(supplier, "country"); await post("/v1/admin/suppliers", b); return "Supplier added."; }) },
      el("b", {}, "New supplier"), el("div", { class: "form" }, input("Name", { name: "name", required: true }), input("Country", { name: "country" }), el("button", { class: "btn ghost", type: "submit" }, "Add supplier")));
    const wh = el("form", { class: "card", onsubmit: action(async () => { await post("/v1/admin/warehouses", { name: v(wh, "name"), address: v(wh, "address"), stateCode: "NG-NI" }); return "Warehouse added."; }) },
      el("b", {}, "New warehouse"), el("div", { class: "form" }, input("Name", { name: "name", required: true }), input("Address", { name: "address", required: true }), el("button", { class: "btn ghost", type: "submit" }, "Add warehouse")));
    nodes.push(receive, el("div", { class: "grid2" }, item, el("div", {}, supplier, wh)));
  }

  nodes.push(el("h2", {}, "Stock units"), el("div", { class: "card" }, inv.units.length ? table(["Item", "Serial no.", "Status", "Warehouse", "Supplier / PO", "#Purchase cost", "#Landed cost", "Cycle"], inv.units.map((u) =>
    el("tr", {}, td(u.item), td(el("span", { class: "mono" }, u.serial_number ?? "—")), td(pill(u.status.replace("_", " ").toLowerCase(), u.status === "IN_STOCK" ? "" : u.status === "DELIVERED" ? "grey" : "gold")), td(u.warehouse ?? "—"),
      td(`${u.supplier ?? "—"} · ${u.po_reference ?? ""}`), td(naira(u.acquisition_cost_kobo), true), td(naira(u.landed_cost_kobo), true), td(u.cycle ?? "—")))) : el("p", { class: "sub" }, "No stock recorded yet.")));
  return nodes;
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
  if (can("SUPPORT", "COMPLIANCE", "AUDITOR")) {
    const m = await get("/v1/admin/messages");
    const tone = { SENT: "", QUEUED: "gold", FAILED: "red" };
    nodes.push(el("h2", {}, "Text messages"),
      el("p", { class: "sub" }, `${num(m.sent_today)} sent today · ${num(m.queued)} waiting (texts that can wait are sent between 8am and 8pm) · ${num(m.failed)} failed after five tries.`),
      el("div", { class: "card" }, m.messages.length ? table(["Created", "To", "Message", "Status"], m.messages.map((x) =>
        el("tr", {}, td(when(x.created_at)), td(x.phone), td([x.kind.replaceAll("_", " ").toLowerCase(), el("div", { class: "sub" }, x.body)]),
          td([pill(x.status.toLowerCase(), tone[x.status]), x.status === "QUEUED" ? el("div", { class: "sub" }, "after " + when(x.not_before)) : x.sent_at ? el("div", { class: "sub" }, when(x.sent_at)) : null,
            x.last_error ? el("div", { class: "sub" }, `${x.attempts} tries: ${x.last_error}`) : null]))))
        : el("p", { class: "sub" }, "No text messages yet.")));
  }
  return nodes;
}

// --- Router ------------------------------------------------------------------------------------

// --- Pop-up announcements in the player app ------------------------------------------------------

const FLASH_LINKS = [["", "No button"], ["#/buy", "Buy cards"], ["#/home", "Home"], ["#/draw", "Draw"], ["#/invite", "Invite friends"], ["#/wallet", "Wallet"], ["#/cards", "My cards"]];
async function popupsPage() {
  const list = (await get("/v1/admin/flash")).messages;
  const now = Date.now();
  const nodes = [el("h1", {}, "Pop-ups"),
    el("p", { class: "sub" }, "Announcements shown once to each player when they open the app. Anything players are told about prizes, odds or dates must be accurate, so a Compliance officer who did not write it must approve it before it appears. Approved text cannot be edited, only withdrawn. The app also shows real sales milestones (25%, 50%, 75%, 90% sold) by itself.")];
  if (can("CYCLE_MANAGER", "COMPLIANCE")) {
    const form = el("form", { class: "card", onsubmit: action(async () => {
      await post("/v1/admin/flash", { titleEn: v(form, "titleEn"), bodyEn: v(form, "bodyEn"), ...(v(form, "titleHa") ? { titleHa: v(form, "titleHa") } : {}),
        ...(v(form, "bodyHa") ? { bodyHa: v(form, "bodyHa") } : {}), ...(v(form, "link") ? { link: v(form, "link") } : {}),
        startsAt: new Date(v(form, "starts")).toISOString(), endsAt: new Date(v(form, "ends")).toISOString() });
      return "Pop-up written. A Compliance officer must approve it before players see it.";
    }) },
      el("b", {}, "New pop-up"),
      el("div", { class: "form" },
        input("Title (English)", { name: "titleEn", required: true, maxlength: 80 }),
        input("Title (Hausa, optional)", { name: "titleHa", maxlength: 80 }),
        input("Message (English)", { name: "bodyEn", required: true, maxlength: 400, rows: 3 }, true),
        input("Message (Hausa, optional — English is shown if empty)", { name: "bodyHa", maxlength: 400, rows: 3 }, true),
        select("Button", "link", FLASH_LINKS),
        input("Show from", { name: "starts", type: "datetime-local", value: localInput(new Date(now)), required: true }),
        input("Until", { name: "ends", type: "datetime-local", value: localInput(new Date(now + 3 * 864e5)), required: true })),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Submit for approval")));
    nodes.push(form);
  }
  const statusPill = (f) => f.live ? pill("Live") : f.status === "PENDING" ? pill("Awaiting approval", "gold") : f.status === "APPROVED" ? pill(new Date(f.starts_at) > new Date() ? "Scheduled" : "Ended", "grey") : pill(f.status === "REJECTED" ? "Rejected" : "Withdrawn", "grey");
  nodes.push(el("div", { class: "card" }, list.length ? table(["Pop-up", "Shown", "Written by", "Status", ""], list.map((f) => el("tr", {},
    td([el("b", {}, f.title_en), el("div", { class: "sub" }, f.body_en), f.title_ha ? el("div", { class: "sub" }, `Hausa: ${f.title_ha}`) : null]),
    td(`${when(f.starts_at)} – ${when(f.ends_at)}`),
    td([f.created_by_name, f.decided_by_name ? el("div", { class: "sub" }, `decided by ${f.decided_by_name}`) : null]),
    td(statusPill(f)),
    td(el("div", { class: "actions" },
      f.status === "PENDING" && can("COMPLIANCE") && f.created_by !== me.id ? [
        el("button", { class: "btn small", onclick: action(async () => { await post(`/v1/admin/flash/${f.id}/decision`, { approve: true }); return "Approved."; }) }, "Approve"),
        el("button", { class: "btn small ghost", onclick: action(async () => { await post(`/v1/admin/flash/${f.id}/decision`, { approve: false }); return "Rejected."; }) }, "Reject")] : null,
      ["PENDING", "APPROVED"].includes(f.status) && can("CYCLE_MANAGER", "COMPLIANCE") ? el("button", { class: "btn small ghost danger", onclick: action(async () => {
        if (!confirm("Withdraw this pop-up? Players will stop seeing it at once.")) return;
        await post(`/v1/admin/flash/${f.id}/withdraw`); return "Withdrawn.";
      }) }, "Withdraw") : null))))) : el("p", { class: "sub" }, "No pop-ups yet.")));
  return nodes;
}

/** Reads a picture file and sends it; the server checks it really is a PNG, JPEG or WebP of at most 1 MB. */
function imageUpload(tierId) {
  const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", "aria-label": "Prize picture" });
  file.addEventListener("change", action(async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 1024 * 1024) throw new Error("The picture must be at most 1 MB.");
    const dataBase64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = () => reject(new Error("Could not read the file."));
      r.readAsDataURL(f);
    });
    await put(`/v1/admin/prize-tiers/${tierId}/image`, { dataBase64 });
    return "Picture saved.";
  }));
  return file;
}

const AFF_STATUS = { APPLIED: ["Applied", "gold"], APPROVED: ["Approved", ""], REJECTED: ["Rejected", "grey"], SUSPENDED: ["Suspended", "gold"], TERMINATED: ["Ended", "grey"] };

/** Affiliates (SRS section 13): applications, the fee programme switch, settlements. */
async function affiliatesPage() {
  // Cycle managers write marketing texts but do not see affiliates' personal details.
  if (!can("COMPLIANCE", "FINANCE", "PAYOUT_APPROVER", "AUDITOR")) {
    return can("CYCLE_MANAGER") ? [el("h1", {}, "Affiliates"), ...await materialsSection()]
      : [el("h1", {}, "Affiliates"), el("p", { class: "sub" }, "Your role does not include affiliates.")];
  }
  const d = await get("/v1/admin/affiliates");
  const p = d.programme;
  const nodes = [el("h1", {}, "Affiliates"),
    el("p", { class: "sub" }, "Authorised marketing affiliates. Compliance approves, suspends and ends affiliates. Fees are paid only while the fee programme is switched on, which needs two people and the legal approval's reference. Affiliates earn only on purchases by the players they brought in their territory: no downlines, no recruitment bonuses. Players earn nothing for inviting friends.")];
  const pendingChange = d.programmeChanges.find((c) => c.status === "PENDING");
  nodes.push(el("div", { class: "card" },
    el("b", {}, "Fee programme"),
    el("p", {}, p.remuneration_enabled ? pill(`Fees on: ${p.rate_bp / 100}%`) : pill("Fees off", "grey"), p.legal_reference ? el("span", { class: "sub" }, ` legal approval ${p.legal_reference}`) : null),
    !p.remuneration_enabled ? el("div", { class: "note bad" }, "Affiliate remuneration is disabled until legally approved (SRS go-live checklist). Sales by attributed players are still recorded, with a fee of 0.") : null,
    pendingChange ? el("div", { class: "note" }, `Waiting for a decision: switch fees ${pendingChange.enable ? `on at ${pendingChange.rate_bp / 100}%` : "off"}` +
        `${pendingChange.legal_reference ? ` (legal approval ${pendingChange.legal_reference})` : ""}, requested by ${pendingChange.requested_by_name}: ${pendingChange.reason}`,
      pendingChange.requested_by !== me.id && can("COMPLIANCE", "FINANCE") ? el("div", { class: "actions" },
        el("button", { class: "btn small", onclick: action(async () => { await post(`/v1/admin/affiliate-programme/changes/${pendingChange.id}/decision`, { approve: true }); return "Fee programme changed."; }) }, "Approve"),
        el("button", { class: "btn small ghost", onclick: action(async () => {
          const reason = prompt("Why is this change rejected?"); if (!reason) return;
          await post(`/v1/admin/affiliate-programme/changes/${pendingChange.id}/decision`, { approve: false, reason }); return "Rejected.";
        }) }, "Reject")) : null) : null,
    !pendingChange && can("COMPLIANCE", "FINANCE") ? (() => {
      const form = el("form", { onsubmit: action(async () => {
        const enable = v(form, "enable") === "on";
        await post("/v1/admin/affiliate-programme/changes", { enable, ratePercent: Number(v(form, "rate")), reason: v(form, "reason"),
          ...(v(form, "legal") ? { legalReference: v(form, "legal") } : {}) });
        return "Change requested. Someone else must approve it.";
      }) },
        el("div", { class: "form" },
          select("Fees", "enable", [["on", "Switch on"], ["off", "Switch off"]]),
          input("Rate (%)", { name: "rate", type: "number", min: 0, max: 5, step: 0.1, value: String(p.rate_bp / 100), required: true }),
          input("Legal approval reference (required to switch on)", { name: "legal", maxlength: 200 }),
          input("Reason", { name: "reason", required: true, maxlength: 500 })),
        el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Request change")));
      return form;
    })() : null));
  nodes.push(el("div", { class: "card" }, d.affiliates.length ? table(["Affiliate", "Territory", "Status", "#Sign-ups", "#Sales", "#Unsettled fees", ""], d.affiliates.map((a) => el("tr", {},
    td([el("b", {}, `${a.reference} · ${a.business_name}`), el("div", { class: "sub" }, `${a.full_name} · ${a.contact_email}`),
      el("div", { class: "sub" }, `Promotes: ${a.channels}`), el("div", { class: "sub" }, `Liveness ${a.kyc_tier >= 2 ? "✓" : "✗"} · bank name ${a.bank_name_match ? "matches" : "does not match"} · agreement ${a.agreement_version}`),
      a.attribution_code ? el("div", { class: "sub" }, `Code ${a.attribution_code}`) : null]),
    td(a.territory_state + (a.territory_area ? ` · ${a.territory_area}` : "")),
    td(pill(...(AFF_STATUS[a.status] ?? [a.status]))),
    td(num(a.sign_ups), true), td(naira(a.sales_kobo), true), td(naira(a.unsettled_kobo), true),
    td(el("div", { class: "actions" },
      can("COMPLIANCE") ? affiliateActions(a) : null,
      can("FINANCE") && a.unsettled_kobo > 0 && !a.open_settlement ? el("button", { class: "btn small", onclick: action(async () => {
        const r = await post(`/v1/admin/affiliates/${a.id}/settlements`); return `Settlement of ${naira(r.amountKobo)} prepared. A payout approver must approve it.`;
      }) }, "Prepare settlement") : null,
      a.open_settlement ? el("div", { class: "sub" }, `Settlement ${naira(a.open_settlement.amount_kobo)} waiting`) : null,
      a.open_settlement && can("PAYOUT_APPROVER") && a.open_settlement.prepared_by !== me.id ? [
        el("button", { class: "btn small", onclick: action(async () => { const r = await post(`/v1/admin/affiliate-settlements/${a.open_settlement.id}/decision`, { approve: true }); return `Paid (${r.paymentRef}).`; }) }, "Approve and pay"),
        el("button", { class: "btn small ghost", onclick: action(async () => {
          const reason = prompt("Why is this settlement rejected?"); if (!reason) return;
          await post(`/v1/admin/affiliate-settlements/${a.open_settlement.id}/decision`, { approve: false, reason }); return "Rejected.";
        }) }, "Reject")] : null))))) : el("p", { class: "sub" }, "No applications yet.")));
  if (can("CYCLE_MANAGER", "COMPLIANCE", "AUDITOR")) nodes.push(...await materialsSection());
  if (can("COMPLIANCE", "AUDITOR")) nodes.push(...await complaintsSection(d.affiliates));
  return nodes;
}

const CHANNELS = [["WHATSAPP", "WhatsApp"], ["SMS", "Text message"], ["SOCIAL", "Social media"], ["PRINT", "Print"], ["RADIO", "Radio"]];
const VERSION_PILL = { PENDING: ["Awaiting approval", "gold"], APPROVED: ["In use", ""], REJECTED: ["Rejected", "grey"], RETIRED: ["Retired", "grey"] };

/** Reads an optional picture from a form's file input as base64. */
async function fileBase64(form) {
  const f = form.querySelector("input[type=file]")?.files?.[0];
  if (!f) return undefined;
  if (f.size > 1024 * 1024) throw new Error("The picture must be at most 1 MB.");
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = () => reject(new Error("Could not read the file.")); r.readAsDataURL(f); });
}

/** Approved marketing materials (SRS AFF-005, AFF-011): written by one person, approved by another, never edited — corrected by new versions. */
async function materialsSection() {
  const { materials } = await get("/v1/admin/materials");
  const nodes = [el("h2", {}, "Approved marketing materials"),
    el("p", { class: "sub" }, "The only texts and pictures affiliates may use. A Compliance officer who did not write a version approves it; approved versions are never edited — write a new version, and approving it replaces the old one. {link} in a text becomes the affiliate's own link. Every text must say \"18+\".")];
  if (can("CYCLE_MANAGER", "COMPLIANCE")) {
    const form = el("form", { class: "card", onsubmit: action(async () => {
      const imageBase64 = await fileBase64(form);
      await post("/v1/admin/materials", { name: v(form, "name"), channel: v(form, "channel"), bodyEn: v(form, "bodyEn"),
        ...(v(form, "bodyHa") ? { bodyHa: v(form, "bodyHa") } : {}), ...(imageBase64 ? { imageBase64 } : {}) });
      return "Written. Another Compliance officer must approve it before affiliates see it.";
    }) },
      el("b", {}, "New marketing text"),
      el("div", { class: "form" },
        input("Name", { name: "name", required: true, maxlength: 80 }),
        select("Channel", "channel", CHANNELS),
        input("Text (English)", { name: "bodyEn", required: true, maxlength: 1000, rows: 3, placeholder: "Scratch, win, and every card goes into the final draw! {link} 18+ only. Play responsibly." }, true),
        input("Text (Hausa, optional)", { name: "bodyHa", maxlength: 1000, rows: 3 }, true),
        el("label", {}, "Picture (optional)", el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" }))),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Submit for approval")));
    nodes.push(form);
  }
  nodes.push(el("div", { class: "card" }, materials.length ? table(["Text", "Version", "Status", ""], materials.flatMap((m) => m.versions.map((x, i) => el("tr", {},
    td([i === 0 ? el("b", {}, `${m.name} · ${CHANNELS.find(([c]) => c === m.channel)?.[1] ?? m.channel}`) : null,
      el("div", { class: "sub" }, x.body_en), x.body_ha ? el("div", { class: "sub" }, `Hausa: ${x.body_ha}`) : null,
      x.has_image ? el("img", { class: "thumb", src: `/v1/material-images/${x.version_id}`, alt: "" }) : null,
      el("div", { class: "mono" }, `written by ${x.written_by_name}${x.decided_by_name ? `, decided by ${x.decided_by_name}` : ""} · ${x.sha256.slice(0, 12)}`)]),
    td(`v${x.version}`),
    td(pill(...(VERSION_PILL[x.status] ?? [x.status]))),
    td(el("div", { class: "actions" },
      x.status === "PENDING" && can("COMPLIANCE") && x.written_by !== me.id ? [
        el("button", { class: "btn small", onclick: action(async () => { await post(`/v1/admin/material-versions/${x.version_id}/decision`, { approve: true }); return "Approved: affiliates can use it now."; }) }, "Approve"),
        el("button", { class: "btn small ghost", onclick: action(async () => { await post(`/v1/admin/material-versions/${x.version_id}/decision`, { approve: false }); return "Rejected."; }) }, "Reject")] : null,
      x.status === "APPROVED" && can("COMPLIANCE") ? el("button", { class: "btn small ghost danger", onclick: action(async () => {
        if (!confirm("Withdraw this text? Affiliates will stop seeing it at once.")) return;
        await post(`/v1/admin/materials/${m.id}/retire`); return "Withdrawn.";
      }) }, "Withdraw") : null,
      i === 0 && can("CYCLE_MANAGER", "COMPLIANCE") && !m.versions.some((y) => y.status === "PENDING") ? el("button", { class: "btn small ghost", onclick: action(async () => {
        const bodyEn = prompt("New version of the English text (it must say 18+):", x.body_en); if (!bodyEn) return;
        await post(`/v1/admin/materials/${m.id}/versions`, { bodyEn, ...(x.body_ha ? { bodyHa: x.body_ha } : {}) });
        return "New version written. It needs approval.";
      }) }, "New version") : null)))))) : el("p", { class: "sub" }, "No marketing texts yet.")));
  return nodes;
}

const COMPLAINT_TOPICS = { MISLEADING: "Misleading claims", UNDERAGE: "Promoting to children", PRESSURE: "Pressure to play", UNAPPROVED_MATERIAL: "Unofficial adverts",
  PAID_SIGNUPS: "Paying people to sign up", IMPERSONATION: "Pretending to be WiiFarm", OTHER: "Other" };
const COMPLAINT_PILL = { OPEN: ["Open", "gold"], INVESTIGATING: ["Investigating", "gold"], UPHELD: ["Upheld", "red"], DISMISSED: ["Dismissed", "grey"] };

/** Complaints and investigations (SRS AFF-009). */
async function complaintsSection(affiliates) {
  const { complaints } = await get("/v1/admin/affiliate-complaints");
  const nodes = [el("h2", {}, "Complaints and investigations"),
    el("p", { class: "sub" }, "Reports from players (Help page) and staff. A Compliance officer who did not report it investigates and records the findings; suspending or ending the affiliate happens with the conclusion. Concluded complaints cannot be changed.")];
  if (can("COMPLIANCE") && affiliates.length) {
    const form = el("form", { class: "card", onsubmit: action(async () => {
      const r = await post("/v1/admin/affiliate-complaints", { affiliateId: v(form, "affiliate"), category: v(form, "category"), description: v(form, "description") });
      return `Complaint ${r.reference} opened. Another Compliance officer must investigate it.`;
    }) },
      el("b", {}, "Record a complaint"),
      el("div", { class: "form" },
        select("Affiliate", "affiliate", affiliates.map((a) => [a.id, `${a.reference} · ${a.business_name}`])),
        select("What happened", "category", Object.entries(COMPLAINT_TOPICS)),
        input("Details", { name: "description", required: true, minlength: 5, maxlength: 2000, rows: 3 }, true)),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Record complaint")));
    nodes.push(form);
  }
  nodes.push(el("div", { class: "card" }, complaints.length ? table(["Complaint", "Affiliate", "Status", ""], complaints.map((c) => el("tr", {},
    td([el("b", {}, `${c.reference} · ${COMPLAINT_TOPICS[c.category] ?? c.category}`), el("div", { class: "sub" }, c.description),
      el("div", { class: "mono" }, `${c.source === "PLAYER" ? "from a player" : "from staff"} · ${when(c.created_at)}${c.reported_code ? ` · code given ${c.reported_code}` : ""}`),
      c.findings ? el("div", { class: "sub" }, `Findings: ${c.findings} (${c.outcome.replace("_", " ").toLowerCase()})`) : null]),
    td(c.affiliate_reference ? [c.affiliate_reference, el("div", { class: "sub" }, c.business_name)] : el("span", { class: "sub" }, "Not known")),
    td([pill(...(COMPLAINT_PILL[c.status] ?? [c.status])), c.investigator_name ? el("div", { class: "sub" }, c.investigator_name) : null]),
    td(el("div", { class: "actions" },
      c.status === "OPEN" && can("COMPLIANCE") && c.reporter_admin_id !== me.id ? el("button", { class: "btn small", onclick: action(async () => {
        let affiliateId;
        if (!c.affiliate_id) {
          const ref = prompt("Which affiliate is it about? Enter the reference (AFF-…), or leave empty if unknown.");
          affiliateId = ref ? affiliates.find((a) => a.reference === ref.trim().toUpperCase())?.id : undefined;
          if (ref && !affiliateId) throw new Error("No affiliate with that reference.");
        }
        await post(`/v1/admin/affiliate-complaints/${c.id}/investigate`, affiliateId ? { affiliateId } : {});
        return "You are investigating this complaint.";
      }) }, "Investigate") : null,
      c.status === "INVESTIGATING" && c.investigator_id === me.id ? concludeForm(c) : null))))) : el("p", { class: "sub" }, "No complaints.")));
  return nodes;
}

function concludeForm(c) {
  const form = el("form", { onsubmit: action(async () => {
    const outcome = v(form, "outcome");
    if ((outcome === "SUSPENDED" || outcome === "TERMINATED") && !confirm(`This will ${outcome === "SUSPENDED" ? "suspend" : "end"} the affiliate at once. Continue?`)) return;
    await post(`/v1/admin/affiliate-complaints/${c.id}/conclude`, { upheld: outcome !== "NO_ACTION" || v(form, "upheld") === "yes", findings: v(form, "findings"), outcome });
    return "Complaint concluded.";
  }) },
    input("Findings", { name: "findings", required: true, maxlength: 2000, rows: 2 }, true),
    select("Upheld?", "upheld", [["no", "Not upheld"], ["yes", "Upheld"]]),
    select("Outcome", "outcome", [["NO_ACTION", "No action"], ["WARNING", "Formal warning"], ["SUSPENDED", "Suspend the affiliate"], ["TERMINATED", "End the agreement"]]),
    el("button", { class: "btn small", type: "submit" }, "Conclude"));
  return form;
}

function affiliateActions(a) {
  const act = (decision, label, ask, tone = "ghost") => el("button", { class: `btn small ${tone}`, onclick: action(async () => {
    const reason = ask ? prompt(ask) : undefined;
    if (ask && !reason) return;
    await post(`/v1/admin/affiliates/${a.id}/decision`, { decision, ...(reason ? { reason } : {}) });
    return `Affiliate ${{ APPROVE: "approved", REJECT: "rejected", SUSPEND: "suspended", REINSTATE: "reinstated", TERMINATE: "ended" }[decision]}.`;
  }) }, label);
  if (a.status === "APPLIED") return [act("APPROVE", "Approve", null, ""), act("REJECT", "Reject", "Why is the application rejected?")];
  if (a.status === "APPROVED") return [act("SUSPEND", "Suspend", "Why is this affiliate suspended?"), act("TERMINATE", "End", "Why is this affiliate's agreement ended?", "ghost danger")];
  if (a.status === "SUSPENDED") return [act("REINSTATE", "Reinstate", "Why is this affiliate reinstated?"), act("TERMINATE", "End", "Why is this affiliate's agreement ended?", "ghost danger")];
  return null;
}

const ID_TYPES = [["NIN_SLIP", "NIN slip"], ["VOTERS_CARD", "Voter's card"], ["DRIVERS_LICENCE", "Driver's licence"], ["PASSPORT", "Passport"], ["OTHER", "Other photo ID"]];
const TIER_TEXT = { MEGA: "Mega Stockist", SUB: "Sub Stockist", SPECIALIST: "Specialist partner" };
const CENTRE_PILL = { PENDING: ["Awaiting approval", "gold"], ACTIVE: ["Approved", ""], SUSPENDED: ["Suspended", "red"], REJECTED: ["Rejected", "grey"] };
const INCIDENT_KINDS = [["DAMAGED", "Damaged"], ["MISSING", "Missing"], ["WRONG_ITEM", "Wrong item"], ["OTHER", "Other problem"]];

/** The stockist portal (SRS section 14): what a collection centre's staff see. */
async function portalPage() {
  const d = await get("/v1/admin/stockist-portal");
  const c = d.centre, st = d.stats;
  const nodes = [el("h1", {}, c.name), el("p", { class: "sub" }, `${TIER_TEXT[c.tier] ?? c.tier} · ${c.code} · ${c.area} · approved fee ${naira(c.fee_kobo)} per prize handed over`)];
  if (c.status !== "ACTIVE") nodes.push(el("div", { class: "note bad" }, "This centre is suspended: do not hand over prizes until WiiFarm says so."));
  nodes.push(el("div", { class: "tiles" },
    el("div", { class: "tile" }, el("span", {}, "Assigned units"), el("b", {}, num(st.assigned))),
    el("div", { class: "tile" }, el("span", {}, "Fulfilled / outstanding"), el("b", {}, `${num(st.fulfilled)} / ${num(st.outstanding)}`)),
    el("div", { class: "tile " + (st.fulfilmentRate === null || st.fulfilmentRate >= 80 ? "ok" : "warn") }, el("span", {}, "Fulfilment rate"), el("b", {}, st.fulfilmentRate === null ? "—" : `${st.fulfilmentRate}%`)),
    el("div", { class: "tile" }, el("span", {}, "On the shelf"), el("b", {}, num(st.held))),
    el("div", { class: "tile " + (st.incidents ? "bad" : "ok") }, el("span", {}, "Open problem reports"), el("b", {}, num(st.incidents)))));

  // Verify a voucher, then hand over.
  const result = el("div");
  const verify = el("form", { class: "card", onsubmit: action(async () => {
    const r = await post("/v1/admin/stockist-portal/verify", { voucherRef: v(verify, "voucher") });
    result.replaceChildren(handoverForm(r));
  }, false) },
    el("b", {}, "Verify a voucher"),
    el("p", { class: "sub" }, "Enter the voucher reference the winner shows you (WV-…). A voucher can be redeemed only once, and only at the centre it was issued for."),
    el("div", { class: "form" }, input("Voucher reference", { name: "voucher", required: true, maxlength: 20, autocomplete: "off", placeholder: "WV-XXXX-XXXX" }),
      el("button", { class: "btn", type: "submit" }, "Verify")), result);
  nodes.push(el("h2", {}, "Hand over a prize"), verify);

  nodes.push(el("h2", {}, "Waiting for collection"), el("div", { class: "card" }, d.pending.length
    ? table(["Voucher", "Prize", "Sent", "Claim by"], d.pending.map((x) => el("tr", {}, td(el("span", { class: "mono" }, x.voucher_ref)), td(x.title), td(when(x.dispatched_at)), td(when(x.expires_at)))))
    : el("p", { class: "sub" }, "Nothing waiting.")));

  nodes.push(el("h2", {}, "Stock at this centre"), el("div", { class: "card" }, d.units.length
    ? table(["Item", "Serial", "Status", ""], d.units.map((u) => el("tr", {}, td(u.item), td(el("span", { class: "mono" }, u.serial_number ?? "—")),
      td(u.incident ? pill(`Reported: ${u.incident.toLowerCase().replace("_", " ")}`, "red") : pill(u.status === "DISPATCHED" ? "Awaiting winner" : "On the shelf", "grey")),
      td(u.incident ? null : el("button", { class: "btn small ghost danger", onclick: action(async () => {
        const kind = prompt("What is wrong? Type: damaged, missing, wrong item or other", "damaged"); if (!kind) return;
        const k = { damaged: "DAMAGED", missing: "MISSING", "wrong item": "WRONG_ITEM" }[kind.trim().toLowerCase()] ?? "OTHER";
        const description = prompt("Describe the problem"); if (!description) return;
        await post("/v1/admin/stockist-portal/incidents", { unitId: u.id, kind: k, description });
        return "Reported. Do not hand this unit over until WiiFarm resolves it.";
      }) }, "Report a problem")))))
    : el("p", { class: "sub" }, "No units here.")));

  const f = d.fees;
  nodes.push(el("h2", {}, "Fees and invoices"), el("div", { class: "card" },
    el("div", { class: "tiles" },
      el("div", { class: "tile" }, el("span", {}, "Not yet invoiced"), el("b", {}, naira(f.unbilledKobo))),
      el("div", { class: "tile" }, el("span", {}, "Invoiced, awaiting payment"), el("b", {}, naira(f.invoicedKobo))),
      el("div", { class: "tile" }, el("span", {}, "Paid"), el("b", {}, naira(f.paidKobo)))),
    f.unbilledKobo > 0 ? (() => {
      const form = el("form", { onsubmit: action(async () => {
        const r = await post("/v1/admin/stockist-portal/invoices", v(form, "theirs") ? { theirReference: v(form, "theirs") } : {});
        return `Invoice ${r.reference} for ${naira(r.amountKobo)} sent to WiiFarm Finance.`;
      }) }, el("div", { class: "form" }, input("Your invoice number (optional)", { name: "theirs", maxlength: 60 }), el("button", { class: "btn", type: "submit" }, "Invoice the fees")));
      return form;
    })() : null,
    d.invoices.length ? table(["Invoice", "#Amount", "Status", "Decided"], d.invoices.map((i) => el("tr", {},
      td([el("b", {}, i.reference), i.their_reference ? el("div", { class: "sub" }, i.their_reference) : null]), td(naira(i.amount_kobo), true),
      td([pill(i.status === "PAID" ? "Paid" : i.status === "SUBMITTED" ? "Awaiting Finance" : "Rejected", i.status === "PAID" ? "" : i.status === "SUBMITTED" ? "gold" : "grey"),
        i.payment_ref ? el("div", { class: "mono" }, i.payment_ref) : null, i.reason ? el("div", { class: "sub" }, i.reason) : null]),
      td(when(i.decided_at))))) : null));
  return nodes;
}

/** After a voucher checks out: the identity check, the photo and the winner's code. */
function handoverForm(r) {
  const form = el("form", { class: "card", onsubmit: action(async () => {
    const photoBase64 = await fileBase64(form);
    if (!photoBase64) throw new Error("Take a photo of the handover.");
    await post(`/v1/admin/stockist-portal/handover/${r.claimId}`, { code: v(form, "code"), idChecked: v(form, "idChecked"), photoBase64 });
    return "Handed over and recorded. Thank you.";
  }) },
    el("div", { class: "note" }, el("b", {}, `${r.prize}${r.serialNumber ? ` · serial ${r.serialNumber}` : ""}`), el("br"), `Winner: ${r.winnerName} · phone ending ${r.winnerPhoneLast4}`),
    r.incidentOpen ? el("div", { class: "note bad" }, "This unit has an open problem report: do not hand it over.") : null,
    el("p", { class: "sub" }, r.instructions),
    el("div", { class: "form" },
      select("Photo ID checked (must match the name above)", "idChecked", ID_TYPES),
      el("label", {}, "Photo of the handover", el("input", { type: "file", name: "photo", accept: "image/png,image/jpeg,image/webp", capture: "environment", required: true })),
      input("Code read out by the winner", { name: "code", inputmode: "numeric", maxlength: 6, required: true, autocomplete: "off" }),
      el("button", { class: "btn", type: "submit", disabled: r.incidentOpen }, "Confirm handover")));
  return form;
}

/** Collection centres for head-office staff: approvals, fees, stock moves, problem reports, invoices and reports. */
async function centresPage() {
  const [{ stockists: list }, rec, out] = await Promise.all([get("/v1/admin/stockists"), get("/v1/admin/reports/stockist-reconciliation"), get("/v1/admin/reports/outstanding-prizes")]);
  const nodes = [el("h1", {}, "Collection centres"),
    el("p", { class: "sub" }, "Mega Stockists coordinate regional stock, Sub Stockists handle local collection, specialist partners deliver vehicles and appliances. Fulfilment registers a centre and Compliance approves it; fee changes need Finance. Centre staff use the stockist portal: they verify the winner's voucher, check their photo ID, take a photo and enter the winner's code.")];
  const mega = list.filter((x) => x.tier === "MEGA" && x.status === "ACTIVE");
  if (can("FULFILMENT")) {
    const form = el("form", { class: "card", onsubmit: action(async () => {
      const tier = v(form, "tier");
      await post("/v1/admin/stockists", { name: v(form, "name"), tier, ...(tier === "SUB" ? { parentId: v(form, "parent") } : {}), stateCode: v(form, "state"), area: v(form, "area"),
        address: v(form, "address"), phone: v(form, "phone"), coverage: v(form, "coverage").split(",").map((x) => x.trim()).filter(Boolean),
        ...(v(form, "hours") ? { openingHours: v(form, "hours") } : {}), feeKobo: Math.round(Number(v(form, "fee")) * 100) });
      return "Registered. Compliance must approve the centre before winners can choose it.";
    }) },
      el("b", {}, "Register a centre"),
      el("div", { class: "form" },
        input("Name", { name: "name", required: true, maxlength: 120 }),
        select("Type", "tier", [["MEGA", "Mega Stockist (regional)"], ["SUB", "Sub Stockist (local)"], ["SPECIALIST", "Specialist partner"]]),
        select("Mega Stockist (for a Sub Stockist)", "parent", mega.length ? mega.map((m) => [m.id, m.name]) : [["", "None approved yet"]]),
        select("State", "state", [["NG-NI", "Niger State"]]),
        input("Town / area", { name: "area", required: true, maxlength: 120 }),
        input("Address", { name: "address", required: true, maxlength: 300 }),
        input("Phone", { name: "phone", required: true, maxlength: 20 }),
        input("Local government areas served (comma-separated)", { name: "coverage", required: true }),
        input("Opening hours (optional)", { name: "hours", maxlength: 120 }),
        input("Fee per prize handed over (₦)", { name: "fee", type: "number", min: 0, step: 1, value: "1000", required: true })),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "submit" }, "Register")));
    nodes.push(form);
  }
  nodes.push(el("div", { class: "card" }, list.length ? table(["Centre", "Coverage", "#Fee", "#Units held", "Status", ""], list.map((x) => el("tr", {},
    td([el("b", {}, `${x.code} · ${x.name}`), el("div", { class: "sub" }, `${TIER_TEXT[x.tier]}${x.parent_name ? ` under ${x.parent_name}` : ""} · ${x.area} · ${x.address} · ${x.phone}`),
      el("div", { class: "mono" }, `registered by ${x.registered_by_name}${x.approved_by_name ? `, approved by ${x.approved_by_name}` : ""}`)]),
    td(x.coverage.join(", ")),
    td([naira(x.fee_kobo), x.pending_fee_kobo !== null ? el("div", { class: "sub" }, `change to ${naira(x.pending_fee_kobo)} waiting`) : null], true),
    td(num(x.units_held), true),
    td(pill(...(CENTRE_PILL[x.status] ?? [x.status]))),
    td(el("div", { class: "actions" },
      can("COMPLIANCE") && x.status === "PENDING" && x.registered_by !== me.id ? [
        el("button", { class: "btn small", onclick: action(async () => { await post(`/v1/admin/stockists/${x.id}/decision`, { decision: "APPROVE" }); return "Centre approved."; }) }, "Approve"),
        el("button", { class: "btn small ghost", onclick: action(async () => { const reason = prompt("Why is it rejected?"); if (!reason) return; await post(`/v1/admin/stockists/${x.id}/decision`, { decision: "REJECT", reason }); return "Rejected."; }) }, "Reject")] : null,
      can("COMPLIANCE") && x.status === "ACTIVE" ? el("button", { class: "btn small ghost danger", onclick: action(async () => { const reason = prompt("Why is the centre suspended?"); if (!reason) return; await post(`/v1/admin/stockists/${x.id}/decision`, { decision: "SUSPEND", reason }); return "Suspended."; }) }, "Suspend") : null,
      can("COMPLIANCE") && x.status === "SUSPENDED" ? el("button", { class: "btn small ghost", onclick: action(async () => { const reason = prompt("Why is it reinstated?"); if (!reason) return; await post(`/v1/admin/stockists/${x.id}/decision`, { decision: "REINSTATE", reason }); return "Reinstated."; }) }, "Reinstate") : null,
      can("FULFILMENT") && x.pending_fee_kobo === null && x.status !== "REJECTED" ? el("button", { class: "btn small ghost", onclick: action(async () => {
        const naira_ = prompt("New fee per prize handed over (₦):"); if (!naira_) return;
        await post(`/v1/admin/stockists/${x.id}/fee`, { feeKobo: Math.round(Number(naira_) * 100) }); return "Fee change requested: Finance must approve it.";
      }) }, "Change fee") : null,
      can("FINANCE") && x.pending_fee_kobo !== null && x.fee_requested_by !== me.id ? [
        el("button", { class: "btn small", onclick: action(async () => { await post(`/v1/admin/stockists/${x.id}/fee/decision`, { approve: true }); return "New fee approved."; }) }, "Approve fee"),
        el("button", { class: "btn small ghost", onclick: action(async () => { await post(`/v1/admin/stockists/${x.id}/fee/decision`, { approve: false }); return "Fee change rejected."; }) }, "Reject fee")] : null))))) : el("p", { class: "sub" }, "No centres yet.")));

  // Sending prize stock to a centre ahead of claims.
  if (can("FULFILMENT")) {
    const { units } = await get("/v1/admin/stock/movable");
    const active = list.filter((x) => x.status === "ACTIVE");
    if (units.length && active.length) {
      const form = el("form", { class: "card", onsubmit: action(async () => {
        const unitIds = [...form.querySelectorAll("input[name=unit]:checked")].map((i) => i.value);
        if (!unitIds.length) throw new Error("Tick the units to move.");
        const to = v(form, "to");
        const r = await post("/v1/admin/stock/allocate", { unitIds, toStockistId: to || null, reason: v(form, "reason") });
        return `${r.moved} unit${r.moved === 1 ? "" : "s"} moved; every move is recorded.`;
      }) },
        el("b", {}, "Move prize stock"),
        el("p", { class: "sub" }, "Units stay reserved to their cycle as prizes; only where they are changes. Units are also moved automatically when a winner's prize is sent to their chosen centre."),
        table(["", "Item", "Serial", "Cycle", "Now at"], units.slice(0, 200).map((u) => el("tr", {},
          td(el("input", { type: "checkbox", name: "unit", value: u.id, "aria-label": `${u.item} ${u.serial_number ?? ""}` })), td(u.item), td(el("span", { class: "mono" }, u.serial_number ?? "—")), td(u.cycle ?? "—"), td(u.stockist_name ?? "Warehouse")))),
        el("div", { class: "form" }, select("Move to", "to", [["", "Warehouse"], ...active.map((x) => [x.id, x.name])]), input("Reason", { name: "reason", required: true, maxlength: 300 }),
          el("button", { class: "btn", type: "submit" }, "Move")));
      nodes.push(el("h2", {}, "Stock at centres"), form);
    }
  }

  // Problem reports (damaged, missing, wrong item).
  const { incidents } = await get("/v1/admin/stock/incidents");
  nodes.push(el("h2", {}, "Damaged or unavailable stock"), el("div", { class: "card" }, incidents.length ? table(["Report", "Centre", "Status", ""], incidents.map((i) => el("tr", {},
    td([el("b", {}, `${INCIDENT_KINDS.find(([k]) => k === i.kind)?.[1] ?? i.kind}: ${i.item}${i.serial_number ? ` (${i.serial_number})` : ""}`), el("div", { class: "sub" }, i.description),
      el("div", { class: "mono" }, `${when(i.created_at)} by ${i.reported_by_name}`), i.resolution ? el("div", { class: "sub" }, `Resolved by ${i.resolved_by_name}: ${i.resolution}`) : null]),
    td(i.stockist ?? "Warehouse"), td(pill(i.status === "OPEN" ? "Open" : "Resolved", i.status === "OPEN" ? "red" : "grey")),
    td(i.status === "OPEN" && can("FULFILMENT") && i.reported_by !== me.id ? el("button", { class: "btn small", onclick: action(async () => {
      const resolution = prompt("How was it resolved?"); if (!resolution) return;
      await post(`/v1/admin/stock/incidents/${i.id}/resolve`, { resolution }); return "Resolved.";
    }) }, "Resolve") : null)))) : el("p", { class: "sub" }, "No reports.")));

  if (can("FINANCE", "AUDITOR", "FULFILMENT")) {
    const { invoices } = await get("/v1/admin/stockist-invoices");
    nodes.push(el("h2", {}, "Centre invoices"), el("div", { class: "card" }, invoices.length ? table(["Invoice", "Centre", "#Amount", "Status", ""], invoices.map((i) => el("tr", {},
      td([el("b", {}, i.reference), el("div", { class: "sub" }, `${i.fees_count} handover${i.fees_count === 1 ? "" : "s"}${i.their_reference ? ` · their ref ${i.their_reference}` : ""}`)]),
      td(`${i.stockist_code} · ${i.stockist}`), td(naira(i.amount_kobo), true),
      td([pill(i.status === "PAID" ? "Paid" : i.status === "SUBMITTED" ? "Awaiting Finance" : "Rejected", i.status === "PAID" ? "" : i.status === "SUBMITTED" ? "gold" : "grey"), i.payment_ref ? el("div", { class: "mono" }, i.payment_ref) : null]),
      td(i.status === "SUBMITTED" && can("FINANCE") ? el("div", { class: "actions" },
        el("button", { class: "btn small", onclick: action(async () => { const r = await post(`/v1/admin/stockist-invoices/${i.id}/decision`, { approve: true }); return `Paid (${r.paymentRef}).`; }) }, "Approve and pay"),
        el("button", { class: "btn small ghost", onclick: action(async () => { const reason = prompt("Why is the invoice rejected?"); if (!reason) return; await post(`/v1/admin/stockist-invoices/${i.id}/decision`, { approve: false, reason }); return "Rejected."; }) }, "Reject")) : null)))) : el("p", { class: "sub" }, "No invoices yet.")));
  }

  nodes.push(el("h2", {}, "Reconciliation by centre"),
    rec.totalMismatches ? el("div", { class: "note bad" }, `${rec.totalMismatches} unit record${rec.totalMismatches === 1 ? " does" : "s do"} not add up: investigate before paying invoices.`) : el("div", { class: "note" }, "Every unit at every centre matches its handover records."),
    el("div", { class: "card" }, table(["Centre", "#On shelf", "#Awaiting collection", "#Handed over", "#Open reports", "#Fees", "#Mismatches"], rec.centres.map((r) => el("tr", {},
      td(`${r.code} · ${r.name}`), td(num(r.on_shelf), true), td(num(r.awaiting_collection), true), td(num(r.handed_over), true), td(num(r.open_incidents), true), td(naira(r.fees_kobo), true), td(num(r.mismatches), true))))));
  const STAGE = { ENTITLED: "Won, not yet claimed", ON_HOLD: "On hold", VERIFIED: "Claimed, to send", DISPATCHED: "Out for handover" };
  nodes.push(el("h2", {}, "Prizes still owed to winners"), el("div", { class: "card" }, out.byStatus.length
    ? table(["Stage", "#Prizes", "#Value", "#Waiting over 14 days", "#Claim period ends within 7 days"], out.byStatus.map((b) => el("tr", {},
      td(STAGE[b.status] ?? b.status), td(num(b.prizes), true), td(naira(b.value_kobo), true), td(num(b.older_than_14_days), true), td(num(b.expiring_within_7_days), true))))
    : el("p", { class: "sub" }, "Nothing owed.")));
  return nodes;
}

const ROUTES = { dashboard, cycles, cycle, approvals, payouts, refunds, nok: nokPage, support: supportPage, ticket: ticketPage, finance, merchandise, popups: popupsPage, affiliates: affiliatesPage, centres: centresPage, portal: portalPage, audit: auditPage, access };
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
  // Collection-centre staff see only their portal.
  const centreOnly = me.roles.includes("STOCKIST");
  document.querySelectorAll("#nav a").forEach((a) => { a.hidden = centreOnly ? a.dataset.nav !== "portal" : a.dataset.nav === "portal"; });
  let [name = "dashboard", arg] = location.hash.replace(/^#\/?/, "").split("/");
  if (centreOnly) name = "portal";
  const screen = ROUTES[name] ?? dashboard;
  const nav = name === "cycle" ? "cycles" : name === "ticket" ? "support" : ROUTES[name] ? name : "dashboard";
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
  if (centreOnly) return;
  get("/v1/admin/cycles").then(async (l) => {
    let n = l.cycles.filter((c) => c.status === "SUBMITTED" || c.void_pending).length;
    if (can("FINANCE", "COMPLIANCE", "AUDITOR")) n += (await get("/v1/admin/refunds?status=AWAITING_APPROVAL")).refunds.length;
    if (can("FINANCE", "PAYOUT_APPROVER", "COMPLIANCE", "AUDITOR")) n += (await get("/v1/admin/payouts/pending")).payouts.length;
    const badge = document.getElementById("apCount");
    badge.hidden = n === 0; badge.textContent = n;
  }).catch(() => {});
}

document.getElementById("signOut").addEventListener("click", async () => { await post("/v1/admin/logout").catch(() => {}); me = null; location.hash = ""; render(); });
window.addEventListener("hashchange", render);
render();
