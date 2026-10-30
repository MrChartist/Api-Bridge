// Home as a trader's cockpit: the indices strip, your P&L today, open positions with their risk, the latest live
// events, today's market calendar, and API and broker health. One compact grid that adds columns on wide screens
// (3 at 1440 px, 4 at 1920 px, 5 at 2560 px) using the density tokens. Every figure becomes text through format.js;
// the grouping maths is alert-core.js (pure, tested). Reads only: nothing here places an order.
import { api, app, card, emptyState, h, loadingState, optional, pill } from "./app.js";
import { DASH, formatCompact, formatFixed, formatGrouped, formatInt, formatPercent, formatSigned, formatSignedRupee, formatRupee, isFigure } from "./format.js";
import { bookGroups } from "./alert-core.js";
import { contractName, orderStatusText, sessionText, startupText } from "./flows.js";

const INDICES = ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:FINNIFTY", "NSE:MIDCPNIFTY", "BSE:SENSEX", "NSE:INDIAVIX"];
const NAMES = { NIFTY: "NIFTY 50", BANKNIFTY: "BANK NIFTY", FINNIFTY: "FIN NIFTY", MIDCPNIFTY: "MIDCAP SELECT", SENSEX: "SENSEX", INDIAVIX: "INDIA VIX" };
const TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const num = (v) => (isFigure(v) ? Number(v) : null);
const tone = (v) => (num(v) === null || v === 0 ? "" : v > 0 ? "up" : "down");
const signed = (v, cls = "") => h("span", { class: `${tone(v)} ${cls}`.trim() }, num(v) === null ? DASH : formatSignedRupee(v, 0));
const dayText = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? "") ? DAY.format(new Date(`${iso}T00:00:00Z`)) : iso ?? "");
const daysFrom = (iso, today) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
const istToday = (ms) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** The indices strip: one tile per index, refreshed in place. */
function indicesStrip() {
  const tiles = new Map();
  const el = h("section", { class: "ck-strip", "aria-label": "Indices" });
  for (const s of INDICES) {
    const name = s.split(":")[1];
    const px = h("span", { class: "ck-px" }, DASH);
    const ch = h("span", { class: "ck-ch" }, "");
    const t = h("a", { class: "ck-idx", href: name === "INDIAVIX" ? "#/vol" : "#/chain", title: name === "INDIAVIX" ? "Volatility" : `${NAMES[name]}: open the option chain` }, h("span", { class: "ck-name" }, NAMES[name] ?? name), px, ch);
    tiles.set(s, { t, px, ch });
    el.append(t);
  }
  const fill = async () => {
    const r = await optional(api(`/v1/quotes?symbols=${INDICES.join(",")}`));
    const rows = r.data?.data ?? [];
    for (const q of rows) {
      const x = tiles.get(q.symbol);
      if (!x) continue;
      x.px.textContent = formatGrouped(q.ltp, 2);
      x.ch.textContent = isFigure(q.changePct) ? `${formatSigned(q.change, 2)} (${formatSigned(q.changePct, 2)}%)` : "";
      x.ch.className = `ck-ch ${tone(q.change)}`;
    }
    for (const [s, x] of tiles) x.t.hidden = !rows.some((q) => q.symbol === s);
    el.hidden = !rows.length;
    return rows;
  };
  return { el, fill };
}

/**
 * The cockpit's cards. `accs` from /v1/accounts, `orders` from /v1/orders, `streams` /v1/stream/stats, `usage`
 * /v1/usage, `safety` /v1/safety, `keys` /v1/keys, `readyPill` the readiness pill (or null). `starting`: GET
 * /v1/health's `startup` while the Bridge is still seeding the demo book (or null). The Bridge holds positions, funds
 * and orders until then, so the cockpit draws at once: the two book cards show a skeleton with the seed's progress
 * ("Setting up the demo book · 6 of 9 legs", from /v1/health every half second) and fill in when it is done. A
 * partly seeded book is never read, so never shown as if it were complete.
 * @returns {Promise<{ nodes: Node[], refresh: () => Promise<void> }>}
 */
export async function cockpit({ accs, orders, streams, usage, safety, keys, readyPill, starting = null }) {
  const now = Date.now();
  const today = istToday(now);
  const strip = indicesStrip();
  // Accounts we can read without a broker call storm: paper ones, and live ones that are logged in (max 6).
  const readable = accs.filter((a) => a.broker === "paper" || a.session?.state === "connected").slice(0, 6);
  const readBook = () =>
    Promise.all([
      Promise.all(readable.map((a) => optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`)))),
      Promise.all(readable.map((a) => optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`)))),
    ]);
  const waiting = startupText(starting);
  const [quotes, book, events, refs] = await Promise.all([
    strip.fill().catch(() => []),
    waiting ? null : readBook(),
    optional(api("/v1/events?limit=80")),
    Promise.all(["NIFTY", "BANKNIFTY", "SENSEX"].map((u) => optional(api(`/v1/reference/bundle?underlying=${u}`)))),
  ]);
  const spots = Object.fromEntries((quotes ?? []).map((q) => [q.symbol.split(":")[1], q.ltp]));

  // ── While the demo book is being seeded: a skeleton and the progress, in both book cards ──
  const seedLines = [];
  const seedBody = (rows, live) => {
    const line = h("p", { class: "ck-note ck-seed-line", ...(live ? { role: "status" } : {}) }, waiting);
    seedLines.push(line);
    return h("div", { class: "ck-seed" }, line, loadingState({ rows, cols: 3, label: waiting }));
  };
  const label = (id) => accs.find((a) => a.id === id)?.label ?? id;
  const pnlCardOf = (posRes, fundRes) => {
    // ── P&L today ──
    const perAcct = readable.map((a, i) => {
      const ps = posRes[i].data?.data ?? [];
      const f = fundRes[i].data?.data ?? null;
      const known = ps.filter((p) => num(p.pnl) !== null);
      return { a, pnl: known.length ? known.reduce((s, p) => s + Number(p.pnl), 0) : ps.length ? null : 0, open: ps.filter((p) => num(p.netQty)).length, used: num(f?.usedMargin), free: num(f?.availableCash), error: posRes[i].error };
    });
    const total = perAcct.reduce((s, x) => s + (num(x.pnl) ?? 0), 0);
    return card({
      glyph: "wallet",
      tint: "green",
      title: "Your P&L today",
      sub: readable.length ? `${formatInt(readable.length)} account${readable.length === 1 ? "" : "s"} · realised and open` : "No account to read",
      cls: "ck-card ck-a-pnl",
      actions: h("a", { class: "lk small", href: "#/positions" }, "Positions"),
      body: readable.length
        ? h(
            "div",
            { class: "ck-pnl" },
            h("div", { class: "ck-hero" }, signed(total, "ck-big"), h("small", {}, `${formatInt(perAcct.reduce((s, x) => s + x.open, 0))} open legs`)),
            h(
              "ul",
              { class: "ck-list" },
              perAcct.map((x) => {
                const all = (x.used ?? 0) + (x.free ?? 0);
                const pct = x.used !== null && all > 0 ? x.used / all : null;
                const bar = h("i", { class: `ck-bar-fill${pct !== null && pct >= 0.9 ? " bad" : pct !== null && pct >= 0.7 ? " warn" : ""}` });
                bar.style.width = `${Math.round(Math.min(1, pct ?? 0) * 100)}%`;
                return h(
                  "li",
                  {},
                  h("span", { class: "ck-l" }, h("strong", {}, x.a.label), h("small", {}, x.error ? "Positions unavailable" : pct === null ? `${formatInt(x.open)} open` : `Margin ${formatPercent(pct * 100, 0)} · free ${isFigure(x.free) && x.free >= 0 ? `₹${formatCompact(x.free)}` : formatRupee(x.free, 0)}`)),
                  h("span", { class: "ck-bar", "aria-hidden": "true" }, bar),
                  signed(x.pnl),
                );
              }),
            ),
          )
        : emptyState("wallet", "No account to read", "Log in to a broker, or use the paper account.", null, { compact: true }),
    });
  };

  // ── Open positions with risk ──
  const posCardOf = (posRes) => {
    // Each read is for one account; a broker that leaves accountId off its rows (the demo feed) still groups by it.
    const allPos = posRes.flatMap((r, i) => (r.data?.data ?? []).map((p) => (p.accountId ? p : { ...p, accountId: readable[i].id })));
    const groups = bookGroups(allPos, { spots, nowMs: now });
    return card({
      glyph: "strategy",
      tint: "indigo",
      title: "Open positions",
      sub: groups.length ? `${formatInt(groups.length)} book${groups.length === 1 ? "" : "s"} by account and underlying` : "Nothing open",
      cls: "ck-card ck-a-pos",
      actions: h("a", { class: "lk small", href: "#/positions" }, "Open"),
      flush: true,
      body: groups.length
        ? h(
            "table",
            { class: "ck-table" },
            h("thead", {}, h("tr", {}, [["Book"], ["Legs"], ["P&L"], ["Delta", "c-delta"], ["Expiry", "c-exp"], ["Watch", "c-watch"]].map(([t, c]) => h("th", { scope: "col", class: c }, t)))),
            h(
              "tbody",
              {},
              groups.slice(0, 8).map((g) => {
                const mins = g.minutesToExpiry;
                const exp = mins === null ? DASH : mins < 0 ? "Expired" : mins < 24 * 60 ? `${formatFixed(mins / 60, 1)} h` : `${formatInt(Math.floor(mins / 1440))} d`;
                const watch = [];
                if (num(g.premiumMultiple) !== null && g.premiumMultiple >= 1.8) watch.push(pill(`A leg at ${formatFixed(g.premiumMultiple, 1)}×`, "warn"));
                if (mins !== null && mins >= 0 && mins < 24 * 60 && g.shorts) watch.push(pill("Shorts expire today", "warn"));
                return h(
                  "tr",
                  {},
                  // Phones drop the Delta, Expiry and Watch columns; the expiry and what to watch then show under the book's name.
                  h("th", { scope: "row" }, h("strong", {}, g.underlying), h("small", {}, label(g.account), h("span", { class: "ck-exp-in" }, ` · ${exp}`)), watch.length ? h("span", { class: "ck-watch-in" }, watch.map((p) => p.cloneNode(true))) : null),
                  h("td", { class: "num" }, `${formatInt(g.legs)}${g.shorts ? ` · ${formatInt(g.shorts)} short` : ""}`),
                  h("td", { class: "num" }, signed(g.pnl)),
                  h("td", { class: "num c-delta", title: "Net delta in units of the underlying (Black-76 at each leg's implied vol)" }, num(g.delta) === null ? DASH : formatSigned(g.delta, 0)),
                  h("td", { class: "num c-exp" }, exp),
                  h("td", { class: "c-watch" }, watch.length ? watch : h("span", { class: "muted" }, "Calm")),
                );
              }),
            ),
          )
        : emptyState("strategy", "No open positions", "Trade from the option chain or the Strategy Builder; paper orders are the default.", h("a", { class: "lk", href: "#/chain" }, "Open the chain"), { compact: true }),
    });
  };
  let pnlCard = waiting
    ? card({ glyph: "wallet", tint: "green", title: "Your P&L today", sub: `${formatInt(readable.length)} account${readable.length === 1 ? "" : "s"} · waiting for the book`, cls: "ck-card ck-a-pnl", actions: h("a", { class: "lk small", href: "#/positions" }, "Positions"), body: seedBody(3, true) })
    : pnlCardOf(book[0], book[1]);
  let posCard = waiting
    ? card({ glyph: "strategy", tint: "indigo", title: "Open positions", sub: "Waiting for the book", cls: "ck-card ck-a-pos", actions: h("a", { class: "lk small", href: "#/positions" }, "Open"), body: seedBody(4, false) })
    : posCardOf(book[0]);

  // ── Latest live events ──
  const evs = events.data?.data ?? [];
  const evCard = card({
    glyph: "radar",
    tint: "orange",
    title: "Latest live events",
    sub: evs.length ? "Highs, gaps, OI build-up, IV and more, as they happen" : "No events yet",
    cls: "ck-card ck-a-ev",
    actions: h("a", { class: "lk small", href: "#/screeners/events" }, "All events"),
    body: evs.length
      ? h(
          "ul",
          { class: "ck-events" },
          evs.slice(0, 80).map((e) =>
            h(
              "li",
              { class: `side-${e.side ?? "neutral"}` },
              h("time", { datetime: e.time }, TIME.format(new Date(e.ts ?? Date.parse(e.time)))),
              h("span", { class: "ck-ev-t" }, h("strong", {}, String(e.symbol ?? "").split(":")[1] ?? e.symbol), h("span", {}, e.label ?? e.kind)),
              h("small", {}, e.context ?? ""),
            ),
          ),
        )
      : emptyState("radar", "Nothing yet today", "Events start once prices stream in.", null, { compact: true }),
  });

  // ── Your watchlist (the list marked Show on Home) ──
  const wlRes = await optional(api("/v1/watchlists"));
  const homeList = (wlRes.data?.data?.items ?? []).find((l) => l.home) ?? null;
  // Its quotes (with each row's front-expiry IV) can take a few seconds at start: the card draws with a skeleton and fills in.
  const wlBody = h("div", { class: "ck-wl" }, loadingState({ rows: 4, cols: 3, label: "Loading quotes" }));
  const fillWl = async () => {
    if (!homeList?.symbols.length) return;
    const r = await optional(api(`/v1/watchlists/${encodeURIComponent(homeList.id)}/quotes`, { fresh: true }));
    const rows = r.data?.data?.rows ?? [];
    wlBody.replaceChildren(
      h(
        "ul",
        { class: "ck-wl-list" },
        rows.slice(0, 10).map((x) =>
          h(
            "li",
            {},
            h("strong", {}, x.name),
            h("span", { class: "ck-wl-px" }, formatGrouped(x.ltp, 2)),
            h("span", { class: `ck-wl-ch ${tone(x.changePct)}` }, isFigure(x.changePct) ? `${formatSigned(x.changePct, 2)}%` : DASH),
            h("small", { class: "ck-wl-iv", title: isFigure(x.iv) ? "ATM IV of the front expiry, as on the Option Chain" : undefined }, isFigure(x.iv) ? `IV ${formatFixed(x.iv, 1)}` : isFigure(x.oiChangePct) ? `OI ${formatSigned(x.oiChangePct, 1)}%` : ""),
          ),
        ),
      ),
    );
  };
  fillWl().catch(() => {});
  const wlCard = card({
    glyph: "list",
    tint: "blue",
    title: homeList ? homeList.name : "Watchlist",
    sub: homeList ? "Your list on Home: last price, % change and IV" : "Pick a list to show here",
    cls: "ck-card ck-a-wl",
    actions: h("a", { class: "lk small", href: "#/screeners/watchlists" }, homeList ? "Edit" : "Watchlists"),
    body: homeList?.symbols.length ? wlBody : emptyState("list", "No list on Home", "Mark a watchlist Show on Home and its quotes appear here.", h("a", { class: "lk", href: "#/screeners/watchlists" }, "Open watchlists"), { compact: true }),
  });

  // ── Market calendar today ──
  const bundles = refs.map((r) => r.data?.data).filter(Boolean);
  const ses = bundles[0]?.session ?? null;
  const exps = bundles
    .flatMap((b) => (b.expiries ?? []).map((e) => ({ u: b.underlying, ...e })))
    .filter((e) => {
      const d = daysFrom(e.date, today);
      return d >= 0 && d <= 14;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.u.localeCompare(b.u)));
  const hols = (bundles[0]?.holidays ?? []).filter((x) => {
    const d = daysFrom(x.date, today);
    return d >= 0 && d <= 21;
  });
  const calCard = card({
    glyph: "calendar",
    tint: "teal",
    title: "Market calendar",
    sub: ses ? `${ses.label ?? ses.state} · ${ses.open} to ${ses.close} IST` : "Session times unavailable",
    cls: "ck-card ck-a-cal",
    actions: h("a", { class: "lk small", href: "#/calendar" }, "Calendar"),
    body: h(
      "div",
      { class: "ck-cal" },
      h(
        "ul",
        { class: "ck-list" },
        exps.length
          ? exps.slice(0, 6).map((e) => {
              const d = daysFrom(e.date, today);
              return h("li", {}, h("span", { class: "ck-l" }, h("strong", {}, `${e.u} ${e.kind === "monthly" ? "monthly" : "weekly"} expiry`), h("small", {}, `${dayText(e.date)}${e.shifted ? " · moved for a holiday" : ""}`)), d === 0 ? pill("Today", "warn") : h("span", { class: "muted" }, d === 1 ? "Tomorrow" : `In ${formatInt(d)} days`));
            })
          : h("li", { class: "muted" }, "No index expiry in the next 14 days."),
      ),
      hols.length ? h("p", { class: "ck-note" }, `Holiday${hols.length > 1 ? "s" : ""}: ${hols.map((x) => `${dayText(x.date)} (${x.label})`).join(", ")}`) : null,
      bundles[0]?.nextTradingDay ? h("p", { class: "ck-note" }, `Next trading day ${dayText(bundles[0].nextTradingDay)}`) : null,
    ),
  });

  // ── API and broker health ──
  const sd = streams.data?.data;
  const up = sd?.upstreams ?? [];
  const sv = usage.data?.data?.savings;
  const saved = sv ? (sv.servedFromStream ?? 0) + (sv.servedFromCache ?? 0) + (sv.coalesced ?? 0) + (sv.batched ?? 0) : null;
  const ks = safety.data?.data?.killSwitch;
  const ordersText = (ord) => (ord ? `${formatInt(ord.filter((o) => o.mode === "paper").length)} paper · ${formatInt(ord.filter((o) => o.mode === "live").length)} live` : DASH);
  const ordersDd = h("dd", {}, ordersText(orders.data?.data ?? null));
  // Latest orders, newest first: the health card's elastic part on wide screens (the account rows keep their height).
  const recentList = h("ul", { class: "ck-recent-list" });
  const fillRecent = (ord) =>
    recentList.replaceChildren(
      ...(ord ?? [])
        .slice()
        .sort((a, b) => String(b.placedAt ?? "").localeCompare(String(a.placedAt ?? "")))
        .slice(0, 12)
        .map((o) => {
          const st = orderStatusText(o.status);
          const t = Date.parse(o.placedAt ?? "");
          return h(
            "li",
            { title: o.symbol },
            h("time", { datetime: o.placedAt ?? "" }, Number.isFinite(t) ? TIME.format(new Date(t)) : DASH),
            h("span", { class: "ck-l" }, h("strong", {}, contractName(o.symbol)), h("small", {}, `${o.side === "SELL" ? "Sell" : "Buy"} ${formatInt(o.quantity)}${isFigure(o.avgPrice) ? ` @ ${formatFixed(o.avgPrice, 2)}` : ""} · ${o.mode === "live" ? "Live" : "Paper"}`)),
            h("span", { class: `ck-st ${st.tone}`.trim() }, st.text),
          );
        }),
    );
  fillRecent(orders.data?.data ?? null);
  const recentBlock = h("div", { class: "ck-recent" }, h("h3", { class: "ck-sub" }, "Latest orders"), recentList);
  const keyRows = keys.data?.data ?? [];
  const healthCard = card({
    glyph: "activity",
    tint: "purple",
    title: "API and broker health",
    sub: `Bridge ${app.state.health?.version ?? ""} · up ${formatInt((app.state.health?.uptimeSeconds ?? 0) / 60)} min`,
    cls: "ck-card ck-a-hl",
    actions: h("a", { class: "lk small", href: "#/api" }, "API"),
    body: h(
      "div",
      { class: "ck-health" },
      h(
        "ul",
        { class: "ck-list" },
        accs.slice(0, 5).map((a) => {
          const s = a.broker === "paper" ? { text: "Ready", tone: "ok" } : sessionText(a.session?.state);
          return h("li", {}, h("span", { class: "ck-l" }, h("strong", {}, a.label), h("small", {}, a.broker === "paper" ? "Paper" : a.liveAllowedByConfig ? "Live enabled" : "Paper only")), pill(s.text, s.tone));
        }),
      ),
      h(
        "dl",
        { class: "ck-kv" },
        h("dt", {}, "Stream"),
        h("dd", {}, up.length ? `${up.filter((u) => u.connected).length === up.length ? "Up" : "Partly up"} · ${formatInt(sd?.symbols)} symbols` : "Off"),
        h("dt", {}, "Calls saved today"),
        h("dd", {}, saved === null ? DASH : formatInt(saved)),
        h("dt", {}, "Orders today"),
        ordersDd,
        h("dt", {}, "API keys"),
        h("dd", {}, formatInt(keyRows.filter((k) => !k.revokedAt).length)),
      ),
      recentList.childElementCount ? recentBlock : null,
      h("div", { class: "row ck-pills" }, ks?.engaged ? pill("Kill switch on", "bad") : pill("Kill switch off", "ok"), readyPill, safety.data?.data?.liveTrading ? pill("Live trading on", "bad") : pill("Paper only")),
    ),
  });

  const grid = h("div", { class: "cockpit" }, pnlCard, posCard, evCard, calCard, healthCard, wlCard);

  // Follow the seed: the progress line every half second; once the Bridge answers book reads, read the whole book and
  // put the two cards in place (and today's orders), all at once.
  if (waiting) {
    (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (!grid.isConnected) return;
        const hz = await optional(api("/v1/health", { fresh: true }));
        const t = hz.data ? startupText(hz.data.startup) : waiting;
        if (t) {
          for (const l of seedLines) if (l.textContent !== t) l.textContent = t;
          continue;
        }
        const [b, ord] = await Promise.all([readBook(), optional(api("/v1/orders?limit=100", { fresh: true }))]);
        if (!grid.isConnected) return;
        const nextPnl = pnlCardOf(b[0], b[1]);
        const nextPos = posCardOf(b[0]);
        pnlCard.replaceWith(nextPnl);
        posCard.replaceWith(nextPos);
        pnlCard = nextPnl;
        posCard = nextPos;
        ordersDd.textContent = ordersText(ord.data?.data ?? null);
        fillRecent(ord.data?.data ?? null);
        return;
      }
    })().catch(() => {});
  }
  return {
    nodes: [strip.el, grid],
    refresh: async () => {
      await strip.fill().catch(() => {});
      await fillWl().catch(() => {});
    },
  };
}

export const COCKPIT_INDICES = INDICES;
