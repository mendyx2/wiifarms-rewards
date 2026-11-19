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
    const s = await get(`/v1/admin/finance/summary?from=${summaryRange.from}&to=${summaryRange.to}`);
    summaryBox.replaceChildren(el("div", { class: "tiles" },
      el("div", { class: "tile" }, el("span", {}, "Collected"), el("b", {}, naira(s.collected_kobo)), el("small", {}, `${num(s.purchases)} purchases`)),
      el("div", { class: "tile" }, el("span", {}, "Refunded"), el("b", {}, naira(s.refunded_kobo))),
      el("div", { class: "tile" }, el("span", {}, "Cash prizes awarded"), el("b", {}, naira(s.cash_prizes_kobo))),
      el("div", { class: "tile" }, el("span", {}, "Paid out to winners"), el("b", {}, naira(s.paid_out_kobo))),
      el("div", { class: "tile" }, el("span", {}, "Operating expenses"), el("b", {}, naira(s.operating_expenses_kobo))),
      el("div", { class: "tile " + (s.result_kobo >= 0 ? "ok" : "warn") }, el("span", {}, "Result (before merchandise)"), el("b", {}, naira(s.result_kobo))),
      el("div", { class: "tile " + (s.days_mismatched ? "bad" : "ok") }, el("span", {}, "Reconciliation"), el("b", {}, `${s.days_signed_off} signed off`), el("small", {}, `${s.days_mismatched} with differences`))),
      s.expensesByCategory.length ? el("p", { class: "sub" }, "Expenses: " + s.expensesByCategory.map((x) => `${catText(x.category)} ${naira(x.amount_kobo)}`).join(" · ")) : null);
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
        const body = {}; if (v(form, "carrier")) body.carrier = v(form, "carrier"); if (v(form, "tracking")) body.trackingRef = v(form, "tracking");
        await post(`/v1/admin/fulfilment/${q.id}/dispatch`, body);
        return "Marked as sent. The winner now has a one-time handover code in their app.";
      }) }, el("div", { class: "form" },
        input(q.method === "DELIVERY" ? "Carrier" : "Collection point (optional)", { name: "carrier" }), input("Tracking reference (optional)", { name: "tracking" }),
        el("button", { class: "btn", type: "submit" }, q.method === "DELIVERY" ? "Dispatch" : "Ready for collection")));
      card.append(form);
    }
    if (f && q.status === "DISPATCHED") {
      const form = el("form", { onsubmit: action(async () => {
        const body = { code: v(form, "code"), photoRef: v(form, "photo") }; if (v(form, "warranty")) body.warrantyDocumentRef = v(form, "warranty");
        await post(`/v1/admin/fulfilment/${q.id}/handover`, body);
        return "Handover complete and recorded.";
      }) }, el("p", { class: "sub" }, "Ask the winner for the code shown in their app. Staff cannot see it. Five wrong codes lock the handover."),
        el("div", { class: "form" },
          input("Winner's handover code", { name: "code", inputmode: "numeric", maxlength: 6, required: true, autocomplete: "off" }),
          input("Handover photo (file reference)", { name: "photo", required: true }), input("Warranty document (optional)", { name: "warranty" }),
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

const ROUTES = { dashboard, cycles, cycle, approvals, payouts, refunds, nok: nokPage, finance, merchandise, audit: auditPage, access };
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
