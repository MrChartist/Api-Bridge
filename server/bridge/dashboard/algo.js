// algo.js: Trade › Algo. Python strategies from the strategies folder in the Bridge home (docs/STRATEGIES-PYTHON.md):
// the list with status, account, mode, P&L today, orders and uptime; Start and Stop; the params form drawn from each
// file's declared params; a live log tail; the orders it placed (linked to Orders); and "How to write one" with a
// template to copy. Data: /v1/strategies (admin, this computer only). The Bridge runs each strategy with a key made
// for that run and every order passes its safety gates; this page never places an order itself. Numbers become text
// only through format.js.
import { api, app, codeBlock, copyButton, emptyState, errorState, h, icon, istTime, modal, optional, pill, toast } from "./app.js";
import { DASH, formatGrouped, formatInt, formatNumber, formatSignedRupee, isFigure } from "./format.js";
import { clearFieldError, fieldError } from "./flows.js";
import { DOCS_URL, LIST_MS, LOG_MS, TEMPLATE, heartbeatText, isActive, logGap, modeText, paramFields, readParams, serverFieldErrors, statusOf, totals, uptimeText } from "./algo-core.js";

const SLOT = "mcb.dashboard.algo";
const tone = (v) => (isFigure(v) && v > 0 ? "up" : isFigure(v) && v < 0 ? "down" : "");
const money = (v) => h("span", { class: `nowrap ${tone(v)}` }, isFigure(v) ? formatSignedRupee(v) : DASH);
const enc = encodeURIComponent;

const prefs = () => {
  try {
    return JSON.parse(app.local.get(SLOT) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

/** The shipped examples (sdk/python/examples/strategies): name, file and what it does. */
const EXAMPLES = [
  ["Short straddle", "short_straddle.py", "Sells the ATM call and put of the nearest weekly expiry; exits both on a stop loss or a target on the combined premium, or at the square-off time."],
  ["EMA crossover", "ema_crossover.py", "Follows a fast EMA crossing a slow EMA on the nearest index future, with an ATM option or the future itself."],
  ["Iron condor", "iron_condor.py", "A short strangle near a chosen delta with bought wings; rolls the untested side when the position delta drifts."],
  ["OI walls", "oi_walls.py", "Sells the put at the OI support and the call at the OI resistance, biased by the put-call ratio, with a stop loss per leg."],
];

export async function renderAlgoPage() {
  const first = await optional(api("/v1/strategies", { fresh: true }));
  if (first.error) return [errorState(first.error, { onRetry: () => (location.hash = "#/algo") })];
  const accountsRes = await optional(api("/v1/accounts"));
  const accounts = (accountsRes.data?.data ?? []).filter((a) => a.enabled !== false && (a.broker === "paper" || (a.capabilities ?? []).includes("placeOrder")));
  const st = { data: first.data.data, sel: prefs().sel ?? null, detail: null, logAfter: 0, follow: true, formFor: null, dirty: false, busy: false };
  // No remembered choice: open on a running strategy, else the first one.
  if (!st.data.items.some((s) => s.id === st.sel)) st.sel = (st.data.items.find((s) => isActive(s.status)) ?? st.data.items[0])?.id ?? null;
  const save = () => app.local.set(SLOT, JSON.stringify({ sel: st.sel }));
  let listTimer = 0;
  let logTimer = 0;

  // ── the summary strip ──
  const kRunning = h("strong", { class: "algo-kv" });
  const kPnl = h("strong", { class: "algo-kv" });
  const kOrders = h("strong", { class: "algo-kv" });
  const kFolder = h("code", { class: "algo-path", title: "" });
  const killPill = h("a", { href: "#/safety", class: "algo-kill" });
  const addBtn = h("button", { type: "button", class: "small", onclick: () => addExamples() }, icon("plus"), h("span", {}, "Add the examples"));
  const stopAllBtn = h("button", { type: "button", class: "small", onclick: () => stopAll() }, icon("stop"), h("span", {}, "Stop all"));
  const kpi = (label, value, extra = null) => h("div", { class: "algo-kpi" }, h("span", { class: "algo-kl" }, label), value, extra);
  const bar = h(
    "section",
    { class: "card algo-bar" },
    h("div", { class: "algo-kpis" }, kpi("Running", kRunning), kpi("P&L today", kPnl), kpi("Orders today", kOrders), kpi("Strategies folder", kFolder, copyButton(() => st.data.dir, { label: "Copy", ariaLabel: "Copy the folder path", toastLabel: "Folder path copied" }))),
    h("div", { class: "algo-bar-acts" }, killPill, addBtn, stopAllBtn),
  );

  // ── the list ──
  const listBody = h("div", { class: "algo-rows", role: "list" });
  const listNote = h("p", { class: "muted small algo-note" });
  const listCard = h("section", { class: "card algo-list" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Strategies"), h("p", {}, "Python files in your strategies folder. Paper by default"))), listBody, listNote);

  // ── how to write one ──
  const howto = h(
    "section",
    { class: "card algo-howto" },
    h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "How to write one"), h("p", {}, "A class with on_start, on_tick, on_bar, on_order_update and on_stop")), h("div", { class: "card-actions" }, h("a", { class: "btn small quiet", href: DOCS_URL, target: "_blank", rel: "noopener noreferrer" }, icon("external"), h("span", {}, "Guide")))),
    h(
      "ol",
      { class: "algo-steps" },
      h("li", {}, "Copy the template into a new ", h("code", {}, "name.py"), " in the strategies folder above."),
      h("li", {}, "Declare your settings in ", h("code", {}, "params"), ": this page draws the form from them."),
      h("li", {}, "Trade with ", h("code", {}, "self.buy"), ", ", h("code", {}, "self.sell"), " and ", h("code", {}, "self.exit"), ". Every order goes through the Bridge: kill switch, limits, paper unless you start it live."),
      h("li", {}, "Press Start. Python 3.9 or newer runs it; the log shows here."),
    ),
    codeBlock(TEMPLATE, { title: "my_strategy.py" }),
  );

  // ── the detail ──
  const dTitle = h("h2", { class: "algo-dtitle" });
  const dFile = h("span", { class: "muted small algo-dfile" });
  const dStatus = h("span", { class: "algo-dstatus" });
  const dDesc = h("p", { class: "muted algo-ddesc" });
  const dAlert = h("div", { class: "algo-dalert", hidden: true });
  const dFacts = h("dl", { class: "algo-facts" });
  const dResumed = h("p", { class: "algo-resumed", hidden: true });
  const startBtn = h("button", { type: "button", class: "primary", onclick: () => start("paper") }, icon("play"), h("span", {}, "Start paper"));
  const liveBtn = h("button", { type: "button", class: "quiet", onclick: () => start("live") }, h("span", {}, "Start live"));
  const stopBtn = h("button", { type: "button", onclick: () => stop() }, icon("stop"), h("span", {}, "Stop"));
  const acctSel = h("select", { id: "algo-account", "aria-label": "Account" });
  const paramsHost = h("div", { class: "algo-params" });
  // One line over the form when values need a fix (each field also says what is wrong under it).
  const formMsg = h("p", { class: "algo-form-msg", role: "alert", hidden: true });
  const showFormMsg = (n) => {
    formMsg.hidden = !n;
    formMsg.textContent = n ? `${formatInt(n)} setting${n === 1 ? " needs" : "s need"} a fix before the start. See the message under ${n === 1 ? "it" : "each"}.` : "";
  };
  const saveBtn = h("button", { type: "button", class: "small quiet", onclick: () => saveSettings() }, "Save settings");
  const settings = h(
    "section",
    { class: "algo-pane algo-settings", "aria-label": "Settings" },
    h("div", { class: "algo-pane-head" }, h("h3", {}, "Settings"), saveBtn),
    h("label", { class: "field algo-acct", for: "algo-account" }, h("span", {}, "Account"), acctSel),
    formMsg,
    paramsHost,
  );
  const logList = h("ol", { class: "algo-log-lines", "aria-live": "off" });
  const followChk = h("input", { type: "checkbox", checked: true });
  followChk.addEventListener("change", () => {
    st.follow = followChk.checked;
    if (st.follow) logList.scrollTop = logList.scrollHeight;
  });
  const logPane = h(
    "section",
    { class: "algo-pane algo-log", "aria-label": "Log" },
    h("div", { class: "algo-pane-head" }, h("h3", {}, "Log"), h("label", { class: "check small" }, followChk, "Follow"), copyButton(() => [...logList.querySelectorAll("li")].map((li) => li.textContent).join("\n"), { label: "Copy", ariaLabel: "Copy the log", toastLabel: "Log copied" })),
    logList,
  );
  logList.addEventListener("scroll", () => {
    const atEnd = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 24;
    if (atEnd !== st.follow) {
      st.follow = atEnd;
      followChk.checked = atEnd;
    }
  });
  const ordersHost = h("div", { class: "algo-orders-body" });
  const ordersPane = h("section", { class: "algo-pane algo-orders", "aria-label": "Orders today" }, h("div", { class: "algo-pane-head" }, h("h3", {}, "Orders today"), h("a", { class: "btn small quiet", href: "#/orders" }, h("span", {}, "Open Orders"), icon("chevron"))), ordersHost);
  const detail = h(
    "section",
    { class: "card algo-detail" },
    h("header", { class: "algo-dhead" }, h("div", { class: "algo-dtitles" }, h("div", { class: "algo-dline" }, dTitle, dStatus), dFile), h("div", { class: "algo-dacts" }, startBtn, liveBtn, stopBtn)),
    dDesc,
    dAlert,
    dResumed,
    dFacts,
    h("div", { class: "algo-dbody" }, settings, logPane, ordersPane),
  );
  // ── nothing chosen yet (no strategies): the right column offers the shipped examples and the template ──
  const starter = h(
    "section",
    { class: "card algo-starter" },
    h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Create from an example"), h("p", {}, "The four strategies the Bridge ships. Each one runs in paper until you start it live"))),
    h(
      "ul",
      { class: "algo-ex-list" },
      EXAMPLES.map(([name, file, text]) => h("li", { class: "algo-ex" }, h("div", { class: "algo-ex-t" }, h("strong", {}, name), h("span", { class: "muted small" }, file)), h("p", { class: "small" }, text))),
    ),
    h("div", { class: "algo-ex-acts" }, h("button", { type: "button", class: "primary", onclick: () => addExamples() }, icon("plus"), h("span", {}, "Add the four examples")), h("span", { class: "muted small" }, "Copied into the strategies folder; a file already there is never overwritten.")),
  );
  const side = h("div", { class: "algo-side" }, listCard, howto);
  const right = h("div", { class: "algo-right" }, detail, starter);
  const grid = h("div", { class: "algo-grid" }, side, right);

  const cur = () => st.data.items.find((s) => s.id === st.sel) ?? null;

  function drawBar() {
    const t = totals(st.data.items);
    kRunning.textContent = `${formatInt(t.running)} of ${formatInt(t.count)}`;
    kPnl.replaceChildren(money(t.pnl));
    kOrders.textContent = formatInt(t.orders);
    kFolder.textContent = st.data.dir;
    kFolder.title = st.data.dir;
    killPill.replaceChildren(st.data.killSwitch ? pill("Kill switch on", "bad") : pill("Kill switch off", "ok"));
    killPill.title = st.data.killSwitch ? "No strategy can start until the kill switch is released on Safety" : "The kill switch stops every strategy at once (Safety)";
    stopAllBtn.disabled = t.running === 0;
    addBtn.hidden = st.data.items.length > 0 && st.data.examples > 0 && st.data.items.length >= st.data.examples && !st.data.skipped.length;
  }

  function row(s) {
    const stt = statusOf(s.status);
    const active = isActive(s.status);
    const act = active
      ? h("button", { type: "button", class: "small", "aria-label": `Stop ${s.name}`, onclick: (e) => (e.stopPropagation(), stop(s.id)) }, icon("stop"), h("span", {}, "Stop"))
      : h("button", { type: "button", class: s.problem || st.data.killSwitch ? "small" : "small primary", disabled: Boolean(s.problem) || st.data.killSwitch, "aria-label": `Start ${s.name} in paper`, onclick: (e) => (e.stopPropagation(), selectAnd(s.id, () => start("paper"))) }, icon("play"), h("span", {}, "Start"));
    const r = h(
      "div",
      { class: `algo-row${s.id === st.sel ? " sel" : ""}`, role: "listitem" },
      h("button", { type: "button", class: "quiet algo-row-main", "aria-current": s.id === st.sel ? "true" : undefined, onclick: () => select(s.id) }, h("strong", {}, s.name), h("span", { class: "muted small" }, s.file ?? s.id), s.problem ? h("span", { class: "algo-row-problem" }, problemText(s)) : null),
      h("span", { class: "algo-c-status" }, pill(stt.text, stt.tone)),
      h(
        "span",
        { class: "algo-row-meta" },
        h("span", { class: `algo-c-acct${s.account ? "" : " muted"}`, title: s.account ? `Account ${s.account}` : "Account" }, s.account ?? "No account"),
        h("span", { class: `algo-mode ${active && s.mode === "live" ? "live" : ""}`.trim() }, modeText(active ? s.mode : "paper")),
        h("span", { class: "algo-c-pnl num", title: "P&L today from this strategy's own orders" }, s.pnl ? money(s.pnl.total) : h("span", { class: "muted" }, "Not run today")),
        h("span", { class: "algo-c-ord num", title: active ? "Orders since Start" : "Orders today, every run" }, ordersText(s, active)),
        h("span", { class: "algo-c-up num", title: "Uptime" }, active ? uptimeText(s.uptimeMs) : ""),
      ),
      h("span", { class: "algo-c-act" }, act),
    );
    return r;
  }

  function drawList() {
    const items = st.data.items;
    if (!st.data.exists || !items.length) {
      listBody.replaceChildren(
        // One way to add the examples: the "Create from an example" panel beside (under, on phones) the list.
        emptyState("console", "No strategies yet", st.data.problem ? `${st.data.problem}.` : "Start from an example, or save your own .py file in the strategies folder.", null, { compact: true }),
      );
    } else listBody.replaceChildren(...items.map(row));
    const notes = [];
    if (st.data.problem) notes.push(st.data.problem);
    for (const sk of st.data.skipped ?? []) notes.push(`${sk.file}: ${sk.reason}`);
    listNote.textContent = notes.join(" · ");
    listNote.hidden = !notes.length;
  }

  function fact(label, value, title) {
    return h("div", { class: "algo-fact", title }, h("dt", {}, label), h("dd", {}, value));
  }

  function drawDetail() {
    const s = cur();
    detail.hidden = !s;
    // With nothing to show on the right, the examples fill it (their button is the only "add" on the page then).
    starter.hidden = Boolean(s);
    if (!s) addBtn.hidden = true;
    if (!s) return;
    const d = st.detail?.id === s.id ? st.detail : null;
    const stt = statusOf(s.status);
    const active = isActive(s.status);
    dTitle.textContent = s.name;
    dFile.textContent = s.file ? `${s.file} · ${s.id}` : s.id;
    dStatus.replaceChildren(pill(stt.text, stt.tone), h("span", { class: `algo-mode ${active && s.mode === "live" ? "live" : ""}`.trim() }, modeText(active ? s.mode : "paper")));
    dDesc.textContent = s.description || "No description in the file (add description = \"...\" to the class).";
    const problem = s.problem ? `${problemText(s)}. Fix the file and save it: this page reads it again within 2 s.` : (s.status === "failed" || s.status === "restarting" ? s.lastError : null);
    dAlert.hidden = !problem;
    dAlert.className = `algo-dalert ${s.problem || s.status === "failed" ? "bad" : "warn"}`;
    dAlert.replaceChildren(problem ? h("span", {}, icon("warn"), h("span", {}, problem)) : "");
    const hb = heartbeatText(s.heartbeatAgeMs);
    dResumed.hidden = !(active && s.resumedLegs);
    dResumed.textContent = active && s.resumedLegs ? `Resumed ${formatInt(s.resumedLegs)} open leg${s.resumedLegs === 1 ? "" : "s"} from an earlier run today. Open P&L and Stop include ${s.resumedLegs === 1 ? "it" : "them"}; Orders since start counts only this run.` : "";
    dFacts.replaceChildren(
      fact("P&L today", money(s.pnl?.total), "Every run of this strategy today, from its own fills"),
      fact("Realised", money(s.pnl?.realised)),
      fact("Open", money(s.pnl?.unrealised), s.resumedLegs ? "Includes the legs resumed from an earlier run today" : undefined),
      fact("Orders since start", active ? formatInt(s.runOrderCount) : DASH),
      fact("Orders today", formatInt(s.orderCount)),
      fact("Uptime", active ? uptimeText(s.uptimeMs) : DASH),
      fact("Restarts", `${formatInt(s.restarts)} of ${formatInt(s.maxRestarts)}`),
      fact("Ticks", active ? formatInt(s.counts?.ticks ?? 0) : DASH),
      // A failed strategy's reason is in the alert above; a stopped one says why it stopped.
      fact(active ? "Heartbeat" : "Last stop", active ? h("span", { class: hb.late ? "warn-text" : undefined }, hb.text) : s.stopReason && s.status !== "failed" ? h("span", { class: "muted", title: s.stopReason }, s.stopReason) : DASH),
    );
    startBtn.hidden = liveBtn.hidden = active;
    stopBtn.hidden = !active;
    startBtn.disabled = liveBtn.disabled = Boolean(s.problem) || st.data.killSwitch || st.busy;
    // A start that cannot happen (a broken file, the kill switch) is not drawn as the page's main action.
    startBtn.classList.toggle("primary", !(s.problem || st.data.killSwitch));
    stopBtn.disabled = s.status === "stopping" || st.busy;
    saveBtn.disabled = active || Boolean(s.problem);
    // The form is drawn again only for another strategy, a changed file, or after a start or stop (not while typing).
    const formKey = `${s.id}:${JSON.stringify(s.params)}:${active}`;
    if (st.formFor !== formKey && !(st.dirty && st.formFor?.startsWith(`${s.id}:`))) drawForm(s, active);
    drawOrders(d);
  }

  let fields = [];
  const inputs = new Map();
  function drawForm(s, active) {
    st.formFor = `${s.id}:${JSON.stringify(s.params)}:${active}`;
    st.dirty = false;
    showFormMsg(0);
    const ids = new Set(accounts.map((a) => a.id));
    const opts = accounts.map((a) => h("option", { value: a.id, selected: a.id === s.account }, `${a.label ?? a.id}${a.broker === "paper" ? " (paper)" : ""}`));
    if (s.account && !ids.has(s.account)) opts.unshift(h("option", { value: s.account, selected: true }, s.account));
    if (!s.account) opts.unshift(h("option", { value: "", selected: true, disabled: true }, "Choose an account"));
    acctSel.replaceChildren(...opts);
    if (!s.account) {
      const paper = accounts.find((a) => a.broker === "paper");
      if (paper) acctSel.value = paper.id;
    }
    acctSel.disabled = active;
    fields = paramFields(s.params, s.values);
    inputs.clear();
    if (!fields.length) {
      paramsHost.replaceChildren(h("p", { class: "muted small" }, s.problem ? "Fix the file to see its settings." : "This strategy declares no params."));
      return;
    }
    paramsHost.replaceChildren(
      ...fields.map((f) => {
        const id = `algo-p-${f.name}`;
        let input;
        if (f.input === "checkbox") input = h("input", { id, type: "checkbox", checked: f.value === true });
        else if (f.input === "select") input = h("select", { id }, ...(f.choices ?? []).map((c) => h("option", { value: String(c), selected: c === f.value }, String(c))));
        else if (f.input === "number") input = h("input", { id, type: "number", inputmode: f.kind === "int" ? "numeric" : "decimal", value: isFigure(f.value) ? formatNumber(f.value, { maximumFractionDigits: 6 }) : "", min: isFigure(f.min) ? formatNumber(f.min, { maximumFractionDigits: 6 }) : undefined, max: isFigure(f.max) ? formatNumber(f.max, { maximumFractionDigits: 6 }) : undefined, step: f.step === "any" ? "any" : isFigure(f.step) ? formatNumber(f.step, { maximumFractionDigits: 6 }) : undefined });
        else input = h("input", { id, type: "text", value: String(f.value ?? ""), maxlength: "200", autocomplete: "off", spellcheck: "false" });
        input.disabled = active;
        input.addEventListener("input", () => {
          st.dirty = true;
          clearFieldError(input);
          if (!paramsHost.querySelector("[aria-invalid='true']")) showFormMsg(0);
        });
        input.addEventListener("change", () => (st.dirty = true));
        inputs.set(f.name, input);
        if (f.input === "checkbox") return h("label", { class: "check algo-param algo-param-bool", title: f.help || undefined }, input, h("span", {}, f.label));
        return h("label", { class: "field algo-param", for: id, title: f.help || undefined }, h("span", {}, f.label), input, f.help ? h("small", { class: "muted" }, f.help) : null);
      }),
    );
  }

  /** The form's values, or null with the errors shown under their fields. */
  function formValues() {
    const raw = {};
    for (const f of fields) {
      const el = inputs.get(f.name);
      raw[f.name] = f.input === "checkbox" ? el.checked : el.value;
    }
    const { values, errors } = readParams(fields, raw);
    let firstBad = true;
    for (const [name, msg] of Object.entries(errors)) {
      fieldError(inputs.get(name), msg, { focus: firstBad });
      firstBad = false;
    }
    showFormMsg(Object.keys(errors).length);
    return Object.keys(errors).length ? null : values;
  }

  function showServerErrors(err) {
    const errs = serverFieldErrors(err);
    let any = false;
    for (const [name, msg] of Object.entries(errs)) {
      const el = inputs.get(name);
      if (el) {
        fieldError(el, msg, { focus: !any });
        any = true;
      }
    }
    if (err?.body?.errors?.some((e) => e.path === "account")) {
      fieldError(acctSel, err.body.errors.find((e) => e.path === "account").message);
      any = true;
    }
    showFormMsg(Object.keys(errs).length);
    return any;
  }

  function drawOrders(d) {
    if (!d) {
      ordersHost.replaceChildren(h("p", { class: "muted small" }, "Loading"));
      return;
    }
    const pos = (d.positions ?? []).filter((p) => p.qty !== 0);
    const orders = d.orders ?? [];
    if (!orders.length) {
      ordersHost.replaceChildren(h("p", { class: "muted small algo-empty" }, d.ordersError ? `Orders unavailable: ${d.ordersError}` : "No orders from this strategy today."));
      return;
    }
    const posTable = pos.length
      ? h(
          "table",
          { class: "desk-table algo-pos" },
          h("caption", { class: "algo-cap" }, "Open positions"),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Symbol"), h("th", { scope: "col", class: "num" }, "Qty"), h("th", { scope: "col", class: "num" }, "Avg"), h("th", { scope: "col", class: "num" }, "LTP"), h("th", { scope: "col", class: "num" }, "P&L"))),
          h("tbody", {}, pos.map((p) => h("tr", {}, h("th", { scope: "row" }, short(p.symbol)), h("td", { class: "num" }, formatInt(p.qty)), h("td", { class: "num" }, formatGrouped(p.avg, 2)), h("td", { class: "num" }, formatGrouped(p.ltp, 2)), h("td", { class: "num" }, money(p.unrealised + p.realised))))),
        )
      : null;
    const ordTable = h(
      "table",
      { class: "desk-table algo-ord" },
      h("caption", { class: "algo-cap" }, `${formatInt(orders.length)} order${orders.length === 1 ? "" : "s"}, newest first`),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Time"), h("th", { scope: "col" }, "Side"), h("th", { scope: "col" }, "Symbol"), h("th", { scope: "col", class: "num" }, "Qty"), h("th", { scope: "col", class: "num" }, "Avg"), h("th", { scope: "col" }, "Status"))),
      h(
        "tbody",
        {},
        orders.map((o) =>
          h(
            "tr",
            {},
            h("td", { class: "nowrap" }, istTime(o.placedAt)),
            h("td", {}, h("span", { class: `side-tag ${o.side === "BUY" ? "buy" : "sell"}`, title: o.side === "BUY" ? "Buy" : "Sell" }, o.side === "BUY" ? "B" : "S")),
            h("th", { scope: "row" }, h("a", { href: "#/orders", title: `${o.orderId} · ${o.clientOrderId ?? ""}` }, short(o.symbol))),
            h("td", { class: "num" }, formatInt(o.filledQuantity || o.quantity)),
            h("td", { class: "num" }, formatGrouped(o.avgPrice, 2)),
            h("td", {}, statusWord(o.status)),
          ),
        ),
      ),
    );
    ordersHost.replaceChildren(...[posTable, ordTable].filter(Boolean));
  }
  /** Orders since Start while it runs, else every run today (the detail shows both). */
  function ordersText(s, active) {
    if (!s.pnl && !s.orderCount) return "";
    const n = active ? s.runOrderCount : s.orderCount;
    return `${formatInt(n)} order${n === 1 ? "" : "s"}`;
  }
  /** "bad.py, line 4: params['x']: use literal values only". */
  const problemText = (s) => `${s.file ?? s.id}${s.problemLine ? `, line ${formatInt(s.problemLine)}` : ""}: ${s.problem}`;
  const short = (sym) => String(sym ?? "").replace(/^(NFO|BFO|NSE|BSE|MCX|CDS):/, "");
  const statusWord = (s) => (s === "filled" ? "Filled" : s === "rejected" ? h("span", { class: "down" }, "Rejected") : s ? `${s[0].toUpperCase()}${s.slice(1).replace(/_/g, " ")}` : DASH);

  // ── log tail ──
  function appendLog(items, truncated) {
    if (!items.length) return;
    const atEnd = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 24;
    if (truncated) logList.append(h("li", { class: "algo-ll muted" }, "Older lines were dropped from the log."));
    logList.append(...items.map((l) => h("li", { class: `algo-ll lv-${l.level}` }, h("time", {}, istTime(new Date(l.at).toISOString())), h("span", { class: "algo-lvl" }, l.level === "info" ? "" : l.level), h("span", { class: "algo-lt" }, l.text))));
    while (logList.childElementCount > 1500) logList.firstElementChild.remove();
    if (st.follow || atEnd) logList.scrollTop = logList.scrollHeight;
  }
  async function loadLog() {
    clearTimeout(logTimer);
    if (!grid.isConnected && st.logAfter) return;
    const id = st.sel;
    if (id) {
      const r = await optional(api(`/v1/strategies/${enc(id)}/logs?after=${st.logAfter}`, { fresh: true }));
      if (id === st.sel && !r.error) {
        const d = r.data.data;
        if (d.last < st.logAfter) {
          logList.replaceChildren();
          st.logAfter = 0;
        } else {
          appendLog(d.items, d.truncated);
          st.logAfter = d.last;
        }
        if (!logList.childElementCount) logList.append(h("li", { class: "algo-ll muted" }, "Nothing logged yet. Start the strategy to see its log here."));
      }
    }
    logTimer = setTimeout(pollLog, logGap(cur()?.status));
  }
  // A hidden tab reads nothing: the timer comes round again and reads once the tab is back in view.
  function pollLog() {
    if (!grid.isConnected) return;
    if (document.hidden) logTimer = setTimeout(pollLog, LOG_MS);
    else loadLog();
  }
  function pollAll() {
    if (!grid.isConnected) return;
    if (document.hidden) listTimer = setTimeout(pollAll, LOG_MS);
    else loadAll();
  }

  // ── refresh ──
  async function loadAll() {
    clearTimeout(listTimer);
    const [l, d] = await Promise.all([optional(api("/v1/strategies", { fresh: true })), st.sel ? optional(api(`/v1/strategies/${enc(st.sel)}`, { fresh: true })) : Promise.resolve(null)]);
    if (!l.error) st.data = l.data.data;
    if (d && !d.error && d.data.data.id === st.sel) st.detail = d.data.data;
    if (!st.data.items.some((s) => s.id === st.sel) && st.data.items.length) select(st.data.items[0].id, { quiet: true });
    draw();
    listTimer = setTimeout(pollAll, LIST_MS);
  }
  function draw() {
    drawBar();
    drawList();
    drawDetail();
  }
  function select(id, { quiet = false } = {}) {
    if (id === st.sel && !quiet) return;
    st.sel = id;
    st.detail = null;
    st.logAfter = 0;
    st.formFor = null;
    st.dirty = false;
    logList.replaceChildren();
    save();
    draw();
    loadAll();
    loadLog();
  }
  function selectAnd(id, then) {
    if (id !== st.sel) select(id);
    then();
  }

  // ── actions ──
  async function start(mode) {
    const s = cur();
    if (!s || st.busy) return;
    const values = formValues();
    if (!values) return;
    const account = acctSel.value;
    if (!account) return fieldError(acctSel, "Choose the account the strategy trades on.");
    const body = { account, params: values };
    if (mode === "live") {
      const typed = h("input", { id: "algo-live-confirm", type: "text", autocomplete: "off", spellcheck: "false", placeholder: s.id });
      const ok = await modal({
        title: `Start ${s.name} with real money?`,
        body: h(
          "div",
          { class: "stack" },
          h("p", {}, `Live orders on ${account}. The Bridge still refuses them unless live trading is on in the config file, the account allows live orders from REST, your key has the live scope and the account is ready to trade. Limits and the kill switch apply to every order.`),
          h("label", { class: "field", for: "algo-live-confirm" }, h("span", {}, `Type ${s.id} to confirm`), typed),
        ),
        buttons: [{ label: "Cancel", value: false }, { label: "Start live", cls: "primary", onClick: () => (typed.value.trim() === s.id ? true : (fieldError(typed, `Type ${s.id} exactly.`), false)) }],
      });
      if (!ok) return;
      Object.assign(body, { mode: "live", confirmLive: s.id });
    }
    st.busy = true;
    drawDetail();
    const r = await optional(api(`/v1/strategies/${enc(s.id)}/start`, { method: "POST", body }));
    st.busy = false;
    if (r.error) {
      if (!showServerErrors(r.error)) toast(`${mode === "live" ? "Live start refused" : "Not started"}: ${r.error.message}`, { tone: "error" });
      drawDetail();
      return;
    }
    toast(`${s.name} started (${mode === "live" ? "live" : "paper"} on ${account})`);
    st.formFor = null;
    loadAll();
    loadLog();
  }

  async function stop(id = st.sel) {
    const s = st.data.items.find((x) => x.id === id);
    if (!s) return;
    st.busy = true;
    drawDetail();
    const r = await optional(api(`/v1/strategies/${enc(id)}/stop`, { method: "POST" }));
    st.busy = false;
    if (r.error) toast(`Not stopped: ${r.error.message}`, { tone: "error" });
    else toast(`Stopping ${s.name}`);
    loadAll();
  }

  async function stopAll() {
    const n = totals(st.data.items).running;
    const ok = await modal({ title: `Stop ${formatInt(n)} running strateg${n === 1 ? "y" : "ies"}?`, body: h("p", {}, "Each one runs its on_stop (the examples close their positions), then ends. To stop every order from every tool, use the kill switch on Safety."), buttons: [{ label: "Cancel", value: false }, { label: "Stop all", cls: "primary", value: true }] });
    if (!ok) return;
    const r = await optional(api("/v1/strategies/stop-all", { method: "POST" }));
    if (r.error) toast(`Not stopped: ${r.error.message}`, { tone: "error" });
    else toast(`Stopping ${formatInt(r.data.data.stopped.length)}`);
    loadAll();
  }

  async function addExamples() {
    const r = await optional(api("/v1/strategies/examples", { method: "POST" }));
    if (r.error) return toast(`Not added: ${r.error.message}`, { tone: "error" });
    const d = r.data.data;
    toast(d.added.length ? `Added ${formatInt(d.added.length)} examples to the strategies folder` : "The examples are already in the folder");
    loadAll();
  }

  async function saveSettings() {
    const s = cur();
    if (!s) return;
    const values = formValues();
    if (!values) return;
    const r = await optional(api(`/v1/strategies/${enc(s.id)}/settings`, { method: "PUT", body: { account: acctSel.value || undefined, params: values } }));
    if (r.error) {
      if (!showServerErrors(r.error)) toast(`Not saved: ${r.error.message}`, { tone: "error" });
      return;
    }
    st.dirty = false;
    toast("Saved for the next start");
    loadAll();
  }

  draw();
  loadAll();
  loadLog();
  return [bar, grid];
}
