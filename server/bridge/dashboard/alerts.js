// Position alerts in the dashboard: the toolbar bell (unread count, recent fires, every alert with on / off and
// delete), a toast when an alert fires, and the alert sheet that Positions opens for the whole book, a group or one
// leg. The rules are checked on the Bridge (server/bridge/alerts) with the browser closed; this page only shows them.
// The maths is alert-core.js (pure, shared with the server); numbers become text only through format.js.
import { api, h, icon, modal, optional, sheetPopover, toast } from "./app.js";
import { fieldError } from "./flows.js";
import { formatFixed, formatInt, formatSigned, formatSignedRupee, isFigure } from "./format.js";
import { ALERT_KINDS, BAND_KINDS, DEFAULT_COOLDOWN_MIN, ruleProblems, symbolParts } from "./alert-core.js";
import { workspace } from "./workspace.js";

const POLL_MS = 15_000;
const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const KIND_TEXT = Object.freeze({
  pnl_below: "P&L at or below",
  pnl_above: "P&L at or above",
  spot_above: "Spot at or above",
  spot_below: "Spot at or below",
  delta_outside: "Delta outside (lots)",
  expiry_within: "Expiry within (minutes)",
  premium_multiple: "A leg's price reaches (× average)",
  theta_below: "Theta at or below (₹ a day)",
  vega_outside: "Vega outside (₹ per IV point)",
});
const st = { mounted: false, timer: 0, seen: new Set(), first: true, unread: 0, readAt: null, rules: [], market: [], items: [] };
const num = (v) => (isFigure(v) ? Number(v) : null);

/** Plain words for one condition. Delta is shown in lots when the lot size is known. */
export function conditionText(c, lot = null) {
  const L = num(lot) > 0 ? lot : null;
  switch (c.kind) {
    case "pnl_above":
    case "pnl_below":
      return `${KIND_TEXT[c.kind]} ${formatSignedRupee(c.value, 0)}`;
    case "spot_above":
    case "spot_below":
      return `${KIND_TEXT[c.kind]} ${formatFixed(c.value, 2)}`;
    case "delta_outside":
      return L ? `Delta outside ${formatSigned(c.value / L, 1)} to ${formatSigned(c.value2 / L, 1)} lots` : `Delta outside ${formatSigned(c.value, 0)} to ${formatSigned(c.value2, 0)} units`;
    case "expiry_within":
      return c.value >= 120 ? `Expiry within ${formatFixed(c.value / 60, 1)} h` : `Expiry within ${formatInt(c.value)} min`;
    case "premium_multiple":
      return `A leg at ${formatFixed(c.value, 1)}× its average price`;
    case "theta_below":
      return `Theta at or below ${formatSignedRupee(c.value, 0)} a day`;
    case "vega_outside":
      return `Vega outside ${formatSignedRupee(c.value, 0)} to ${formatSignedRupee(c.value2, 0)} per IV point`;
    default:
      return String(c.kind);
  }
}

const ruleText = (r) => (r.conditions ?? []).map((c) => conditionText(c)).join(r.match === "all" ? " and " : " or ");

// ── Bell ──

function bellButton() {
  const slot = document.getElementById("toolbar-bell");
  if (!slot) return null;
  let btn = slot.querySelector("button");
  if (!btn) {
    btn = h("button", { type: "button", class: "toolbar-bell-btn glass", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: () => openBell(btn) }, icon("bell"), h("span", { class: "bell-count", hidden: true }));
    slot.replaceChildren(btn);
  }
  return btn;
}

function drawBell() {
  const slot = document.getElementById("toolbar-bell");
  const btn = bellButton();
  if (!slot || !btn) return;
  const active = st.rules.filter((r) => r.enabled).length + st.market.filter((r) => r.enabled !== false).length;
  // Shown once there is something to show: an alert, or a fire not yet read.
  slot.hidden = !st.rules.length && !st.market.length && !st.unread;
  const count = btn.querySelector(".bell-count");
  count.hidden = !st.unread;
  count.textContent = st.unread > 9 ? "9+" : formatInt(st.unread);
  btn.setAttribute("aria-label", `Alerts: ${formatInt(active)} on${st.unread ? `, ${formatInt(st.unread)} unread` : ""}`);
  btn.title = st.unread ? `${formatInt(st.unread)} alert${st.unread === 1 ? "" : "s"} fired` : `${formatInt(active)} alert${active === 1 ? "" : "s"} on`;
}

async function refresh() {
  const [inbox, rules, market] = await Promise.all([optional(api("/v1/alerts/inbox")), optional(api("/v1/alerts")), optional(api("/v1/alerts/market"))]);
  if (rules.data) st.rules = rules.data.data?.items ?? [];
  if (market.data) st.market = Array.isArray(market.data.data) ? market.data.data : market.data.data?.items ?? [];
  const d = inbox.data?.data;
  if (d) {
    st.unread = Number(d.unread) || 0;
    st.readAt = d.readAt ?? null;
    st.items = d.items ?? [];
    // A fire this page has not seen yet: say it once (not on the first load, which only catches up).
    const fresh = st.items.filter((f) => !st.seen.has(f.id));
    for (const f of st.items) st.seen.add(f.id);
    if (!st.first && fresh.length) {
      const f = fresh[0];
      toast(h("span", { class: "toast-undo-row" }, `Alert: ${f.name} · `, h("button", { type: "button", class: "toast-undo", onclick: () => openBell(bellButton()) }, fresh.length > 1 ? `${formatInt(fresh.length)} new` : "Open")), { tone: "warn" });
    }
    st.first = false;
  }
  drawBell();
}

/** Mount the bell once after sign-in; poll while the tab is visible. */
export function mountAlertBell() {
  if (st.mounted || typeof document === "undefined" || !document.getElementById("toolbar-bell")) return;
  st.mounted = true;
  const tick = () => {
    clearTimeout(st.timer);
    if (document.visibilityState === "visible") refresh().catch(() => {});
    st.timer = setTimeout(tick, POLL_MS);
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && tick());
  tick();
}

/** After a change on any page: fetch again so the bell and lists agree. */
export const alertsChanged = () => refresh().catch(() => {});
/** The rules as last fetched (Positions counts the ones on its underlying). */
export const alertRules = () => st.rules;

function openBell(trigger) {
  if (!trigger) return;
  trigger.setAttribute("aria-expanded", "true");
  const fireRow = (f) =>
    h(
      "li",
      { class: `al-fire${!st.readAt || Date.parse(f.at) > Date.parse(st.readAt) ? " unread" : ""}` },
      h("strong", {}, f.name),
      h("span", {}, f.text),
      h("time", { datetime: f.at }, WHEN.format(new Date(f.at)).replace(",", "")),
    );
  const list = h("ul", { class: "al-fires" }, st.items.length ? st.items.slice(0, 20).map(fireRow) : h("li", { class: "muted" }, "Nothing has fired yet."));
  const rules = h("div", { class: "al-rules" });
  const drawRules = () =>
    rules.replaceChildren(
      ...(st.rules.length
        ? st.rules.map((r) => {
            const sw = h("input", { type: "checkbox", role: "switch", checked: r.enabled, "aria-label": `${r.name}: ${r.enabled ? "on" : "off"}` });
            sw.addEventListener("change", async () => {
              const res = await optional(api(`/v1/alerts/${encodeURIComponent(r.id)}`, { method: "PUT", body: { enabled: sw.checked } }));
              if (res.error) return toast(res.error.message ?? "Could not change the alert.", { tone: "error" }), (sw.checked = !sw.checked);
              await refresh();
              drawRules();
            });
            const del = h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Delete ${r.name}`, title: "Delete" }, icon("close"));
            del.addEventListener("click", async () => {
              const res = await optional(api(`/v1/alerts/${encodeURIComponent(r.id)}`, { method: "DELETE" }));
              if (res.error) return toast(res.error.message ?? "Could not delete the alert.", { tone: "error" });
              toast(`Deleted: ${r.name}`);
              await refresh();
              drawRules();
            });
            return h("div", { class: `al-rule${r.enabled ? "" : " off"}` }, h("label", { class: "al-sw" }, sw), h("div", { class: "al-rule-t" }, h("strong", {}, r.name), h("small", {}, `${r.underlying} · ${ruleText(r)}${r.blind ? " · waiting for data" : ""}`)), del);
          })
        : [h("p", { class: "muted" }, "No alerts yet. Add one from Positions: Alert on the book, a group or a leg.")]),
    );
  drawRules();
  // Market alerts (PR 17's alert rules: PCR, IV, OI at a strike, basis, flow …), checked by the same Bridge engine.
  const market = h("div", { class: "al-rules" });
  const drawMarket = async () => {
    const M = await import("./analyticsMore.js");
    market.replaceChildren(
      ...(st.market.length
        ? st.market.map((r) => {
            const del = h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Delete ${r.name}`, title: "Delete" }, icon("close"));
            del.addEventListener("click", async () => {
              const res = await optional(api(`/v1/alerts/market/${encodeURIComponent(r.id)}`, { method: "DELETE" }));
              if (res.error) return toast(res.error.message ?? "Could not delete the alert.", { tone: "error" });
              toast(`Deleted: ${r.name}`);
              await refresh();
              drawMarket();
            });
            const state = M.ruleState(r);
            return h("div", { class: `al-rule al-mrule${r.enabled === false ? " off" : ""}` }, h("div", { class: "al-rule-t" }, h("strong", {}, r.name), h("small", {}, `${M.describeRule(r).replace(/^Tell me when /, "").replace(/\.$/, "")} · ${state.text}`)), del);
          })
        : [h("p", { class: "muted" }, "None yet: watch PCR, IV, OI at a strike, basis or flow on an underlying.")]),
    );
  };
  drawMarket();
  const newMarket = h("button", { type: "button", class: "small" }, icon("plus"), "New market alert");
  newMarket.addEventListener("click", () => {
    newMarket.closest("dialog")?.close?.(); // the bell sheet makes way for the form
    openMarketAlertSheet();
  });
  const markBtn = h("button", { type: "button", class: "small", disabled: !st.unread }, "Mark all read");
  markBtn.addEventListener("click", async () => {
    await optional(api("/v1/alerts/inbox/read", { method: "POST" }));
    await refresh();
    markBtn.disabled = true;
    for (const li of list.querySelectorAll(".unread")) li.classList.remove("unread");
  });
  sheetPopover({
    trigger,
    title: "Alerts",
    cls: "al-pop",
    head: [markBtn],
    body: h("div", { class: "al-body" }, h("h3", { class: "al-h" }, "Fired"), list, h("h3", { class: "al-h" }, "Your alerts"), rules, h("h3", { class: "al-h" }, "Market alerts"), market, newMarket, h("p", { class: "al-note" }, "Alerts are checked on the Bridge every 15 s, even with this page closed. They only notify: no order is placed.")),
    onClose: () => trigger.setAttribute("aria-expanded", "false"),
  });
}

// ── The alert sheet ──

/**
 * Create an alert on an account's legs.
 * @param {{ account: string, accountLabel?: string, underlying: string, symbols?: string[]|null, scopeText: string,
 *   lot?: number|null, spot?: number|null, pnl?: number|null, delta?: number|null, preset?: string }} o
 */
export async function openAlertSheet(o) {
  const lot = num(o.lot) > 0 ? Number(o.lot) : null;
  const spot = num(o.spot);
  const rows = h("div", { class: "al-conds" });
  const conds = [];
  const suggest = (kind) => {
    switch (kind) {
      case "pnl_below":
        return { value: -Math.max(1000, Math.round(Math.abs(num(o.pnl) ?? 5000) / 1000) * 1000 || 5000) };
      case "pnl_above":
        return { value: Math.max(1000, Math.round(((num(o.pnl) ?? 0) + 5000) / 1000) * 1000) };
      case "spot_above":
        return { value: spot ? Math.round((spot * 1.01) / 50) * 50 : "" };
      case "spot_below":
        return { value: spot ? Math.round((spot * 0.99) / 50) * 50 : "" };
      case "delta_outside":
        return { value: -2, value2: 2 };
      case "expiry_within":
        return { value: 60 };
      case "premium_multiple":
        return { value: 2 };
      case "theta_below":
        return { value: -5000 };
      case "vega_outside":
        return { value: -5000, value2: 5000 };
      default:
        return { value: "" };
    }
  };
  const addRow = (kind = "pnl_below", init = suggest(kind)) => {
    if (conds.length >= 5) return;
    const sel = h("select", { "aria-label": "Condition" }, ALERT_KINDS.map((k) => h("option", { value: k, selected: k === kind }, KIND_TEXT[k])));
    const v1 = h("input", { type: "number", inputmode: "decimal", step: "any", value: String(init.value ?? ""), "aria-label": "Value" });
    const band = (k) => BAND_KINDS.includes(k);
    const v2 = h("input", { type: "number", inputmode: "decimal", step: "any", value: String(init.value2 ?? ""), "aria-label": "Upper value", hidden: !band(kind) });
    const to = h("span", { class: "muted", hidden: !band(kind) }, "to");
    const del = h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Remove this condition" }, icon("close"));
    const now = h("small", { class: "al-now" });
    const row = h("div", { class: "al-cond" }, sel, v1, to, v2, del, now);
    const item = { sel, v1, v2, row };
    const hint = () => {
      const k = sel.value;
      const t = {
        pnl_below: isFigure(o.pnl) ? `Now ${formatSignedRupee(o.pnl, 0)}` : "",
        pnl_above: isFigure(o.pnl) ? `Now ${formatSignedRupee(o.pnl, 0)}` : "",
        spot_above: spot ? `Spot now ${formatFixed(spot, 2)}` : "",
        spot_below: spot ? `Spot now ${formatFixed(spot, 2)}` : "",
        delta_outside: isFigure(o.delta) && lot ? `Delta now ${formatSigned(o.delta / lot, 2)} lots` : lot ? "" : "No lot size: units",
        expiry_within: "Before 15:30 IST on the nearest expiry",
        premium_multiple: "2 = the premium doubled (a short's stop, a long's target)",
        theta_below: "Rupees a calendar day; a long option book's theta is below 0",
        vega_outside: "Rupees the book gains or loses for a 1 point rise in IV",
      }[k];
      now.textContent = t ?? "";
    };
    sel.addEventListener("change", () => {
      const s = suggest(sel.value);
      v1.value = String(s.value ?? "");
      v2.value = String(s.value2 ?? "");
      v2.hidden = to.hidden = !band(sel.value);
      hint();
    });
    del.addEventListener("click", () => {
      if (conds.length === 1) return;
      conds.splice(conds.indexOf(item), 1);
      row.remove();
      addBtn.disabled = false;
    });
    hint();
    conds.push(item);
    rows.append(row);
    addBtn.disabled = conds.length >= 5;
  };
  const addBtn = h("button", { type: "button", class: "small" }, icon("plus"), "Add a condition");
  addBtn.addEventListener("click", () => addRow(conds.length === 1 ? "spot_below" : "premium_multiple"));
  addRow(o.preset ?? "pnl_below");
  const name = h("input", { type: "text", maxlength: "80", placeholder: `${o.underlying} ${o.scopeText}`, "aria-label": "Name" });
  const match = h("select", { "aria-label": "Fire when" }, h("option", { value: "any" }, "Any condition is true"), h("option", { value: "all" }, "Every condition is true"));
  const repeat = h("select", { "aria-label": "Repeat" }, h("option", { value: "once" }, "Once, then switch off"), h("option", { value: "every" }, `Each time, at most every ${DEFAULT_COOLDOWN_MIN} min`));
  const notify = h("input", { type: "checkbox" });
  const err = h("p", { class: "field-msg", role: "alert" });
  const body = h(
    "div",
    { class: "stack al-form" },
    h("p", { class: "muted" }, `${o.accountLabel ?? o.account} · ${o.underlying} · ${o.scopeText}`),
    h("label", { class: "field" }, "Name", name),
    h("div", { class: "field" }, h("span", {}, "Conditions"), rows, addBtn),
    h("div", { class: "row al-opts" }, h("label", { class: "field" }, "Fire when", match), h("label", { class: "field" }, "Repeat", repeat)),
    h("label", { class: "check" }, notify, h("span", {}, "Also send to my notification channels (Telegram, Discord, Slack, webhook), for targets that listen to option.alert")),
    h("p", { class: "al-note" }, "Checked on the Bridge every 15 s, with this page closed too. Alerts only notify: nothing is bought or sold."),
    err,
  );
  await modal({
    title: "New alert",
    body,
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Create alert",
        cls: "primary",
        onClick: async () => {
          const conditions = conds.map(({ sel, v1, v2 }) => {
            const k = sel.value;
            const toUnits = (v) => (k === "delta_outside" && lot ? Number(v) * lot : Number(v));
            return { kind: k, value: toUnits(v1.value), ...(BAND_KINDS.includes(k) ? { value2: toUnits(v2.value) } : {}) };
          });
          const rule = { name: name.value.trim() || undefined, account: o.account, underlying: o.underlying, symbols: o.symbols ?? null, conditions, match: match.value, repeat: repeat.value, cooldownMin: DEFAULT_COOLDOWN_MIN, notify: notify.checked };
          const bad = conds.find(({ v1, v2, sel }) => v1.value === "" || (BAND_KINDS.includes(sel.value) && v2.value === ""));
          if (bad) return fieldError(bad.v1.value === "" ? bad.v1 : bad.v2, "Give a number."), false;
          const problems = ruleProblems(rule);
          if (problems.length) return (err.textContent = problems.join(" ")), false;
          const res = await optional(api("/v1/alerts", { method: "POST", body: rule }));
          if (res.error) return (err.textContent = res.error.message ?? "Could not create the alert."), false;
          toast(`Alert on: ${res.data?.data?.name ?? rule.name ?? o.underlying}`);
          alertsChanged();
          return true;
        },
      },
    ],
  });
}

/**
 * Create a market alert (POST /v1/alerts/market, the Bridge's alert-rule engine): one metric on an underlying, checked
 * every few minutes in market hours. Alerts only notify: nothing is bought or sold.
 */
export async function openMarketAlertSheet() {
  const M = await import("./analyticsMore.js");
  const sel = (label, opts, value) => {
    const el = h("select", { "aria-label": label }, opts.map(([v, t]) => h("option", { value: v }, t)));
    if (value !== undefined) el.value = value;
    return el;
  };
  const metric = sel("Watch", M.RULE_METRICS.map((m) => [m.id, m.label]), "atm_iv");
  const underlying = h("input", { type: "text", value: workspace.state.underlying || "NIFTY", autocapitalize: "characters", spellcheck: "false", "aria-label": "Underlying" });
  const expiry = h("select", { "aria-label": "Expiry" });
  const strike = h("input", { type: "number", inputmode: "decimal", step: "any", "aria-label": "Strike" });
  const right = sel("Side", [["CE", "Call (CE)"], ["PE", "Put (PE)"]]);
  const op = sel("When it", [["above", "Rises above"], ["below", "Falls below"]]);
  const cross = sel("Crossing", [["either", "Either way"], ["above", "Upward"], ["below", "Downward"]]);
  const to = h("select", { "aria-label": "Changes to" });
  const value = h("input", { type: "number", inputmode: "decimal", step: "any", "aria-label": "Value" });
  const every = h("input", { type: "number", inputmode: "numeric", min: "1", max: "1440", step: "1", value: "5", "aria-label": "Check every (minutes)" });
  const hint = h("p", { class: "muted small" });
  const err = h("p", { class: "field-msg", role: "alert" });
  const f = (label, el) => h("label", { class: "field" }, label, el);
  const fExpiry = f("Expiry", expiry);
  const fStrike = h("div", { class: "row al-opts" }, f("Strike", strike), f("Side", right));
  const fOp = f("When it", op);
  const fCross = f("Crossing", cross);
  const fTo = f("Changes to", to);
  const fValue = f("Value", value);
  const loadExpiries = async () => {
    const r = await optional(api(`/v1/expiries?underlying=${encodeURIComponent(underlying.value.trim().toUpperCase())}`));
    const list = (r.data?.data?.expiries ?? []).slice(0, 8);
    expiry.replaceChildren(...list.map((e) => h("option", { value: e }, e)));
    if (list.includes(workspace.state.expiry)) expiry.value = workspace.state.expiry;
  };
  const sync = () => {
    const m = M.metricInfo(metric.value);
    fExpiry.hidden = Boolean(m.noExpiry);
    fStrike.hidden = !m.perStrike;
    fOp.hidden = m.kind !== "threshold";
    fCross.hidden = m.kind !== "cross";
    fTo.hidden = m.kind !== "regime";
    fValue.hidden = m.kind === "regime";
    to.replaceChildren(h("option", { value: "" }, "Any change"), ...(m.to ?? ["positive", "negative", "neutral"]).map((x) => h("option", { value: x }, x[0].toUpperCase() + x.slice(1))));
    value.placeholder = m.example ?? "";
    hint.textContent = m.hint ?? "";
  };
  metric.addEventListener("change", sync);
  underlying.addEventListener("change", loadExpiries);
  sync();
  await loadExpiries();
  const body = h("div", { class: "stack al-form" }, f("Watch", metric), hint, h("div", { class: "row al-opts" }, f("Underlying", underlying), fExpiry), fStrike, h("div", { class: "row al-opts" }, fOp, fCross, fTo, fValue), f("Check every (minutes, market hours)", every), h("p", { class: "al-note" }, "Checked on the Bridge, with this page closed too. Alerts only notify: nothing is bought or sold."), err);
  await modal({
    title: "New market alert",
    body,
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Create alert",
        cls: "primary",
        onClick: async () => {
          const m = M.metricInfo(metric.value);
          const r = M.ruleBody({ name: "", underlying: underlying.value, expiry: expiry.value, metric: m.id, op: m.kind === "cross" ? cross.value : op.value, value: value.value, to: to.value, every: every.value, marketHoursOnly: true, strike: strike.value, right: right.value });
          if (!r.ok) return (err.textContent = r.errors.join(" ")), false;
          const res = await optional(api("/v1/alerts/market", { method: "POST", body: r.body }));
          if (res.error) return (err.textContent = res.error.message ?? "Could not create the alert."), false;
          toast(`Alert on: ${res.data?.data?.name ?? r.body.name}`);
          alertsChanged();
          return true;
        },
      },
    ],
  });
}

/** Rules on this account and underlying (Positions' header count). */
export function rulesFor(account, underlying) {
  return st.rules.filter((r) => r.account === account && r.underlying === underlying);
}

/** Leg label for a symbol, for the sheet's scope line. */
export function legWords(symbol) {
  const x = symbolParts(symbol);
  if (!x) return symbol;
  return x.kind === "OPT" ? `${formatInt(x.strike)} ${x.right}` : x.kind === "FUT" ? "future" : x.underlying;
}

