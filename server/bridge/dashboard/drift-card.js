// The "Order book" card on the Safety page: does the broker's order book match the Bridge's record of live orders?
//
// It reads GET /v1/orders/drift (read scope). That route makes no broker call: it reports what the periodic, read-only
// check found. The card has no button that changes or cancels anything; a difference is for the person to look at in
// the broker app.
//
// driftModel and kindWord are pure and exported for drift-card.test.mjs; the DOM code runs only in a browser.
import { alertBox, api, h, icon, iconTile, pill } from "./app.js";
import { plural } from "./format.js";

/** What each kind of difference is called. Pure. */
export function kindWord(kind) {
  return (
    {
      closed_at_broker: "Finished at the broker",
      missing_at_broker: "Not at the broker",
      status_mismatch: "Different state",
      quantity_mismatch: "Different quantity",
      fill_mismatch: "Different fill",
      unknown_at_broker: "Not placed by the Bridge",
      outcome_unknown: "Unknown outcome",
    }[kind] ?? String(kind ?? "").replaceAll("_", " ")
  );
}

/** "10:42" from an IST ISO string, or "". Pure. */
export const clockOf = (iso) => (typeof iso === "string" && /T\d{2}:\d{2}/.test(iso) ? iso.slice(11, 16) : "");

/**
 * What the card shows, from GET /v1/orders/drift's `data`. Pure.
 * @returns {{ tone: "ok" | "warn" | "bad" | "", word: string, headline: string, detail: string, rows: Array<{ title: string, kind: string, sub: string, extra: string[] }>, note: string }}
 */
export function driftModel(d) {
  const state = d?.state ?? "off";
  const checked = clockOf(d?.checkedAt);
  const next = clockOf(d?.nextCheckAt);
  const tone = { ok: "ok", drift: "bad", unavailable: "warn", waiting: "", idle: "", off: "" }[state] ?? "";
  const word = { ok: "Matches", drift: "Differs", unavailable: "Cannot read", waiting: "Waiting", idle: "Not checking now", off: "Off" }[state] ?? "Unknown";
  const bits = [];
  if (checked) bits.push(`Checked ${checked} IST`);
  if (next && state !== "idle") bits.push(`next about ${next}`);
  if (d?.intervalMinutes && state !== "off") bits.push(`every ${plural(d.intervalMinutes, "minute")} while the market is open`);
  const rows = (Array.isArray(d?.differences) ? d.differences : []).map((x) => ({
    title: [x.side, x.symbol].filter(Boolean).join(" ") || (x.orderId ?? x.brokerOrderId ?? "An order"),
    kind: kindWord(x.kind),
    sub: String(x.message ?? ""),
    extra: (Array.isArray(x.brokerMatches) ? x.brokerMatches : []).map((m) => `Broker order ${m.brokerOrderId}${m.status ? `, ${String(m.status).replaceAll("_", " ")}` : ""}${Number.isFinite(m.quantity) ? `, quantity ${m.quantity}` : ""}`),
  }));
  return {
    tone,
    word,
    headline: String(d?.summary ?? ""),
    detail: bits.join(" · "),
    rows,
    note: String(d?.note ?? "The Bridge only compares and reports. It never changes or cancels an order because of a difference."),
  };
}

/** The Safety page's "Order book" section. */
export function driftSection() {
  const body = h("div", { class: "dr-body" }, h("p", { class: "sf-working", role: "status" }, "Reading the order-book check..."));
  const section = h(
    "section",
    { class: "sec dr", "aria-labelledby": "dr-h" },
    h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", { id: "dr-h" }, "Order book"), h("p", {}, "Does your broker's order book match the live orders the Bridge sent? A read-only check; nothing is changed."))),
    body,
  );

  const draw = (d) => {
    const m = driftModel(d);
    const refresh = h("button", { type: "button", class: "small", id: "dr-refresh" }, icon("refresh"), "Refresh");
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      refresh.setAttribute("aria-busy", "true");
      await load();
    });
    const statusRow = h(
      "div",
      { class: "list-row static dr-row" },
      iconTile(m.tone === "bad" ? "warn" : "safety", m.tone === "ok" ? "green" : m.tone === "bad" ? "red" : m.tone === "warn" ? "orange" : "gray", "md"),
      h("span", { class: "names" }, h("span", { class: "nm" }, m.headline), m.detail ? h("span", { class: "sub" }, m.detail) : null),
      pill(m.word, m.tone),
      refresh,
    );
    const list = m.rows.length
      ? h(
          "div",
          { class: "list dr-list" },
          m.rows.map((r) =>
            h(
              "div",
              { class: "list-row static dr-row" },
              h("span", { class: "names" }, h("span", { class: "nm" }, r.title), h("span", { class: "sub dr-wrap" }, r.sub), ...r.extra.map((x) => h("span", { class: "sub dr-wrap" }, x))),
              pill(r.kind, "warn"),
            ),
          ),
        )
      : null;
    body.replaceChildren(...[h("div", { class: "list" }, statusRow), list, h("p", { class: "dr-note" }, m.note)].filter(Boolean));
  };

  const load = async () => {
    try {
      draw((await api("/v1/orders/drift", { fresh: true })).data.data);
    } catch (err) {
      body.replaceChildren(alertBox(err));
    }
  };
  load();
  // The route reads what the check already found, so refreshing now and then is free. Stop once the page is gone.
  const timer = setInterval(() => {
    if (!section.isConnected) return clearInterval(timer);
    load();
  }, 60_000);
  return section;
}
