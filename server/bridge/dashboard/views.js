// Dashboard pages. Each page renders into #content from live Bridge data; nothing here stores data outside this tab
// except small conveniences in localStorage (theme, a dismissed checklist, "you copied a snippet").
import {
  alertBox,
  api,
  app,
  card,
  checklistState,
  codeBlock,
  confirmCodeNotice,
  copyText,
  currentKey,
  emptyState,
  fmtInt,
  fmtNum,
  fmtRs,
  h,
  highlightJson,
  icon,
  istDateTime,
  istTime,
  meterRow,
  modal,
  optional,
  pill,
  table,
  ticketFields,
  toast,
} from "./app.js";
import { KEY_PRESETS, snippets } from "./snippets.js";

const $ = (id) => document.getElementById(id);
const local = app.local;
const FLAG = { copied: "mcb.dashboard.copied", tested: "mcb.dashboard.tested", hideChecklist: "mcb.dashboard.hideChecklist", hideOwn: "mcb.dashboard.hideOwnRequests" };
const markCopied = () => local.set(FLAG.copied, "1");
const scopeChip = (s) => h("span", { class: `chip scope-${s}` }, s);
const sessionPill = (s) => pill(s ?? "—", s === "connected" ? "ok" : s === "expired" || s === "error" ? "bad" : "warn");
const demoPill = () => (app.state.demo ? pill("Demo data", "demo") : null);
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
const initials = (name) => String(name).replace(/\(.*?\)/g, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const signed = (n) => (n > 0 ? `+${fmtNum.format(n)}` : fmtNum.format(n));

// ── Pages ──

const PAGES = [
  { id: "home", label: "Home", icon: "home", group: "Overview", title: "Home", sub: "Your Bridge at a glance", render: renderHome },
  { id: "accounts", label: "Accounts", icon: "accounts", group: "Overview", title: "Accounts and brokers", sub: "Broker accounts, sessions and the 41 supported brokers", render: renderAccounts },
  { id: "console", label: "Test console", icon: "console", group: "Overview", title: "Test console", sub: "Try any call and see exactly what comes back", render: renderConsole },
  { id: "limits", label: "Rate limits", icon: "limits", group: "Overview", title: "Rate limits", sub: "Live usage against each broker's limits, and the calls the Bridge saved", render: renderLimits },
  { id: "orders", label: "Orders", icon: "orders", group: "Trading", title: "Orders and positions", sub: "Paper by default. Pending confirmations wait here", render: renderOrders },
  { id: "safety", label: "Safety", icon: "safety", group: "Trading", title: "Safety", sub: "Kill switch, daily limits and live-trading status", render: renderSafety },
  { id: "keys", label: "API keys", icon: "keys", group: "Connect", title: "API keys", sub: "One key per tool, with only the access it needs", render: renderKeys },
  { id: "integrations", label: "Integrations", icon: "integrations", group: "Connect", title: "Integrations", sub: "Copy-paste setup for TradingView, Python, Excel, Claude and more", render: renderIntegrations },
  { id: "activity", label: "Activity", icon: "activity", group: "Connect", title: "Activity", sub: "Recent requests and the tamper-evident audit log", render: renderActivity },
];

let timer = null;
let renderSeq = 0;

function nav(active) {
  const out = [];
  let group = null;
  for (const p of PAGES) {
    if (p.group !== group) {
      group = p.group;
      out.push(h("div", { class: "nav-group" }, group));
    }
    out.push(h("a", { href: `#/${p.id}`, "aria-current": p.id === active ? "page" : undefined, "data-page": p.id }, icon(p.icon), h("span", { class: "lbl" }, p.label), p.id === "orders" ? h("span", { class: "count", id: "nav-tickets", hidden: true }) : null));
  }
  $("nav").replaceChildren(...out);
}

/** Re-run `fn` every `ms` while this page is shown and the tab is visible. */
function every(ms, fn) {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) fn().catch(() => {});
  }, ms);
}

async function show() {
  const id = (location.hash.replace(/^#\/?/, "").split("?")[0] || "home").toLowerCase();
  const page = PAGES.find((p) => p.id === id) ?? PAGES[0];
  clearInterval(timer);
  $("toast").hidden = true;
  nav(page.id);
  $("page-title").textContent = page.title;
  $("page-sub").textContent = page.sub;
  $("page-actions").replaceChildren(demoPill() ?? "", h("button", { type: "button", class: "ghost", title: "Refresh", onclick: () => show() }, icon("refresh"), "Refresh"));
  const seq = ++renderSeq;
  const root = $("content");
  root.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  try {
    const nodes = await page.render();
    if (seq !== renderSeq) return;
    root.replaceChildren(...[nodes].flat());
  } catch (err) {
    if (seq !== renderSeq) return;
    root.replaceChildren(alertBox(err));
  }
  refreshTicketCount();
}

async function refreshTicketCount() {
  const r = await optional(api("/v1/tickets"));
  const n = r.data?.data?.length ?? 0;
  const el = $("nav-tickets");
  if (!el) return;
  el.hidden = n === 0;
  el.textContent = String(n);
}

export function startRouter() {
  window.addEventListener("hashchange", show);
  show();
}

// ── Home ──

async function renderHome() {
  const [accounts, keys, usage, safety, streams, orders] = await Promise.all([
    api("/v1/accounts"),
    optional(api("/v1/keys")),
    optional(api("/v1/usage")),
    optional(api("/v1/safety")),
    optional(api("/v1/stream/stats")),
    optional(api("/v1/orders?limit=100")),
  ]);
  const accs = accounts.data.data ?? [];
  const keyRows = keys.data?.data ?? [];
  const nodes = [];

  // Welcome checklist
  if (!local.get(FLAG.hideChecklist)) {
    const state = checklistState({ demo: app.state.demo, accounts: accs, keys: keyRows, copied: local.get(FLAG.copied), tested: local.get(FLAG.tested) });
    const done = state.filter((s) => s.done).length;
    const ITEMS = {
      broker: { title: app.state.demo ? "Demo mode is on: sample data is ready" : "Connect a broker, or try demo mode", text: app.state.demo ? "Everything works with sample prices. When you are ready, restart without --demo and connect your broker." : "Log in to one broker account (npm run bridge -- accounts connect <id>), or restart with npm start -- --demo to try everything first.", go: "accounts", cta: "Accounts" },
      key: { title: "Create a key for each tool", text: "A read-only key for charts and AI, a paper key for scripts. Never share your admin key.", go: "keys", cta: "Create a key" },
      snippet: { title: "Copy a snippet for TradingView, Python, Excel or Claude", text: "Ready-made setup with your Bridge address filled in.", go: "integrations", cta: "Integrations" },
      test: { title: "Make your first call", text: "Fetch a quote or an option chain in the test console and see the rate-limit headers.", go: "console", cta: "Test console" },
    };
    const progress = h("span");
    progress.style.width = `${(done / state.length) * 100}%`;
    nodes.push(
      card({
        cls: "accent-edge",
        title: "Welcome to your Bridge",
        sub: `${done} of ${state.length} done. One local API for all your broker accounts.`,
        actions: h("div", { class: "row" }, h("div", { class: "bar", style: undefined }, progress), h("button", { type: "button", class: "ghost small", onclick: () => { local.set(FLAG.hideChecklist, "1"); show(); } }, "Hide")),
        flush: true,
        body: h(
          "div",
          { class: "checklist" },
          state.map((s) =>
            h("div", { class: `check-item${s.done ? " done" : ""}` }, h("span", { class: "tick" }, icon("check")), h("div", { class: "what" }, h("strong", {}, ITEMS[s.id].title), h("span", {}, ITEMS[s.id].text)), h("button", { type: "button", class: s.done ? "small ghost" : "small primary", onclick: () => (location.hash = `#/${ITEMS[s.id].go}`) }, ITEMS[s.id].cta)),
          ),
        ),
      }),
    );
    const bar = nodes.at(-1).querySelector(".card-head .bar");
    bar.style.width = "120px";
  }

  // Market snapshot
  const marketAccount = accs.find((a) => a.broker !== "paper" && a.session?.state === "connected");
  const snapshot = h("div", { class: "quotes" });
  const fillQuotes = async () => {
    const r = await api("/v1/quotes?symbols=NSE:NIFTY,NSE:BANKNIFTY,BSE:SENSEX");
    snapshot.replaceChildren(
      ...(r.data.data ?? []).map((q) =>
        h("div", { class: "quote" }, h("span", { class: "sym" }, q.symbol.split(":")[1], " · ", q.freshness?.source ?? ""), h("span", { class: "px" }, fmtNum.format(q.ltp)), h("span", { class: q.change >= 0 ? "up small" : "down small" }, `${signed(q.change ?? 0)} (${signed(q.changePct ?? 0)}%)`)),
      ),
    );
  };
  if (marketAccount) {
    await fillQuotes().catch(() => snapshot.replaceChildren(h("div", { class: "quote" }, h("span", { class: "muted" }, "Prices are not available right now."))));
    every(5000, fillQuotes);
  }
  nodes.push(
    card({
      title: "Market snapshot",
      sub: marketAccount ? `From ${marketAccount.label}, through the rate-limit engine` : "Connect a broker to see prices",
      actions: demoPill(),
      flush: true,
      body: marketAccount ? snapshot : emptyState("plug", "No market data yet", "Quotes, charts and paper orders need one connected broker account, or demo mode.", h("button", { type: "button", class: "primary", onclick: () => (location.hash = "#/accounts") }, "Connect a broker")),
    }),
  );

  // Stats
  const connected = accs.filter((a) => a.session?.state === "connected").length;
  const sv = usage.data?.data?.savings ?? {};
  const saved = (sv.servedFromStream ?? 0) + (sv.servedFromCache ?? 0) + (sv.coalesced ?? 0) + (sv.batched ?? 0);
  const ord = orders.data?.data ?? [];
  const sd = streams.data?.data;
  const stat = (label, value, sub) => h("section", { class: "card stat" }, h("span", { class: "label" }, label), h("span", { class: "value" }, value), h("span", { class: "sub" }, sub));
  nodes.push(
    h(
      "div",
      { class: "grid cols-4 stats" },
      stat("Accounts connected", `${connected} / ${accs.length}`, accs.length ? accs.map((a) => a.id).join(", ") : "none configured"),
      stat("Broker calls saved today", fmtInt.format(saved), "stream, cache, coalescing and batching"),
      stat("Live symbols", fmtInt.format(sd?.symbols ?? 0), `${sd?.downstream?.connections ?? 0} client connection(s)`),
      stat("Orders today", fmtInt.format(ord.length), `${ord.filter((o) => o.mode === "paper").length} paper · ${ord.filter((o) => o.mode === "live").length} live`),
    ),
  );

  // Accounts + safety
  const ks = safety.data?.data?.killSwitch;
  nodes.push(
    h(
      "div",
      { class: "grid side" },
      card({
        title: "Broker accounts",
        flush: true,
        actions: h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/accounts") }, "Manage"),
        body: table(
          [
            { label: "Account", cell: (a) => h("div", {}, h("strong", {}, a.label), h("div", { class: "muted small mono" }, a.id)) },
            { label: "Broker", cell: (a) => a.broker },
            { label: "Session", cell: (a) => sessionPill(a.session?.state) },
            { label: "Mode", cell: (a) => (a.liveAllowedByConfig ? pill("live enabled", "bad") : pill("paper", "accent")) },
          ],
          accs,
          emptyState("accounts", "No accounts yet", 'Add one under "accounts" in bridge.config.json, or run npm run bridge -- init.'),
        ),
      }),
      card({
        title: "Safety",
        actions: h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/safety") }, "Open"),
        body: h(
          "div",
          { class: "stack" },
          h("div", { class: "row" }, ks?.engaged ? pill("Kill switch ON", "bad") : pill("Kill switch off", "ok"), safety.data?.data?.liveTrading ? pill("Live trading ON", "bad") : pill("Paper only", "accent")),
          h("p", { class: "muted" }, ks?.engaged ? `Engaged ${istDateTime(ks.at)}: ${ks.reason ?? ""}` : "Orders pass every safety check: order-rate cap, daily limits, price band, market-order protection."),
          h("p", { class: "muted small" }, `Bridge ${app.state.health?.version ?? ""} · up ${Math.round((app.state.health?.uptimeSeconds ?? 0) / 60)} min · listening on this computer only`),
        ),
      }),
    ),
  );
  return nodes;
}

// ── Accounts ──

async function renderAccounts() {
  const [accounts, brokers] = await Promise.all([api("/v1/accounts"), api("/v1/brokers")]);
  const accs = accounts.data.data ?? [];
  const list = brokers.data.data ?? [];
  const testAccount = async (a, btn) => {
    btn.disabled = true;
    try {
      const r = await api(`/v1/accounts/${encodeURIComponent(a.id)}/test`, { method: "POST" });
      toast(r.data?.data?.ok ? `${a.id}: connection OK` : `${a.id}: ${r.data?.data?.message ?? "not OK"}`);
    } catch (err) {
      modal({ title: `Test ${a.id}`, body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    } finally {
      btn.disabled = false;
    }
  };
  const howTo = (a) =>
    modal({
      title: `Log in to ${a.label}`,
      body: h(
        "div",
        { class: "stack" },
        h("p", {}, "With the Bridge running, open a terminal in the api-bridge folder and run the command below. It asks for each field your broker needs; what you type is hidden and goes only to the Bridge on this computer."),
        codeBlock(`npm run bridge -- accounts connect ${a.id} --key <your admin key>`),
        h("p", { class: "muted small" }, "Passwords, PINs and TOTP codes are used once to log in and never stored. Most brokers end the session every morning; run the command again then."),
      ),
      buttons: [{ label: "Done", cls: "primary", value: true }],
    });

  const accountsCard = card({
    title: "Your accounts",
    sub: "From bridge.config.json. Several brokers and several accounts per broker are fine.",
    flush: true,
    body: table(
      [
        { label: "Account", cell: (a) => h("div", {}, h("strong", {}, a.label), h("div", { class: "muted small mono" }, a.id)) },
        { label: "Broker", cell: (a) => (a.broker === "paper" ? "Paper (simulator)" : list.find((b) => b.id === a.broker)?.name ?? a.broker) },
        { label: "Session", cell: (a) => h("div", {}, sessionPill(a.session?.state), a.session?.expiresAt ? h("div", { class: "muted small" }, `until ${istDateTime(a.session.expiresAt)}`) : null) },
        { label: "Mode", cell: (a) => (a.liveAllowedByConfig ? pill("live enabled", "bad") : pill("paper", "accent")) },
        { label: "Can do", wrap: true, cell: (a) => h("div", { class: "chips" }, (a.capabilities ?? []).slice(0, 6).map((c) => h("span", { class: "chip" }, c)), (a.capabilities?.length ?? 0) > 6 ? h("span", { class: "chip" }, `+${a.capabilities.length - 6}`) : null) },
        {
          label: "",
          cell: (a) => {
            if (a.broker === "paper") return h("span", { class: "muted small" }, "simulator");
            const t = h("button", { type: "button", class: "small" }, "Test");
            t.addEventListener("click", () => testAccount(a, t));
            return h("div", { class: "row" }, t, a.session?.state !== "connected" ? h("button", { type: "button", class: "small primary", onclick: () => howTo(a) }, "How to log in") : null);
          },
        },
      ],
      accs,
      emptyState("accounts", "No accounts in your config", 'Run npm run bridge -- init to add a paper account and a broker, or add them under "accounts" in bridge.config.json.'),
    ),
  });

  // Directory
  const search = h("input", { type: "search", placeholder: "Search 41 brokers…", "aria-label": "Search brokers" });
  const grid = h("div", { class: "brokers" });
  const real = list.filter((b) => b.id !== "demo");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = real.filter((b) => !q || b.name.toLowerCase().includes(q) || b.id.includes(q));
    grid.replaceChildren(
      ...rows.map((b) =>
        h(
          "div",
          { class: "broker" },
          h("div", { class: "top" }, h("span", { class: "avatar" }, initials(b.name)), h("div", { class: "names" }, h("div", { class: "nm", title: b.name }, b.name), h("div", { class: "id" }, b.id)), b.verified ? pill("Verified", "ok") : pill("Beta", "warn")),
          h("div", { class: "chips" }, h("span", { class: "chip" }, { apiKeyToken: "API key", oauthRedirect: "OAuth login", requestTokenExchange: "One-time code", sessionLogin: "Session login" }[b.authKind] ?? b.authKind), b.capabilities.includes("feed") ? h("span", { class: "chip" }, "live feed") : null, b.capabilities.includes("historical") ? h("span", { class: "chip" }, "history") : null, b.capabilities.includes("placeOrder") ? h("span", { class: "chip" }, "orders") : null),
        ),
      ),
    );
    if (!rows.length) grid.replaceChildren(h("p", { class: "muted" }, `No broker matches “${search.value}”.`));
  };
  search.addEventListener("input", draw);
  draw();
  const dirCard = card({
    title: "Supported brokers",
    sub: `${real.length} brokers. Dhan is verified with a live account; the others are beta (tested against recorded samples).${app.state.demo ? " Demo mode loads none of them." : ""}`,
    actions: h("div", { style: undefined }, search),
    flush: true,
    body: grid,
  });
  return [accountsCard, dirCard];
}

// ── Test console ──

const ENDPOINTS = [
  { id: "ltp", label: "Last price (LTP)", method: "GET", path: "/v1/ltp", fields: [["symbols", "NSE:NIFTY,NSE:RELIANCE"]] },
  { id: "quotes", label: "Quotes", method: "GET", path: "/v1/quotes", fields: [["symbols", "NSE:NIFTY,NSE:BANKNIFTY,BSE:SENSEX"]] },
  { id: "depth", label: "Market depth", method: "GET", path: "/v1/depth", fields: [["symbol", "NSE:RELIANCE"]] },
  { id: "history", label: "Candles (history)", method: "GET", path: "/v1/history", fields: [["symbol", "NSE:NIFTY"], ["interval", "15m"], ["countback", "20"]] },
  { id: "expiries", label: "Expiries", method: "GET", path: "/v1/expiries", fields: [["underlying", "NIFTY"]] },
  { id: "optionchain", label: "Option chain", method: "GET", path: "/v1/optionchain", fields: [["underlying", "NIFTY"], ["expiry", ""], ["strikes", "5"], ["greeks", "true"]] },
  { id: "search", label: "Find a symbol", method: "GET", path: "/v1/instruments/search", fields: [["q", "banknifty fut"], ["limit", "5"]] },
  { id: "convert", label: "Convert a symbol", method: "GET", path: "/v1/symbols/convert", fields: [["input", "NSE:NIFTY1!"]] },
  { id: "positions", label: "Positions", method: "GET", path: "/v1/positions", fields: [["account", ""]] },
  { id: "funds", label: "Funds", method: "GET", path: "/v1/funds", fields: [["account", ""]] },
  { id: "order", label: "Place a paper order", method: "POST", path: "/v1/orders", body: { account: "", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" } },
];

async function renderConsole() {
  const accounts = (await api("/v1/accounts")).data.data ?? [];
  const paperAcc = accounts.find((a) => a.broker === "paper")?.id ?? accounts[0]?.id ?? "paper";
  const dataAcc = accounts.find((a) => a.broker !== "paper")?.id ?? paperAcc;
  const select = h("select", { "aria-label": "Endpoint" }, ENDPOINTS.map((e) => h("option", { value: e.id }, e.label)));
  const fieldsBox = h("div", { class: "stack" });
  const curlBox = h("div");
  const out = h("div", { class: "response" });
  const runBtn = h("button", { type: "button", class: "primary" }, icon("play"), "Send request");
  let inputs = {};
  const firstExpiry = async () => {
    const r = await optional(api("/v1/expiries?underlying=NIFTY"));
    return r.data?.data?.expiries?.[0] ?? "";
  };

  const build = () => {
    const ep = ENDPOINTS.find((e) => e.id === select.value);
    if (ep.method === "POST") {
      const body = { ...ep.body, account: paperAcc };
      return { ep, url: ep.path, body: JSON.parse(inputs.body?.value || JSON.stringify(body)) };
    }
    const qs = new URLSearchParams();
    for (const [k] of ep.fields) if (inputs[k]?.value) qs.set(k, inputs[k].value.trim());
    return { ep, url: `${ep.path}${qs.size ? `?${qs}` : ""}` };
  };
  const drawCurl = () => {
    let b;
    try {
      b = build();
    } catch {
      return;
    }
    const base = location.origin;
    const cmd = b.ep.method === "POST" ? `curl -X POST "${base}${b.url}" -H "Authorization: Bearer $MCB_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $(node -e "console.log(crypto.randomUUID())")" -d '${JSON.stringify(b.body)}'` : `curl -H "Authorization: Bearer $MCB_API_KEY" "${base}${b.url}"`;
    curlBox.replaceChildren(codeBlock(cmd, { title: "Same call from a terminal", onCopy: markCopied }));
  };
  const drawFields = async () => {
    const ep = ENDPOINTS.find((e) => e.id === select.value);
    inputs = {};
    const rows = [];
    if (ep.method === "POST") {
      const ta = h("textarea", { rows: 9, spellcheck: "false" }, JSON.stringify({ ...ep.body, account: paperAcc }, null, 2));
      ta.addEventListener("input", drawCurl);
      inputs.body = ta;
      rows.push(h("label", { class: "field" }, "Order (JSON)", h("span", { class: "hint" }, "Paper by default. The dashboard adds an Idempotency-Key, so a retry never places it twice."), ta));
    } else {
      for (const [k, def] of ep.fields) {
        let value = def;
        if (k === "expiry") value = await firstExpiry();
        if (k === "account") value = ep.id === "funds" || ep.id === "positions" ? paperAcc : dataAcc;
        const input = h("input", { value, spellcheck: "false" });
        input.addEventListener("input", drawCurl);
        inputs[k] = input;
        rows.push(h("label", { class: "field" }, k, input));
      }
    }
    fieldsBox.replaceChildren(...rows);
    drawCurl();
  };

  const run = async () => {
    let b;
    try {
      b = build();
    } catch {
      out.replaceChildren(alertBox({ title: "The order JSON is not valid", detail: "Check the commas and quotes." }));
      return;
    }
    runBtn.disabled = true;
    try {
      const idem = b.ep.method === "POST" ? `dash-${crypto.randomUUID()}` : null;
      const opts = { method: b.ep.method, raw: true, body: b.body };
      let r;
      if (idem) {
        const res = await fetch(b.url, { method: "POST", headers: { Authorization: `Bearer ${currentKey()}`, "Content-Type": "application/json", "Idempotency-Key": idem, "X-MCB-Client": "dashboard" }, body: JSON.stringify(b.body) });
        const text = await res.text();
        r = { status: res.status, headers: res.headers, text, ms: 0, data: (() => { try { return JSON.parse(text); } catch { return text; } })() };
      } else r = await api(b.url, opts);
      local.set(FLAG.tested, "1");
      const pretty = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
      const pre = h("pre");
      pre.innerHTML = highlightJson(pretty);
      const hdr = (n) => r.headers.get(n);
      const ok = r.status < 400;
      const friendly = !ok && typeof r.data === "object" ? alertBox({ code: r.data.code, status: r.status, message: r.data.detail }) : null;
      out.replaceChildren(
        card({
          title: "Response",
          actions: h("div", { class: "row" }, pill(`${r.status} ${ok ? "OK" : "Error"}`, ok ? "ok" : "bad"), r.ms ? pill(`${r.ms} ms`) : null, hdr("x-mcb-data") === "demo" ? pill("Demo data", "demo") : null),
          flush: true,
          body: h(
            "div",
            {},
            friendly ? h("div", { class: "card-body" }, friendly) : null,
            h("dl", { class: "kv" }, ...["x-request-id", "ratelimit", "ratelimit-policy", "x-mcb-data", "content-type"].flatMap((n) => (hdr(n) ? [h("dt", {}, n), h("dd", {}, hdr(n))] : []))),
            h("div", { class: "code" }, pre, h("button", { type: "button", class: "small copy", onclick: () => copyText(pretty) }, icon("copy"), "Copy")),
          ),
        }),
      );
    } catch (err) {
      out.replaceChildren(alertBox(err));
    } finally {
      runBtn.disabled = false;
    }
  };

  select.addEventListener("change", drawFields);
  runBtn.addEventListener("click", run);
  await drawFields();
  out.replaceChildren(card({ title: "Response", body: emptyState("console", "Send a request to see the answer", "The response shows the status, the rate-limit headers and the JSON exactly as your scripts would get it.") }));
  return h(
    "div",
    { class: "console" },
    h(
      "div",
      { class: "stack" },
      card({
        title: "Request",
        sub: "Uses your dashboard key. Scripts should use their own key.",
        body: h("div", { class: "stack" }, h("label", { class: "field" }, "Endpoint", select), fieldsBox, h("div", { class: "row" }, runBtn)),
      }),
      curlBox,
    ),
    out,
  );
}

// ── Rate limits ──

async function renderLimits() {
  const root = h("div", { class: "stack" });
  const draw = async () => {
    const [usage, limits] = await Promise.all([api("/v1/usage"), api("/v1/limits")]);
    const u = usage.data.data ?? {};
    const lim = limits.data.data ?? {};
    const sv = u.savings ?? {};
    const stat = (label, value, sub) => h("section", { class: "card stat" }, h("span", { class: "label" }, label), h("span", { class: "value" }, fmtInt.format(value ?? 0)), h("span", { class: "sub" }, sub));
    const nodes = [
      h(
        "div",
        { class: "grid cols-4 stats" },
        stat("Served from live stream", sv.servedFromStream, "no broker call at all"),
        stat("Served from cache", sv.servedFromCache, "fresh enough, labelled with its age"),
        stat("Coalesced", sv.coalesced, "identical requests shared one call"),
        stat("Batched", sv.batched, "symbols packed into fewer calls"),
      ),
    ];
    const accounts = (u.accounts ?? []).filter((a) => a.broker !== "paper");
    const tryBtn = h("button", { type: "button", class: "primary" }, icon("bolt"), "Send 20 identical requests");
    tryBtn.addEventListener("click", async () => {
      tryBtn.disabled = true;
      const before = (await api("/v1/usage")).data.data;
      const calls = (x) => (x.accounts ?? []).reduce((n, a) => n + sum(Object.fromEntries(Object.entries(a.classes ?? {}).map(([k, v]) => [k, v.callsToday ?? 0]))), 0);
      await Promise.all(Array.from({ length: 20 }, () => optional(api("/v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE"))));
      const after = (await api("/v1/usage")).data.data;
      tryBtn.disabled = false;
      const used = calls(after) - calls(before);
      toast(`20 requests → ${used} broker call${used === 1 ? "" : "s"}. The rest came from the live stream, the cache or a shared call.`);
      await draw();
    });
    nodes.push(
      card({
        title: "Try it",
        sub: "Twenty tools asking for the same price at once should cost the broker about one call. Watch the counters.",
        body: h("div", { class: "row" }, tryBtn, h("span", { class: "muted small" }, accounts.length ? "Uses /v1/ltp for NIFTY and RELIANCE." : "Needs a connected broker or demo mode.")),
      }),
    );
    if (!accounts.length) nodes.push(card({ title: "Broker budgets", body: emptyState("limits", "No broker account in use yet", "Once a broker account is connected, its live budget per endpoint class shows here.") }));
    for (const a of accounts) {
      const classes = Object.entries(a.classes ?? {});
      nodes.push(
        card({
          title: `${a.accountId} · ${a.broker}`,
          sub: `${a.healthy === false ? "backing off" : "healthy"} · ${a.inFlight ?? 0} in flight · ${a.queued ?? 0} queued`,
          actions: h("div", { class: "row" }, a.healthy === false ? pill("Backing off", "bad") : pill("Healthy", "ok"), demoPill()),
          body: h(
            "div",
            {},
            classes.map(([cls, c]) => meterRow(cls, c.used ?? 0, c.limit ?? 0, `${c.used ?? 0} / ${c.limit ?? "∞"} per ${c.window ?? "s"} · ${fmtInt.format(c.callsToday ?? 0)} today`)),
            h("p", { class: "muted small" }, `Today: ${fmtInt.format(sum(Object.fromEntries(classes.map(([k, c]) => [k, c.callsToday ?? 0]))))} broker calls, ${fmtInt.format(sum(Object.fromEntries(classes.map(([k, c]) => [k, c.throttledToday ?? 0]))))} throttled by the broker, ${fmtInt.format(sum(Object.fromEntries(classes.map(([k, c]) => [k, c.refusedToday ?? 0]))))} refused to stay inside limits.`),
          ),
        }),
      );
    }
    const policies = Object.values(lim.brokers ?? {});
    for (const p of policies) {
      nodes.push(
        card({
          title: `Policy: ${p.brokerId}`,
          sub: p.notes ?? "",
          flush: true,
          body: table(
            [
              { label: "Endpoint class", cell: (r) => h("strong", {}, r[0]) },
              { label: "Per second", num: true, cell: (r) => r[1].perSecond ?? "—" },
              { label: "Per minute", num: true, cell: (r) => r[1].perMinute ?? "—" },
              { label: "Per day", num: true, cell: (r) => (r[1].perDay ? fmtInt.format(r[1].perDay) : "—") },
              { label: "Source", wrap: true, cell: (r) => (String(r[1].source ?? "").includes("demo") ? pill("sample (demo)", "accent") : r[1].verified ? pill("broker docs", "ok") : pill("conservative default", "warn")) },
            ],
            Object.entries(p.limits ?? {}),
            emptyState("limits", "No limits", ""),
          ),
        }),
      );
    }
    root.replaceChildren(...nodes);
  };
  await draw();
  every(2500, draw);
  return root;
}

// ── Orders ──

async function renderOrders() {
  const [tickets, orders, accounts] = await Promise.all([optional(api("/v1/tickets")), optional(api("/v1/orders?limit=100")), api("/v1/accounts")]);
  const accs = accounts.data.data ?? [];
  const byId = new Map(accs.map((a) => [a.id, a]));
  const nodes = [];

  const tk = tickets.data?.data ?? [];
  nodes.push(
    card({
      title: "Pending confirmations",
      sub: "Orders prepared by AI assistants or confirmation-required webhooks wait here. Nothing is sent until you confirm.",
      flush: true,
      body: tickets.error
        ? h("div", { class: "card-body" }, alertBox(tickets.error))
        : table(
            [
              { label: "Ticket", cell: (t) => h("span", { class: "mono" }, t.ticketId) },
              { label: "From", cell: (t) => `${t.source} · ${t.client}` },
              { label: "Order", wrap: true, cell: (t) => `${t.order?.side} ${t.order?.lots ? `${t.order.lots} lot(s)` : t.order?.quantity} ${t.order?.symbol} (${t.order?.mode ?? "paper"})` },
              { label: "Value", num: true, cell: (t) => (t.estimatedValue == null ? "—" : fmtRs.format(t.estimatedValue)) },
              {
                label: "",
                cell: (t) => {
                  const blocked = (t.checks ?? []).some((c) => c?.severity === "block");
                  return h("button", { type: "button", class: t.order?.mode === "live" ? "small danger" : "small primary", disabled: blocked, onclick: () => confirmTicket(t, byId) }, blocked ? "Blocked" : "Review");
                },
              },
            ],
            tk,
            emptyState("inbox", "Nothing waiting", "When an AI assistant prepares an order, it appears here for you to check every field and confirm."),
          ),
    }),
  );

  const ord = orders.data?.data ?? [];
  nodes.push(
    card({
      title: "Today's orders",
      actions: h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/console") }, icon("plus"), "Place a paper order"),
      flush: true,
      body: orders.error
        ? h("div", { class: "card-body" }, alertBox(orders.error))
        : table(
            [
              { label: "Time", cell: (o) => istTime(o.placedAt) },
              { label: "Account", cell: (o) => o.accountId },
              { label: "Symbol", cell: (o) => h("strong", {}, o.symbol) },
              { label: "Side", cell: (o) => h("span", { class: o.side === "BUY" ? "up" : "down" }, o.side) },
              { label: "Qty", num: true, cell: (o) => o.quantity },
              { label: "Avg price", num: true, cell: (o) => (o.avgPrice == null ? "—" : fmtNum.format(o.avgPrice)) },
              { label: "Status", cell: (o) => pill(o.status, o.status === "filled" ? "ok" : o.status === "rejected" ? "bad" : "info") },
              { label: "Mode", cell: (o) => (o.mode === "live" ? pill("live", "bad") : pill("paper", "accent")) },
            ],
            ord,
            emptyState("orders", "No orders today", "Paper orders from the test console, your scripts, webhooks and AI assistants show up here."),
          ),
    }),
  );

  for (const a of accs.filter((x) => x.broker === "paper")) {
    const [pos, funds] = await Promise.all([optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`)), optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`))]);
    const f = funds.data?.data?.funds ?? funds.data?.data ?? {};
    const rows = pos.data?.data ?? [];
    nodes.push(
      card({
        title: `${a.label} (paper)`,
        sub: `Cash ${fmtRs.format(f.availableCash ?? 0)} · used margin ${fmtRs.format(f.usedMargin ?? 0)} · realised ${fmtRs.format(f.realisedPnl ?? 0)} · unrealised ${fmtRs.format(f.unrealisedPnl ?? 0)}`,
        actions: demoPill(),
        flush: true,
        body: table(
          [
            { label: "Symbol", cell: (p) => h("strong", {}, p.symbol) },
            { label: "Product", cell: (p) => p.product },
            { label: "Net qty", num: true, cell: (p) => p.netQty },
            { label: "Avg", num: true, cell: (p) => fmtNum.format(p.avgPrice ?? 0) },
            { label: "LTP", num: true, cell: (p) => (p.ltp == null ? "—" : fmtNum.format(p.ltp)) },
            { label: "P&L", num: true, cell: (p) => h("span", { class: (p.pnl ?? 0) >= 0 ? "up" : "down" }, fmtRs.format(p.pnl ?? 0)) },
          ],
          rows,
          emptyState("orders", "No open paper positions", "Place a paper order to practise with ₹10,00,000 of virtual money."),
        ),
      }),
    );
  }
  return nodes;
}

async function confirmTicket(t, byId) {
  const fields = ticketFields(t, byId);
  const ok = await modal({
    title: `Confirm ticket ${t.ticketId}?`,
    body: h("div", { class: "stack" }, h("p", { class: "muted" }, "The client that prepared it can then send exactly this order, once."), h("dl", { class: "kv" }, ...fields.flatMap(([k, v, cls]) => [h("dt", {}, k), h("dd", { class: cls ? `${cls}-text` : undefined }, v)]))),
    buttons: [{ label: "Cancel", value: false }, { label: t.order?.mode === "live" ? "Confirm LIVE order" : "Confirm", cls: t.order?.mode === "live" ? "danger" : "primary", value: true }],
  });
  if (!ok) return;
  try {
    const r = await api(`/v1/tickets/${encodeURIComponent(t.ticketId)}/confirm`, { method: "POST" });
    const n = confirmCodeNotice(t.ticketId, r.data);
    if (n) await modal({ title: "Confirmed", body: h("div", { class: "stack" }, h("p", {}, n.text), h("div", { class: "secret-box" }, h("code", {}, n.token), h("button", { type: "button", class: "small", onclick: () => copyText(n.token) }, icon("copy"), "Copy"))), buttons: [{ label: "Done", cls: "primary", value: true }] });
  } catch (err) {
    await modal({ title: "Could not confirm", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
  }
  show();
}

// ── Safety ──

async function renderSafety() {
  const s = (await api("/v1/safety")).data.data;
  const ks = s.killSwitch ?? {};
  const engage = async () => {
    const reason = h("input", { value: "Stopped from the dashboard", maxlength: "200" });
    const cancel = h("input", { type: "checkbox" });
    const go = await modal({
      title: "Stop all orders?",
      body: h("div", { class: "stack" }, h("p", {}, "New orders are refused at once, including ones already queued. Cancels still work."), h("label", { class: "field" }, "Reason", reason), h("label", { class: "check" }, cancel, "Also cancel open orders the Bridge placed")),
      buttons: [{ label: "Keep trading", value: false }, { label: "Stop all orders", cls: "danger", value: true }],
    });
    if (!go) return;
    try {
      await api("/v1/safety/kill-switch", { method: "POST", body: { reason: reason.value || "manual", cancelOpenOrders: cancel.checked } });
      toast("Kill switch engaged");
    } catch (err) {
      await modal({ title: "Could not engage", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    }
    show();
  };
  const release = async () => {
    const typed = h("input", { placeholder: "RELEASE", autocomplete: "off" });
    const go = await modal({
      title: "Allow orders again?",
      body: h("div", { class: "stack" }, h("p", {}, "Type RELEASE to confirm. Needs an admin key, from this computer."), typed),
      buttons: [{ label: "Cancel", value: false }, { label: "Release", cls: "primary", onClick: () => (typed.value === "RELEASE" ? true : (toast("Type RELEASE exactly"), false)) }],
    });
    if (!go) return;
    try {
      await api("/v1/safety/kill-switch", { method: "DELETE", body: { confirm: "RELEASE" } });
      toast("Kill switch released");
    } catch (err) {
      await modal({ title: "Could not release", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    }
    show();
  };
  const verify = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api("/v1/audit/verify");
      const d = r.data.data ?? {};
      toast(d.ok ? `Audit chain intact (${d.checked} records)` : `Audit chain broken at ${d.brokenAt}`);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  };
  const verifyBtn = h("button", { type: "button", class: "small" }, "Verify audit log");
  verifyBtn.addEventListener("click", () => verify(verifyBtn));

  const killCard = h(
    "section",
    { class: `card kill${ks.engaged ? " engaged" : ""}` },
    h("div", { class: "kicon" }, icon(ks.engaged ? "stop" : "power")),
    h("div", { class: "stack" }, h("h2", {}, ks.engaged ? "Kill switch is ON: no orders are sent" : "Kill switch is off"), h("p", { class: "muted" }, ks.engaged ? `Engaged ${istDateTime(ks.at)} by ${ks.by ?? "?"}: ${ks.reason ?? ""}` : "One click stops every new order from every tool: REST, webhooks, AI assistants and the CLI. Also: mc-bridge kill.")),
    h("div", { class: "actions" }, ks.engaged ? h("button", { type: "button", class: "primary", onclick: release }, "Release (admin)") : h("button", { type: "button", class: "danger", onclick: engage }, icon("stop"), "Stop all orders")),
  );
  const live = card({
    title: "Live trading",
    actions: s.liveTrading ? pill("ON", "bad") : pill("Off: paper only", "accent"),
    body: h(
      "div",
      { class: "stack" },
      h("p", { class: "muted" }, "A live order needs every one of these. Nothing in the API, a webhook or an AI tool can switch live trading on."),
      h(
        "div",
        { class: "stack small" },
        [
          ["safety.liveTrading is true in bridge.config.json", s.liveTrading],
          ["the account has live.enabled and allows the request's source", (s.accounts ?? []).some((a) => a.liveAllowedByConfig)],
          ["the key has the live scope and the request says mode: live", null],
          ["a person confirmed it, for AI-prepared orders and confirmation webhooks", null],
          ["every safety check passes (rate cap, daily limits, price band)", null],
        ].map(([t, v]) => h("div", { class: "req" }, v === true ? pill("yes", "ok") : v === false ? pill("no", "accent") : pill("per order"), h("span", {}, t))),
      ),
      app.state.demo ? h("p", { class: "small warn-text" }, "Demo mode forces live trading off.") : null,
    ),
  });
  const limits = card({
    title: "Daily limits per account",
    sub: `IST day ${s.day ?? ""}. Paper and live are counted separately.`,
    actions: verifyBtn,
    flush: true,
    body: table(
      [
        { label: "Account", cell: (a) => h("strong", {}, a.accountId) },
        { label: "Orders today", num: true, cell: (a) => `${a.ordersToday + (a.paperOrdersToday ?? 0)} / ${a.limits?.dailyMaxOrders}` },
        { label: "P&L today", num: true, cell: (a) => fmtRs.format((a.realisedPnlToday ?? 0) + (a.paperRealisedPnlToday ?? 0)) },
        { label: "Max loss", num: true, cell: (a) => fmtRs.format(a.limits?.dailyMaxLoss ?? 0) },
        { label: "Max order value", num: true, cell: (a) => fmtRs.format(a.limits?.maxOrderValue ?? 0) },
        { label: "Max lots", num: true, cell: (a) => a.limits?.maxLotsPerOrder },
        { label: "Orders / s", num: true, cell: (a) => a.limits?.orderRatePerSecond },
        { label: "Market orders", cell: (a) => a.limits?.marketOrders ?? "protect" },
      ],
      s.accounts ?? [],
      emptyState("safety", "No accounts", ""),
    ),
  });
  return [killCard, h("div", { class: "grid side" }, limits, live)];
}

// ── Keys ──

async function renderKeys() {
  const [keys, accounts] = await Promise.all([api("/v1/keys"), api("/v1/accounts")]);
  const rows = keys.data.data ?? [];
  const accs = accounts.data.data ?? [];
  const createdBox = h("div");
  const label = h("input", { placeholder: "e.g. TradingView charts", maxlength: "60" });
  const scope = h("select", {}, h("option", { value: "read" }, "Read only: prices, charts, AI"), h("option", { value: "paper" }, "Paper trading: read + paper orders"), h("option", { value: "admin,paper" }, "Admin: manage the Bridge"));
  const acct = h("select", {}, h("option", { value: "*" }, "All accounts"), accs.map((a) => h("option", { value: a.id }, a.id)));
  const client = h("select", {}, ["script", "excel", "tradingview", "mcp", "ui", "other"].map((c) => h("option", { value: c }, { script: "Script (Python, Node)", excel: "Excel / Sheets", tradingview: "Charts / TradingView", mcp: "AI assistant (MCP)", ui: "App / dashboard", other: "Other" }[c])));
  const expires = h("select", {}, h("option", { value: "" }, "Never"), h("option", { value: "7" }, "7 days"), h("option", { value: "30" }, "30 days"), h("option", { value: "90" }, "90 days"));
  const urlUse = h("input", { type: "checkbox" });
  const createBtn = h("button", { type: "button", class: "primary" }, icon("plus"), "Create key");
  createBtn.addEventListener("click", async () => {
    if (!label.value.trim()) return toast("Give the key a name");
    createBtn.disabled = true;
    try {
      const body = { label: label.value.trim(), scopes: scope.value.split(","), accounts: acct.value === "*" ? "*" : [acct.value], clientKind: client.value };
      if (expires.value) body.expiresAt = new Date(Date.now() + Number(expires.value) * 86_400_000).toISOString();
      if (urlUse.checked) body.allowQuery = true;
      const r = await api("/v1/keys", { method: "POST", body });
      const k = r.data.data?.key;
      createdBox.replaceChildren(
        h("div", { class: "secret-box" }, h("strong", {}, "Copy it now, it is shown only once:"), h("code", {}, k), h("button", { type: "button", class: "small primary", onclick: () => copyText(k, "Key copied") }, icon("copy"), "Copy")),
      );
      label.value = "";
      await drawTable();
    } catch (err) {
      createdBox.replaceChildren(alertBox(err));
    } finally {
      createBtn.disabled = false;
    }
  });

  const tableBox = h("div");
  const drawTable = async (list) => {
    const data = list ?? (await api("/v1/keys")).data.data ?? [];
    const status = (k) => (k.revokedAt ? pill("revoked", "bad") : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? pill("expired", "warn") : pill("active", "ok"));
    tableBox.replaceChildren(
      table(
        [
          { label: "Name", cell: (k) => h("div", {}, h("strong", {}, k.label), h("div", { class: "muted small mono" }, k.id)) },
          { label: "Scopes", cell: (k) => h("div", { class: "chips" }, k.scopes.slice().sort().map(scopeChip), k.allowQuery ? h("span", { class: "chip" }, "URL ok") : null) },
          { label: "Accounts", cell: (k) => (k.accounts === "*" ? "all" : k.accounts.join(", ")) },
          { label: "For", cell: (k) => k.clientKind ?? "—" },
          { label: "Last used", cell: (k) => istDateTime(k.lastUsedAt) },
          { label: "Expires", cell: (k) => (k.expiresAt ? istDateTime(k.expiresAt) : "never") },
          { label: "Status", cell: status },
          {
            label: "",
            cell: (k) =>
              k.revokedAt
                ? ""
                : h("button", {
                    type: "button",
                    class: "small ghost",
                    onclick: async () => {
                      const ok = await modal({ title: `Revoke “${k.label}”?`, body: h("p", {}, "It stops working on its very next request, and its open streams close. This cannot be undone."), buttons: [{ label: "Cancel", value: false }, { label: "Revoke", cls: "danger", value: true }] });
                      if (!ok) return;
                      try {
                        await api(`/v1/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
                        toast("Key revoked");
                      } catch (err) {
                        toast(err.message);
                      }
                      drawTable();
                    },
                  }, "Revoke"),
          },
        ],
        data,
        emptyState("keys", "No keys yet", "Create one key per tool so you can revoke one without touching the others."),
      ),
    );
  };
  await drawTable(rows);
  return [
    card({
      title: "Create a key",
      sub: "Least access wins: charts and AI need read, scripts that trade on paper need paper. Live keys are made from the terminal only.",
      body: h(
        "div",
        { class: "stack" },
        h("div", { class: "form-grid" }, h("label", { class: "field" }, "Name", label), h("label", { class: "field" }, "Access", scope), h("label", { class: "field" }, "Accounts", acct), h("label", { class: "field" }, "Used by", client), h("label", { class: "field" }, "Expires", expires)),
        h("div", { class: "row" }, h("label", { class: "check" }, urlUse, "Allow in URLs (?key=), for Excel and chart libraries. Read-only keys only."), h("span", { class: "grow" }), createBtn),
        createdBox,
      ),
    }),
    card({ title: "Your keys", sub: "Only a hash of each key is stored. The key itself was shown once.", flush: true, body: tableBox }),
  ];
}

// ── Integrations ──

const TABS = [
  ["tradingview", "TradingView"],
  ["python", "Python"],
  ["node", "Node"],
  ["excel", "Excel & Sheets"],
  ["amibroker", "AmiBroker"],
  ["claude", "Claude (MCP)"],
  ["chatgpt", "ChatGPT / OpenAI"],
  ["rest", "REST / curl"],
];
const INTRO = {
  tradingview: "Two things: alerts that place paper orders through a webhook, and a chart datafeed (TradingView-compatible UDF).",
  python: "The Python SDK: standard library only, Python 3.9+. Paper orders get an Idempotency-Key automatically.",
  node: "The Node SDK (ESM). Streaming on Node 20 needs ws; Node 22 has a built-in WebSocket.",
  excel: "Live prices in cells with WEBSERVICE. The key goes in the URL, so make a read-only URL key with an expiry.",
  amibroker: "Live values in AFL from the Bridge's cache and stream. History imports use /xl/history with the shipped .format files.",
  claude: "The Bridge is an MCP server. Claude can read prices, chains and your positions; it can only prepare orders for you to confirm.",
  chatgpt: "ChatGPT connectors cannot reach a local server. Use the same tools from your own script with OpenAI function calling.",
  rest: "Every route answers { data, meta } JSON with freshness labels; errors are problem+json with a stable code.",
};
const GUIDES = { tradingview: "webhooks", python: "python", node: "typescript", excel: "excel-sheets", amibroker: "amibroker", claude: "mcp", chatgpt: "chatgpt-openai", rest: "streaming" };

async function renderIntegrations() {
  const accounts = (await api("/v1/accounts")).data.data ?? [];
  const paperAcc = accounts.find((a) => a.broker === "paper")?.id ?? "paper";
  const createdKeys = {};
  const tabsBar = h("div", { class: "tabs", role: "tablist" });
  const panel = h("div", { class: "card-body stack" });
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  let active = TABS.some(([id]) => id === params.get("tab")) ? params.get("tab") : "tradingview";

  const draw = async () => {
    tabsBar.replaceChildren(...TABS.map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(id === active), onclick: () => { active = id; draw(); } }, label)));
    const s = snippets({ base: location.origin, key: createdKeys[active] ?? null, account: paperAcc, symbol: "NSE:NIFTY" })[active];
    const preset = KEY_PRESETS[active];
    const keyBtn = h("button", { type: "button", class: createdKeys[active] ? "small" : "small primary" }, icon("keys"), createdKeys[active] ? "Key created" : `Create a ${preset.scopes.join("+")} key for this`);
    keyBtn.disabled = Boolean(createdKeys[active]);
    keyBtn.addEventListener("click", async () => {
      try {
        const body = { label: preset.label, scopes: preset.scopes, accounts: "*", clientKind: preset.clientKind };
        if (preset.allowQuery) body.allowQuery = true;
        if (preset.expiresDays) body.expiresAt = new Date(Date.now() + preset.expiresDays * 86_400_000).toISOString();
        const r = await api("/v1/keys", { method: "POST", body });
        createdKeys[active] = r.data.data.key;
        toast("Key created and filled in below. Copy it now: it is shown only once.");
        draw();
      } catch (err) {
        toast(err.message);
      }
    });
    const parts = [
      h("div", { class: "row" }, h("p", { class: "grow muted" }, INTRO[active]), keyBtn, h("a", { href: `https://github.com/MrChartist/api-bridge/blob/main/docs/guides/${GUIDES[active]}.md`, target: "_blank", rel: "noopener" }, "Guide ↗")),
      createdKeys[active] ? h("div", { class: "alert info" }, icon("info"), h("div", {}, h("strong", {}, "Your new key is in the snippets below."), h("span", { class: "detail" }, "It is shown only on this page and only until you leave it."))) : null,
    ];
    if (active === "tradingview") parts.push(await webhookPanel(paperAcc));
    for (const sn of s) parts.push(codeBlock(sn.code, { title: sn.title, json: sn.lang === "json", onCopy: markCopied }));
    panel.replaceChildren(...parts.filter(Boolean));
  };
  await draw();
  return card({ title: "Connect your tools", sub: `Your Bridge address: ${location.origin}`, actions: demoPill(), flush: true, body: h("div", {}, tabsBar, panel) });
}

async function webhookPanel(paperAcc) {
  const hooks = await optional(api("/v1/hooks"));
  const list = hooks.data?.data ?? [];
  const box = h("div", { class: "stack" });
  const label = h("input", { value: "NIFTY breakout", maxlength: "60" });
  const orderType = h("select", {}, h("option", { value: "LIMIT" }, "LIMIT (safer)"), h("option", { value: "MARKET" }, "MARKET (protected)"));
  const product = h("select", {}, ["INTRADAY", "MARGIN", "CNC"].map((p) => h("option", { value: p }, p)));
  const lots = h("input", { type: "number", value: "1", min: "1", max: "50" });
  const btn = h("button", { type: "button", class: "primary" }, icon("plus"), "Create webhook");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const r = await api("/v1/hooks", { method: "POST", body: { source: "tradingview", label: label.value.trim() || "TradingView", account: paperAcc, orderType: orderType.value, product: product.value, maxLotsPerSignal: Number(lots.value) || 1 } });
      const d = r.data.data;
      box.replaceChildren(
        h("div", { class: "secret-box" }, h("strong", {}, "Webhook URL (its secret token is shown once):"), h("code", {}, d.url), h("button", { type: "button", class: "small primary", onclick: () => copyText(d.url, "URL copied").then(markCopied) }, icon("copy"), "Copy")),
        ...(d.templates ?? []).slice(0, 1).map((t) => codeBlock(t.message, { title: `${t.name}: paste into the alert's Message box`, json: true, onCopy: markCopied })),
        ...(d.warnings ?? []).map((w) => alertBox({ title: "Note", detail: w }, "warn")),
        h("p", { class: "muted small" }, "TradingView posts only to public HTTPS on port 443, so point a tunnel (for example Cloudflare Tunnel) at the public ingress listener, which serves /hooks only. Paper orders by default."),
      );
    } catch (err) {
      box.replaceChildren(alertBox(err));
    } finally {
      btn.disabled = false;
    }
  });
  return h(
    "div",
    { class: "card", style: undefined },
    h("div", { class: "card-head" }, h("div", {}, h("h3", {}, "Alert webhook"), h("p", {}, `Each hook has its own secret URL and places paper orders on ${paperAcc}.`))),
    h("div", { class: "card-body stack" }, h("div", { class: "form-grid" }, h("label", { class: "field" }, "Name", label), h("label", { class: "field" }, "Order type", orderType), h("label", { class: "field" }, "Product", product), h("label", { class: "field" }, "Max lots per alert", lots), btn), box),
    list.length
      ? table(
          [
            { label: "Hook", cell: (x) => h("div", {}, h("strong", {}, x.label), h("div", { class: "muted small mono" }, x.id)) },
            { label: "Source", cell: (x) => x.source },
            { label: "Account", cell: (x) => x.account },
            { label: "Mode", cell: (x) => (x.mode === "live" ? pill("live", "bad") : pill("paper", "accent")) },
            { label: "Last alert", cell: (x) => istDateTime(x.lastSignalAt) },
            {
              label: "",
              cell: (x) =>
                h("button", {
                  type: "button",
                  class: "small ghost",
                  onclick: async () => {
                    if (!(await modal({ title: `Delete “${x.label}”?`, body: h("p", {}, "Alerts sent to its URL are refused from now on."), buttons: [{ label: "Cancel", value: false }, { label: "Delete", cls: "danger", value: true }] }))) return;
                    await optional(api(`/v1/hooks/${encodeURIComponent(x.id)}`, { method: "DELETE" }));
                    show();
                  },
                }, "Delete"),
            },
          ],
          list,
          null,
        )
      : null,
  );
}

// ── Activity ──

async function renderActivity() {
  const tabsBar = h("div", { class: "tabs", role: "tablist" });
  const body = h("div");
  let active = "requests";
  let showAll = false;
  const hideOwn = h("input", { type: "checkbox" });
  hideOwn.checked = local.get(FLAG.hideOwn) !== "0";
  hideOwn.addEventListener("change", () => {
    local.set(FLAG.hideOwn, hideOwn.checked ? null : "0");
    draw();
  });
  const draw = async () => {
    tabsBar.replaceChildren(
      h("button", { type: "button", role: "tab", "aria-selected": String(active === "requests"), onclick: () => { active = "requests"; draw(); } }, "Requests"),
      h("button", { type: "button", role: "tab", "aria-selected": String(active === "audit"), onclick: () => { active = "audit"; draw(); } }, "Audit log"),
    );
    if (active === "requests") {
      const r = await api("/v1/requests?limit=200");
      const all = (r.data.data ?? []).filter((x) => !hideOwn.checked || x.client !== "dashboard");
      const rows = all.slice(0, showAll ? 200 : 40);
      const more = all.length > rows.length ? h("div", { class: "card-body row" }, h("span", { class: "muted small" }, `Showing the latest ${rows.length} of ${all.length}.`), h("button", { type: "button", class: "small ghost", onclick: () => { showAll = true; draw(); } }, "Show all")) : null;
      body.replaceChildren(
        h("div", { class: "card-body row" }, h("label", { class: "check" }, hideOwn, "Hide the dashboard's own requests"), h("span", { class: "grow" }), h("span", { class: "muted small" }, "Kept in memory only: the last 200 requests. Paths only, never query strings, bodies or keys.")),
        table(
          [
            { label: "Time", cell: (x) => istTime(x.at) },
            { label: "Method", cell: (x) => h("span", { class: `method ${x.method}` }, x.method) },
            { label: "Path", cell: (x) => h("span", { class: "mono" }, x.path) },
            { label: "Status", cell: (x) => pill(String(x.status), x.status < 300 ? "ok" : x.status < 500 ? "warn" : "bad") },
            { label: "Time taken", num: true, cell: (x) => `${x.ms} ms` },
            { label: "Key", cell: (x) => (x.keyId ? h("span", { class: "mono small" }, x.keyId) : h("span", { class: "muted" }, "none")) },
          ],
          rows,
          emptyState("activity", "No requests yet", hideOwn.checked ? "Requests from your scripts, charts, Excel and AI tools appear here. Untick the box to see the dashboard's own." : "Requests appear here as they arrive."),
        ),
        more,
      );
    } else {
      const r = await api("/v1/audit?limit=100");
      const rows = r.data.data ?? [];
      body.replaceChildren(
        h("div", { class: "card-body" }, h("p", { class: "muted small" }, "Append-only and hash-chained, one file per IST day in data/audit/. Secrets are redacted. Verify the chain on the Safety page.")),
        table(
          [
            { label: "#", num: true, cell: (x) => x.seq },
            { label: "When", cell: (x) => istDateTime(x.at) },
            { label: "Event", cell: (x) => h("strong", {}, x.type) },
            { label: "By", cell: (x) => `${x.actor?.kind ?? ""}:${x.actor?.id ?? ""}` },
            { label: "Source", cell: (x) => x.source },
            { label: "Account", cell: (x) => x.accountId ?? "—" },
            { label: "Details", wrap: true, cell: (x) => h("span", { class: "mono small" }, JSON.stringify(x.data ?? {}).slice(0, 140)) },
          ],
          rows,
          emptyState("activity", "The audit log is empty today", "Key changes, orders, kill-switch actions and webhook events are recorded here."),
        ),
      );
    }
  };
  await draw();
  every(4000, draw);
  return card({ flush: true, body: h("div", {}, tabsBar, body) });
}
