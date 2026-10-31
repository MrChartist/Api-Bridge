// Orders › Triggers: GTT, OCO, trailing stops, stops and targets that the Bridge checks every second (server/bridge/
// triggers/). Each fire places its order through every check a normal order meets. Here: the list, Edit and Cancel.
import { alertBox, api, card, emptyState, h, istDateTime, modal, optional, pill, table, toast } from "./app.js";
import { contractName, fieldError } from "./flows.js";
import { DASH, formatFixed, formatInput, formatInt, formatPercent, formatSignedRupee, isFigure } from "./format.js";
import { whatToDo } from "./reasons-core.js";
import { OPEN_TRIGGER, amoWhenText, distancePct, exitChipText, kindPhrase, kindText, legText, outcomeText, pnlAt, statusText, triggerBody, triggerProblem } from "./trigger-core.js";

export { exitChipText };

// ── Open triggers per account, read at most every 3 s (Positions shows each leg's stop and target) ──
const cache = new Map();
/** Open triggers on an account (cached 3 s; a failed read keeps the last list). */
export async function openTriggers(account, { fresh = false } = {}) {
  const c = cache.get(account);
  if (!fresh && c && Date.now() - c.at < 3000) return c.items;
  const r = await optional(api(`/v1/triggers?account=${encodeURIComponent(account)}&status=open`));
  const items = r.error ? (c?.items ?? []) : (r.data?.data ?? []);
  cache.set(account, { at: Date.now(), items });
  return items;
}
/** The cached list (no read): for drawing synchronously. */
export const cachedTriggers = (account) => cache.get(account)?.items ?? [];

/**
 * Stop and target on one position (Positions › leg › Stop and target…): an OCO (or a single stop or target) that
 * exits the position at market when LTP touches it, checked on the Bridge. Reduce-only: it never sends more than is
 * held and cancels itself when the position is closed. A leg that already has one shows it, with Cancel.
 * @param {{ account: string, accountLabel: string, live: boolean, leg: { symbol: string, q: number, lot: number,
 *   avg: number|null, mark: number|null, product: string, tick?: number }, name: string }} o
 */
export async function openPositionExits({ account, accountLabel, live, leg, name }) {
  const long = leg.q > 0;
  const lot = Number(leg.lot) > 0 ? Number(leg.lot) : 1;
  const tick = Number(leg.tick) > 0 ? Number(leg.tick) : 0.05;
  const wholeLots = Math.floor(Math.abs(leg.q) / lot);
  const inLots = lot > 1 && Math.abs(leg.q) % lot === 0;
  const mk = (id, label, extra = {}) => h("input", { id, type: "number", inputmode: "decimal", min: "0", step: String(tick), "aria-label": label, ...extra });
  const qty = h("input", { id: "bk-px-qty", type: "number", inputmode: "numeric", min: "1", step: "1", max: String(inLots ? wholeLots : Math.abs(leg.q)), value: String(inLots ? wholeLots : Math.abs(leg.q)) });
  const ref = isFigure(leg.mark) ? Number(leg.mark) : null;
  // A start: 30 % against for the stop, 50 % for the target, on the premium (the trader edits them).
  const stop = mk("bk-px-stop", "Stop price", { value: ref ? formatInput(Math.max(tick, Math.round((long ? ref * 0.7 : ref * 1.3) / tick) * tick), 2) : "" });
  const target = mk("bk-px-target", "Target price", { value: ref ? formatInput(Math.max(tick, Math.round((long ? ref * 1.5 : ref * 0.5) / tick) * tick), 2) : "" });
  const trail = mk("bk-px-trail", "Trail the stop by, points", { placeholder: "Off" });
  const readout = h("p", { class: "hint bk-px-read", "aria-live": "polite" });
  const err = h("p", { class: "bad-text", role: "alert", hidden: true });
  const units = () => Math.max(1, Math.floor(Number(qty.value) || 1)) * (inLots ? lot : 1);
  const fields = () => ({ account, symbol: leg.symbol, product: leg.product ?? "MARGIN", mode: live ? "live" : "paper", side: long ? "SELL" : "BUY", units: Math.min(units(), Math.abs(leg.q)), origin: "position", stop: isFigure(stop.value) && Number(stop.value) > 0 ? Number(stop.value) : null, target: isFigure(target.value) && Number(target.value) > 0 ? Number(target.value) : null, trail: isFigure(trail.value) && Number(trail.value) > 0 ? Number(trail.value) : null, orderType: "MARKET", ltp: ref });
  const draw = () => {
    const f = fields();
    const bad = triggerProblem(f);
    const signed = long ? f.units : -f.units;
    // A P&L figure never splits its sign from the number.
    const at = (px) => h("span", { class: "bk-nw" }, formatSignedRupee(pnlAt(px, leg.avg, signed), 0));
    readout.classList.toggle("bad-text", Boolean(bad));
    if (bad) return void (readout.textContent = bad.message);
    readout.replaceChildren(
      ...(isFigure(f.stop) ? ["At the stop: ", at(f.stop), ` on these ${inLots ? "lots" : "units"}${f.trail ? ` (the stop then trails ${formatFixed(f.trail, 2)} behind the best price)` : ""}. `] : []),
      ...(isFigure(f.target) ? ["At the target: ", at(f.target), ". "] : []),
      "Exits at market; a gap past the stop can cost more.",
    );
  };
  for (const el of [qty, stop, target, trail]) el.addEventListener("input", draw);
  draw();
  const have = (await openTriggers(account, { fresh: true })).filter((t) => t.symbol === leg.symbol && t.reduceOnly);
  const haveList = have.length
    ? h(
        "div",
        { class: "bk-px-have" },
        h("strong", {}, "Already set on this position"),
        have.map((t) =>
          h(
            "div",
            { class: "bk-px-row" },
            h("span", {}, t.legs.map((l) => legText(l, t.lotSize)).join("; ")),
            h("button", { type: "button", class: "small", onclick: async (e) => { if (await cancelTrigger(t)) e.currentTarget.closest(".bk-px-row")?.remove(); } }, "Cancel"),
          ),
        ),
      )
    : null;
  const ok = await modal({
    title: `Stop and target · ${name}`,
    body: h(
      "div",
      { class: "stack" },
      h("p", { class: "muted" }, `${long ? "Long" : "Short"} ${inLots ? `${formatInt(wholeLots)} lot${wholeLots === 1 ? "" : "s"}` : `${formatInt(Math.abs(leg.q))} qty`} · avg ${isFigure(leg.avg) ? formatFixed(leg.avg, 2) : DASH} · LTP ${ref !== null ? formatFixed(ref, 2) : DASH} · ${accountLabel}${live ? " · LIVE" : ""}`),
      haveList,
      h(
        "div",
        { class: "bk-exits-grid bk-px-grid" },
        h("label", { class: "field", for: "bk-px-qty" }, h("span", {}, inLots ? "Lots" : "Quantity"), qty),
        h("label", { class: "field", for: "bk-px-stop" }, h("span", {}, "Stop"), stop),
        h("label", { class: "field", for: "bk-px-target" }, h("span", {}, "Target"), target),
        h("label", { class: "field", for: "bk-px-trail" }, h("span", {}, "Trail stop by"), trail),
      ),
      readout,
      h("p", { class: "muted small" }, "Checked on this computer every second while the Bridge runs, and sent through every safety check. For a stop held at the exchange, also place an SL order at your broker."),
      err,
    ),
    buttons: [
      { label: "Close", value: false },
      {
        label: live ? "Set stop and target · LIVE" : "Set stop and target",
        cls: "primary",
        onClick: async () => {
          err.hidden = true;
          const f = fields();
          const bad = triggerProblem(f);
          if (bad) return fieldError(bad.field === "target" ? target : bad.field === "qty" ? qty : stop, bad.message);
          try {
            await api("/v1/triggers", { method: "POST", body: triggerBody(f) });
            cache.delete(account);
            return true;
          } catch (e) {
            err.textContent = `Not set: ${e?.message ?? "refused"}`;
            err.hidden = false;
            return false;
          }
        },
      },
    ],
  });
  if (ok) toast(`Stop and target set on ${name}. Orders › Triggers lists it.`);
  return ok;
}

const REFRESH_MS = 2000;
/** With no open trigger nothing moves on its own (a new one comes from this tab's ticket or the API): a slower read. */
const IDLE_REFRESH_MS = 10_000;

/** The legs, one line each, with how far the price is from each. */
function legsCell(t) {
  return h(
    "div",
    { class: "bk-legs" },
    (t.legs ?? []).map((l) => {
      const d = OPEN_TRIGGER.has(t.status) && t.status !== "waiting" ? distancePct(l, t.lastLtp) : null;
      return h("div", { class: "bk-leg", "data-role": l.role }, h("span", {}, legText(l, t.lotSize)), d !== null ? h("span", { class: "muted small" }, ` · ${formatPercent(d, 1)} away`) : null);
    }),
    // An after-market order: when it goes and where it is held (this Bridge must be running at 09:15).
    t.origin === "amo" && OPEN_TRIGGER.has(t.status) ? h("div", { class: "muted small" }, amoWhenText(t)) : null,
  );
}

async function editTrigger(t) {
  const inputs = t.legs.map((l, i) => h("input", { id: `bk-trg-${i}`, type: "number", min: "0.05", step: String(t.tick ?? 0.05), inputmode: "decimal", value: String(l.trigger) }));
  const trails = t.legs.map((l, i) => (l.trail ? h("input", { id: `bk-trail-${i}`, type: "number", min: "0", step: String(t.tick ?? 0.05), inputmode: "decimal", value: String(l.trail.points ?? "") }) : null));
  const err = h("p", { class: "bad-text", role: "alert", hidden: true });
  const label = (l) => (l.role === "stop" ? "Stop trigger" : l.role === "target" ? "Target trigger" : "Trigger price");
  const ok = await modal({
    title: `Edit ${kindText(t)} · ${contractName(t.symbol)}`,
    body: h(
      "div",
      { class: "stack" },
      h("p", { class: "muted" }, `LTP ${isFigure(t.lastLtp) ? formatFixed(t.lastLtp, 2) : DASH}. The order itself stays as set; cancel and set a new one to change it.`),
      h(
        "div",
        { class: "form-grid" },
        t.legs.flatMap((l, i) => [
          h("label", { class: "field", for: `bk-trg-${i}` }, h("span", {}, label(l)), inputs[i], h("span", { class: "hint" }, legText(l, t.lotSize))),
          trails[i] ? h("label", { class: "field", for: `bk-trail-${i}` }, h("span", {}, "Trail by (points)"), trails[i]) : null,
        ]),
      ),
      err,
    ),
    buttons: [
      { label: "Keep as is", value: false },
      {
        label: "Save change",
        cls: "primary",
        onClick: async () => {
          err.hidden = true;
          const legs = t.legs.map((l, i) => ({ trigger: Number(inputs[i].value), ...(trails[i] ? { trail: Number(trails[i].value) > 0 ? { points: Number(trails[i].value) } : null } : {}) }));
          try {
            await api(`/v1/triggers/${encodeURIComponent(t.id)}`, { method: "PATCH", body: { legs } });
            return true;
          } catch (e) {
            const f = (Array.isArray(e?.body?.errors) ? e.body.errors : [])[0];
            const m = /^legs\.(\d+)/.exec(String(f?.path ?? ""));
            if (m && inputs[Number(m[1])]) return fieldError(inputs[Number(m[1])], f.message);
            err.textContent = `Not changed: ${e?.message ?? "refused"}`;
            err.hidden = false;
            return false;
          }
        },
      },
    ],
  });
  return ok;
}

async function cancelTrigger(t) {
  const ok = await modal({
    title: `Cancel this ${kindPhrase(t)}?`,
    body: h("div", { class: "stack" }, h("p", {}, `${contractName(t.symbol)}: ${t.legs.map((l) => legText(l, t.lotSize)).join("; ")}.`), h("p", { class: "muted" }, "Nothing is sent. Positions stay as they are.")),
    buttons: [
      { label: "Keep it", value: false },
      { label: "Cancel trigger", cls: "primary", value: true },
    ],
  });
  if (!ok) return false;
  const r = await optional(api(`/v1/triggers/${encodeURIComponent(t.id)}`, { method: "DELETE" }));
  if (r.error) {
    toast(`Not cancelled: ${r.error.message ?? "refused"}`, { tone: "error" });
    return false;
  }
  toast(`Cancelled the ${kindPhrase(t)} on ${contractName(t.symbol)}`);
  return true;
}

/**
 * The Triggers card: open triggers with Edit and Cancel, and what fired, failed or expired today below them. It
 * refreshes itself every 2 s while it is on screen.
 * @param {Map<string, { label: string }>} byId accounts by id
 */
export function triggersCard(byId) {
  const body = h("div", { class: "bk-trg-body" });
  const count = h("span", { class: "muted small" });
  let showDone = false;
  const doneBtn = h("button", { type: "button", class: "small quiet", "aria-expanded": "false", hidden: true });
  doneBtn.addEventListener("click", () => {
    showDone = !showDone;
    doneBtn.setAttribute("aria-expanded", String(showDone));
    draw(last);
  });
  let last = [];
  let sig = "";
  const node = card({
    glyph: "bolt",
    tint: "orange",
    title: "Triggers",
    sub: "GTT, OCO, stops, targets, trailing stops and after-market orders. The Bridge checks them every second, with the browser closed; each fire goes through every safety check.",
    cls: "bk-triggers",
    actions: h("div", { class: "row" }, count, doneBtn),
    flush: true,
    body,
  });
  const columns = [
    { label: "Set", cell: (t) => istDateTime(t.createdAt) },
    { label: "Contract", wrap: true, cell: (t) => h("div", { class: "order-contract", title: t.symbol }, h("strong", {}, contractName(t.symbol)), h("div", { class: "muted small" }, `${kindText(t)} · ${byId.get(t.account)?.label ?? t.account}`)) },
    { label: "When", wrap: true, cell: legsCell },
    { label: "LTP", num: true, cell: (t) => (isFigure(t.lastLtp) ? formatFixed(t.lastLtp, 2) : DASH) },
    {
      label: "Status",
      wrap: true,
      cell: (t) => {
        const s = statusText(t);
        const why = outcomeText(t);
        // A failed or refused fire: the next step, when there is one (reasons-core.js).
        const fix = t.status === "failed" || t.result?.status === "rejected" || t.result?.code ? whatToDo({ code: t.result?.code ?? null, message: t.result?.message ?? "", mode: t.mode }) : null;
        return h("div", { class: "order-status" }, pill(s.text, s.tone), why ? h("div", { class: "muted small order-why" }, why) : null, fix ? h("div", { class: "small bk-fix" }, fix) : null);
      },
    },
    { label: "Mode", cell: (t) => (t.mode === "live" ? pill("Live", "bad") : pill("Paper")) },
    {
      label: "",
      cell: (t) =>
        ["waiting", "active"].includes(t.status)
          ? h(
              "div",
              { class: "row order-acts" },
              t.origin === "amo" ? null : h("button", { type: "button", class: "small", "aria-label": `Edit trigger on ${contractName(t.symbol)}`, onclick: async () => (await editTrigger(t)) && (toast("Trigger changed"), refresh()) }, "Edit"),
              h("button", { type: "button", class: "small", "aria-label": `Cancel trigger on ${contractName(t.symbol)}`, onclick: async () => (await cancelTrigger(t)) && refresh() }, "Cancel"),
            )
          : "",
    },
  ];
  function draw(items) {
    last = items;
    const open = items.filter((t) => OPEN_TRIGGER.has(t.status));
    const done = items.filter((t) => !OPEN_TRIGGER.has(t.status));
    count.textContent = open.length ? `${open.length} open` : "";
    doneBtn.hidden = !done.length;
    doneBtn.textContent = showDone ? "Hide history" : `History (${done.length})`;
    const rows = showDone ? [...open, ...done] : open;
    const s = JSON.stringify(rows.map((t) => [t.id, t.status, t.lastLtp, t.legs.map((l) => l.trigger), t.result?.code]));
    if (s === sig && body.firstChild) return;
    sig = s;
    body.replaceChildren(
      table(columns, rows, emptyState("bolt", "No open triggers", "Set a GTT from the chain ticket (When: At a price), or a stop and target on a position from Positions.", null, { compact: true })),
    );
  }
  async function refresh() {
    const r = await optional(api("/v1/triggers"));
    if (r.error) return body.replaceChildren(h("div", { class: "card-body" }, alertBox(r.error)));
    draw(r.data?.data ?? []);
  }
  refresh();
  // Every 2 s while a trigger is open (its LTP and distance move), every 10 s otherwise, none while the tab is hidden.
  // Stops once the card has been on screen and is gone (the page changed).
  let seen = false;
  let misses = 0;
  let sinceRead = 0;
  const timer = setInterval(() => {
    if (node.isConnected) {
      seen = true;
      sinceRead += REFRESH_MS;
      if (document.hidden || sinceRead < (last.some((t) => OPEN_TRIGGER.has(t.status)) ? REFRESH_MS : IDLE_REFRESH_MS)) return;
      sinceRead = 0;
      refresh();
    } else if (seen || ++misses > 5) clearInterval(timer);
  }, REFRESH_MS);
  return node;
}
