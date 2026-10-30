// explain-core.js: "Explain this" on OI Analysis and Volatility. Reads the numbers already on the page (PCR, walls,
// build-up, max pain; IV against HV, IV rank, skew, term structure) and says in plain words what each one measures
// right now. Pure: no DOM. Neutral copy (copyRules.mjs, BRD §8): it describes, it never says what to do, and every
// sentence names the figure it reads. Numbers become text through format.js.
import { formatFixed, formatInt, formatSigned } from "./format.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const EXPLAIN_NOTE = "Context from the numbers on this page, not advice. Open interest and implied volatility describe positioning and prices; they do not predict the next move.";

/**
 * OI: { spot, pcr, pcrRef (at the window start), callWall, putWall, maxPain, buildup ({ tone, short }), sessionsLeft }.
 * @returns {{ key: string, text: string }[]}
 */
export function explainOi(x = {}) {
  const out = [];
  const S = num(x.spot);
  const pcr = num(x.pcr);
  if (pcr !== null) {
    const lean = pcr >= 1.2 ? "more put open interest than call open interest" : pcr <= 0.8 ? "more call open interest than put open interest" : "put and call open interest close to each other";
    let t = `PCR ${formatFixed(pcr, 2)}: ${lean} in this expiry.`;
    const ref = num(x.pcrRef);
    if (ref !== null && Math.abs(pcr - ref) >= 0.05) t += ` It was ${formatFixed(ref, 2)} at the start of the window, so put OI has been ${pcr > ref ? "growing faster" : "growing slower"} than call OI.`;
    t += " Many option writers hold these positions, so a high PCR can also mean puts were written, not bought.";
    out.push({ key: "pcr", text: t });
  }
  const cw = num(x.callWall);
  const pw = num(x.putWall);
  if (cw !== null || pw !== null) {
    const bits = [];
    if (cw !== null) bits.push(`the largest call OI is at ${formatInt(cw)}${S ? ` (${formatSigned(((cw - S) / S) * 100, 1)}% from spot)` : ""}`);
    if (pw !== null) bits.push(`the largest put OI is at ${formatInt(pw)}${S ? ` (${formatSigned(((pw - S) / S) * 100, 1)}% from spot)` : ""}`);
    out.push({ key: "walls", text: `Walls: ${bits.join(" and ")}. These are the strikes where the most contracts are open; writers there gain while spot stays on their side of the strike, and those strikes often see heavy activity when spot nears them.` });
  }
  const mp = num(x.maxPain);
  if (mp !== null) {
    const near = num(x.sessionsLeft);
    out.push({ key: "maxpain", text: `Max pain ${formatInt(mp)}${S ? `, ${formatSigned(mp - S, 0)} points from spot` : ""}: the settlement price at which option holders in this expiry would collect the least in total.${near !== null && near <= 2 ? " With the expiry this close it is watched more; it is a calculation from OI, not a forecast." : " Far from expiry it says little about where the index settles."}` });
  }
  const bu = x.buildup;
  if (bu && !bu.empty && bu.short) {
    const what = { up: "OI added with prices moving in a way that matches new positions leaning up", down: "OI added with prices moving in a way that matches new positions leaning down", range: "OI added on both sides of spot, the pattern of positions that gain from a range", mixed: "OI changes that do not lean either way" }[bu.tone] ?? "the OI changes in this window";
    out.push({ key: "buildup", text: `Build-up: ${bu.short}. That reads as ${what}. It is inferred from price and OI changes, so the same numbers can come from different trades.` });
  }
  return out;
}

/**
 * Volatility: { atmIv, hv20, ivr, ivp, put25, call25 (IVs), term: [{ expiry, atmIv }] (nearest first) }.
 * @returns {{ key: string, text: string }[]}
 */
export function explainVol(x = {}) {
  const out = [];
  const iv = num(x.atmIv);
  const hv = num(x.hv20);
  if (iv !== null && hv !== null) {
    const gap = iv - hv;
    const where = Math.abs(gap) < 1 ? "close to" : gap > 0 ? "above" : "below";
    out.push({ key: "ivhv", text: `ATM IV ${formatFixed(iv, 1)}% is ${where} the index's last 20 days of realised moves (HV20 ${formatFixed(hv, 1)}%, a gap of ${formatSigned(gap, 1)} points). Option prices ${gap > 0 ? "assume larger daily moves than the recent ones" : gap < 0 ? "assume smaller daily moves than the recent ones" : "assume moves like the recent ones"}; a writer collects the gap only if moves stay as they were, a holder needs moves larger than IV implies.` });
  } else if (iv !== null) out.push({ key: "iv", text: `ATM IV ${formatFixed(iv, 1)}%: the market's price of the index's yearly move, about ${formatFixed(iv / Math.sqrt(252), 2)}% a day. No realised volatility is loaded to compare it with.` });
  const ivr = num(x.ivr);
  if (ivr !== null) out.push({ key: "rank", text: `IV rank ${formatInt(ivr)}: today's IV sits ${ivr >= 70 ? "near the top" : ivr <= 30 ? "near the bottom" : "in the middle"} of its range over the lookback${num(x.ivp) !== null ? `, higher than on ${formatInt(x.ivp)}% of those days` : ""}. IV tends to move back toward its usual range, but it can stay high or low for weeks.` });
  const p = num(x.put25);
  const c = num(x.call25);
  if (p !== null && c !== null) {
    const rr = p - c;
    out.push({ key: "skew", text: `Skew: the 25-delta put trades at ${formatFixed(p, 1)}% IV and the 25-delta call at ${formatFixed(c, 1)}% (${formatSigned(rr, 1)} points). ${rr > 0.5 ? "Downside protection costs more than upside calls, the usual shape for an index." : rr < -0.5 ? "Upside calls cost more than downside puts, which is less common for an index." : "Puts and calls at the same distance are priced alike."}` });
  }
  const term = (x.term ?? []).filter((t) => num(t.atmIv) !== null);
  if (term.length >= 2) {
    const a = term[0];
    const b = term[term.length - 1];
    const slope = b.atmIv - a.atmIv;
    out.push({ key: "term", text: `Term structure: ${formatFixed(a.atmIv, 1)}% in the nearest expiry against ${formatFixed(b.atmIv, 1)}% in the furthest loaded one. ${slope > 0.5 ? "Later expiries carry more IV (upward sloping), the usual shape in calm markets." : slope < -0.5 ? "The nearest expiry carries more IV than later ones (inverted), which often happens around an event or a fast market." : "IV is about the same across expiries."}` });
  }
  return out;
}
