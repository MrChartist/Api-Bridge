// trade-intent.js: typed trades in the Ctrl K palette. "buy 2 nifty 26000 ce", "sell nifty straddle 3 nov",
// "s 1 banknifty 58000 pe 25 nov", "nifty iron condor". Pure: it reads the words and returns what to open; it never
// sends. The palette opens a filled order ticket (one leg) or the Strategy Builder (a structure), and the person
// confirms there as for any order, paper by default.

const UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"];
const ALIAS = { BN: "BANKNIFTY", BNF: "BANKNIFTY", NF: "NIFTY", FN: "FINNIFTY", FINNIFTY: "FINNIFTY", MIDCP: "MIDCPNIFTY" };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** Structure words → Strategy Builder preset ids, by side (long / short). */
const STRUCTURES = [
  [/^straddles?$/, { BUY: "long-straddle", SELL: "short-straddle" }, "straddle"],
  [/^strangles?$/, { BUY: "long-strangle", SELL: "short-strangle" }, "strangle"],
  [/^(iron ?condor|ic|condor)$/, { BUY: "reverse-iron-condor", SELL: "iron-condor" }, "iron condor"],
  [/^(iron ?fly|ifly)$/, { BUY: "reverse-iron-fly", SELL: "iron-fly" }, "iron fly"],
  [/^(butterfly|fly)$/, { BUY: "long-call-fly", SELL: "long-call-fly" }, "butterfly"],
  [/^(bull ?call|bcs)$/, { BUY: "bull-call", SELL: "bull-call" }, "bull call spread"],
  [/^(bear ?put|bps)$/, { BUY: "bear-put", SELL: "bear-put" }, "bear put spread"],
];

/** "3 nov", "nov 3", "3nov", "2026-11-03" → "MM-DD" (or the ISO date) to match against listed expiries; else null. */
function readDate(tokens, i) {
  const t = tokens[i];
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { iso: t, used: 1 };
  let m = /^(\d{1,2})([a-z]{3})[a-z]*$/.exec(t);
  if (m && MONTHS.includes(m[2].toUpperCase())) return { md: [MONTHS.indexOf(m[2].toUpperCase()) + 1, Number(m[1])], used: 1 };
  const n = tokens[i + 1] ?? "";
  if (/^\d{1,2}$/.test(t) && MONTHS.includes(n.slice(0, 3).toUpperCase()) && /^[a-z]+$/.test(n)) return { md: [MONTHS.indexOf(n.slice(0, 3).toUpperCase()) + 1, Number(t)], used: 2 };
  if (/^[a-z]+$/.test(t) && MONTHS.includes(t.slice(0, 3).toUpperCase()) && t.length <= 9 && /^\d{1,2}$/.test(n)) return { md: [MONTHS.indexOf(t.slice(0, 3).toUpperCase()) + 1, Number(n)], used: 2 };
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) return { md: [Number(m[2]), Number(m[1])], used: 1 };
  return null;
}

/**
 * Parse a typed trade. Returns null when the text is not one (so the palette searches pages as usual), else
 * { kind: "leg"|"structure", side, lots, underlying, strike?, right?, preset?, structure?, date: { iso }|{ md }|null }.
 * A leg needs a side, an underlying, a strike and CE or PE; a structure needs an underlying and a structure word (the
 * side defaults to SELL for credit structures as typed most often, and is always shown before anything opens).
 */
export function parseTradeIntent(text) {
  const raw = String(text ?? "").toLowerCase().replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
  if (raw.length < 5) return null;
  // "iron condor" and "bull call" are two words: join them first.
  const tokens = raw.replace(/\biron (condor|fly)\b/g, "iron$1").replace(/\b(bull|bear) (call|put)\b/g, "$1$2").split(" ");
  let side = null;
  let lots = null;
  let underlying = null;
  let strike = null;
  let right = null;
  let structure = null;
  let date = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!side && /^(buy|b|long)$/.test(t)) side = "BUY";
    else if (!side && /^(sell|s|short|write)$/.test(t)) side = "SELL";
    else if (!underlying && (UNDERLYINGS.includes(t.toUpperCase()) || ALIAS[t.toUpperCase()])) underlying = ALIAS[t.toUpperCase()] ?? t.toUpperCase();
    else if (!right && /^(ce|call|calls|c)$/.test(t)) right = "CE";
    else if (!right && /^(pe|put|puts|p)$/.test(t)) right = "PE";
    else if (!structure && STRUCTURES.some(([re]) => re.test(t))) structure = STRUCTURES.find(([re]) => re.test(t));
    else if (/^\d+(ce|pe)$/.test(t) && !strike) {
      strike = Number(t.slice(0, -2));
      right = t.endsWith("ce") ? "CE" : "PE";
    } else if (/^\d+$/.test(t) && Number(t) >= 1000 && !strike) strike = Number(t);
    else if (/^\d{1,2}$/.test(t) && !date && readDate(tokens, i)?.used === 2) {
      const d = readDate(tokens, i);
      date = d;
      i += d.used - 1;
    } else if (/^\d+$/.test(t) && Number(t) > 0 && Number(t) < 1000 && lots === null) lots = Number(t);
    else if (/^\d+(x|lots?)$/.test(t) && lots === null) lots = Number(t.replace(/\D/g, ""));
    else if (/^(lot|lots|x|of|at|on|exp|expiry)$/.test(t)) continue;
    else if (!date && readDate(tokens, i)) {
      const d = readDate(tokens, i);
      date = d;
      i += d.used - 1;
    } else return null;
  }
  if (!underlying) return null;
  const n = Math.max(1, Math.min(100, lots ?? 1));
  const when = date ? (date.iso ? { iso: date.iso } : { md: date.md }) : null;
  if (structure) {
    const sd = side ?? "SELL";
    return { kind: "structure", side: sd, lots: n, underlying, preset: structure[1][sd], structure: structure[2], date: when };
  }
  if (!side || !strike || !right) return null;
  return { kind: "leg", side, lots: n, underlying, strike, right, date: when };
}

/** The listed expiry a typed date names (exact ISO, or the same month and day this year or next), else the nearest. */
export function pickExpiry(expiries, date, today) {
  const list = [...(expiries ?? [])].filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= today).sort();
  if (!date) return list[0] ?? null;
  if (date.iso) return list.includes(date.iso) ? date.iso : null;
  const [m, d] = date.md;
  return list.find((e) => Number(e.slice(5, 7)) === m && Number(e.slice(8, 10)) === d) ?? null;
}

/**
 * Where a typed trade goes and what the desk reads there (pure). One leg: the chain, with `jump` (focus the strike)
 * and `ticket` (open the order ticket filled in); a structure: the Strategy Builder, with its legs (`legs`, from the
 * chain's presets) under the underlying. The hash always differs from the current one (`nowHash`): the router redraws
 * only on a hash change, so a trade typed while already on the chain still opens its ticket.
 * @returns {{ prefs: object, hash: string }}
 */
export function intentHandoff(x, { expiry, desk = {}, legs = null, nowHash = "", stamp = Date.now() }) {
  const base = desk && typeof desk === "object" && !Array.isArray(desk) ? { ...desk } : {};
  const page = x.kind === "leg" ? "chain" : "strategy";
  const plain = `#/${page}`;
  const hash = String(nowHash ?? "").split("?")[0] === plain ? `${plain}?trade=${stamp.toString(36)}` : plain;
  if (x.kind === "leg") {
    return { hash, prefs: { ...base, underlying: x.underlying, expiry, jump: { underlying: x.underlying, expiry, strike: x.strike, side: x.right === "PE" ? "pe" : "ce" }, ticket: { strike: x.strike, right: x.right, side: x.side, lots: x.lots } } };
  }
  const baskets = { ...(base.baskets && typeof base.baskets === "object" ? base.baskets : {}) };
  for (const k of Object.keys(baskets)) if (k === x.underlying || k.startsWith(`${x.underlying}|`)) delete baskets[k];
  baskets[x.underlying] = (legs ?? []).map((l) => ({ ...l, expiry: l.expiry ?? expiry }));
  return { hash, prefs: { ...base, underlying: x.underlying, expiry, baskets } };
}

/** The palette's label for an intent: "Buy 2 lots NIFTY 26000 CE · nearest expiry". */
export function intentLabel(x, expiryText = (e) => e) {
  const exp = x.date ? (x.date.iso ? expiryText(x.date.iso) : `${x.date.md[1]} ${MONTHS[x.date.md[0] - 1][0]}${MONTHS[x.date.md[0] - 1].slice(1).toLowerCase()}`) : "nearest expiry";
  const lots = `${x.lots} lot${x.lots === 1 ? "" : "s"}`;
  if (x.kind === "leg") return `${x.side === "BUY" ? "Buy" : "Sell"} ${lots} ${x.underlying} ${x.strike} ${x.right} · ${exp}`;
  const long = x.side === "BUY" ? "Long" : "Short";
  const name = ["straddle", "strangle"].includes(x.structure) ? `${long} ${x.structure}` : x.side === "BUY" && ["iron condor", "iron fly"].includes(x.structure) ? `Reverse ${x.structure}` : x.structure[0].toUpperCase() + x.structure.slice(1);
  return `${name} · ${lots} ${x.underlying} · ${exp}`;
}
