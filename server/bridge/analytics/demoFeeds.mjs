/**
 * Demo mode: NSE, SEBI and RBI public data in the shapes those sites publish, so Flow › Filings and the news routes
 * show realistic rows on a computer with no network. Used only when config.demo is true (analytics/module.mjs injects
 * them as deps.marketEventsFetcher and deps.newsFeedsFetcher); every answer is labelled demo by the routes' meta.
 * Deterministic: the same day gives the same rows.
 */

const SYMBOLS = [
  ["RELIANCE", "Reliance Industries Limited", 2870],
  ["HDFCBANK", "HDFC Bank Limited", 1690],
  ["ICICIBANK", "ICICI Bank Limited", 1240],
  ["INFY", "Infosys Limited", 1820],
  ["TCS", "Tata Consultancy Services Limited", 4120],
  ["SBIN", "State Bank of India", 812],
  ["AXISBANK", "Axis Bank Limited", 1135],
  ["LT", "Larsen & Toubro Limited", 3610],
  ["BHARTIARTL", "Bharti Airtel Limited", 1585],
  ["ITC", "ITC Limited", 468],
  ["MARUTI", "Maruti Suzuki India Limited", 12450],
  ["SUNPHARMA", "Sun Pharmaceutical Industries Limited", 1790],
];
const CLIENTS = ["GOLDMAN SACHS (SINGAPORE) PTE", "MORGAN STANLEY ASIA (SINGAPORE) PTE", "SBI MUTUAL FUND", "HDFC MUTUAL FUND", "NORGES BANK ON ACCOUNT OF GOVERNMENT PENSION FUND GLOBAL", "ICICI PRUDENTIAL MUTUAL FUND", "BOFA SECURITIES EUROPE SA", "SOCIETE GENERALE"];
const PEOPLE = [
  ["Promoter Group", "Promoter group entity"],
  ["Director", "Independent director"],
  ["KMP", "Chief financial officer"],
  ["Promoter", "Promoter"],
];

function rand(seed) {
  let x = 2166136261;
  for (const ch of seed) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  return x / 4294967296;
}
const dayList = (from, to) => {
  const out = [];
  for (let t = Date.parse(`${to}T00:00:00Z`); t >= Date.parse(`${from}T00:00:00Z`) && out.length < 31; t -= 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
const r2 = (v) => Math.round(v * 100) / 100;
const pickSym = (seed) => SYMBOLS[Math.floor(rand(seed) * SYMBOLS.length)];

/** Block and bulk deals, insider trades and the results calendar (marketEvents.mjs fetcher contract). */
export async function demoMarketEventsFetcher(kind, { from, to, symbol } = {}) {
  const days = dayList(from, to);
  const keep = (s) => !symbol || s === String(symbol).toUpperCase();
  if (kind === "block" || kind === "bulk") {
    const data = [];
    for (const d of days)
      for (let i = 0; i < (kind === "block" ? 3 : 6); i++) {
        const [sym, name, px] = pickSym(`${kind}${d}${i}`);
        if (!keep(sym)) continue;
        const q = Math.round((kind === "block" ? 400_000 : 150_000) * (0.4 + rand(`${kind}${d}${i}q`) * 2.2));
        data.push({ BD_DT_DATE: d, BD_SYMBOL: sym, BD_SCRIP_NAME: name, BD_CLIENT_NAME: CLIENTS[Math.floor(rand(`${kind}${d}${i}c`) * CLIENTS.length)], BD_BUY_SELL: rand(`${kind}${d}${i}s`) < 0.52 ? "BUY" : "SELL", BD_QTY_TRD: q, BD_TP_WATP: r2(px * (0.985 + rand(`${kind}${d}${i}p`) * 0.03)) });
      }
    return { data };
  }
  if (kind === "pit") {
    const data = [];
    for (const d of days)
      for (let i = 0; i < 4; i++) {
        const [sym, name, px] = pickSym(`pit${d}${i}`);
        if (!keep(sym)) continue;
        const [cat, who] = PEOPLE[Math.floor(rand(`pit${d}${i}w`) * PEOPLE.length)];
        const n = Math.round(2_000 + rand(`pit${d}${i}n`) * 180_000);
        const buy = rand(`pit${d}${i}b`) < 0.6;
        data.push({ date: d, symbol: sym, company: name, acqName: `${who} (demo)`, personCategory: cat, tdpTransactionType: buy ? "Buy" : "Sell", secType: "Equity Shares", secAcq: n, secVal: Math.round(n * px), acqMode: buy ? "Market Purchase" : "Market Sale" });
      }
    return { data };
  }
  if (kind === "events") {
    const data = [];
    const ahead = dayList(to, new Date(Date.parse(`${to}T00:00:00Z`) + 20 * 86_400_000).toISOString().slice(0, 10));
    for (const d of [...days, ...ahead])
      if (rand(`ev${d}`) < 0.7) {
        const [sym, name] = pickSym(`ev${d}`);
        if (!keep(sym)) continue;
        const purpose = rand(`ev${d}p`) < 0.75 ? "Financial Results" : "Dividend";
        data.push({ symbol: sym, company: name, purpose, bm_desc: purpose === "Financial Results" ? "To consider and approve the unaudited financial results for the quarter" : "To consider an interim dividend", date: d });
      }
    return data;
  }
  return { data: [] };
}

const RSS = (title, items) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><guid>${i.link}</guid><description>${i.desc}</description><pubDate>${i.date}</pubDate></item>`).join("")}</channel></rss>`;
const rfc = (iso, hh = "17:30:00") => new Date(`${iso}T${hh}+05:30`).toUTCString();

/** Demo market-news feeds (newsFeeds.mjs MARKET_KINDS): [paper, host]. */
const MARKET_DEMO = { etMarkets: ["The Economic Times", "economictimes.indiatimes.com"], mcMarkets: ["Moneycontrol", "www.moneycontrol.com"], bsMarkets: ["Business Standard", "www.business-standard.com"], mintMarkets: ["Mint", "www.livemint.com"] };
const HEADLINE_PATTERNS = [
  "{co} shares rise {pct}% after quarterly results",
  "{co} slips {pct}% as volumes pick up",
  "Nifty ends {pct}% higher; {co} among top movers",
  "Sensex falls {pct}% in late trade, {co} weighs",
  "{co} board approves fund raising plan",
  "Bank Nifty options see heavy activity at the weekly expiry",
  "FPIs turn net sellers for the week; {co} in focus",
  "{co} to announce results next week",
];

/** SEBI and RBI RSS, NSE announcements, the results calendar and the F&O ban list (newsFeeds.mjs fetcher contract). */
export async function demoNewsFeedsFetcher(kind, params = {}) {
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const days = dayList(new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10), today);
  if (kind === "sebi")
    return RSS("SEBI (demo)", [
      { title: "Circular on revised margin framework for equity derivatives (demo)", link: "https://www.sebi.gov.in/demo/circular-margins", desc: "Changes to upfront margin collection for F&amp;O positions.", date: rfc(days[1]) },
      { title: "Consultation paper on weekly index expiries (demo)", link: "https://www.sebi.gov.in/demo/consultation-expiry", desc: "Views sought on the expiry calendar for index derivatives.", date: rfc(days[3]) },
      { title: "Revision of lot sizes for index derivatives (demo)", link: "https://www.sebi.gov.in/demo/lot-sizes", desc: "Lot sizes reviewed semi-annually.", date: rfc(days[6]) },
    ]);
  if (kind === "rbiPress")
    return RSS("RBI press releases (demo)", [
      { title: "Monetary policy statement (demo)", link: "https://www.rbi.org.in/demo/mps", desc: "The policy repo rate is kept unchanged.", date: rfc(days[2], "10:00:00") },
      { title: "Money market operations (demo)", link: "https://www.rbi.org.in/demo/mmo", desc: "Liquidity adjustment facility for the day.", date: rfc(days[0], "19:00:00") },
    ]);
  if (kind === "rbiNotifications") return RSS("RBI notifications (demo)", [{ title: "Master direction amended (demo)", link: "https://www.rbi.org.in/demo/md", desc: "An amendment to a master direction.", date: rfc(days[4]) }]);
  if (kind === "rbiSpeeches") return RSS("RBI speeches (demo)", [{ title: "Speech on financial stability (demo)", link: "https://www.rbi.org.in/demo/speech", desc: "Remarks at a conference.", date: rfc(days[5]) }]);
  if (kind === "announcements") {
    const data = [];
    for (const d of days.slice(0, 6))
      for (let i = 0; i < 4; i++) {
        const [sym, name] = pickSym(`an${d}${i}`);
        if (params.symbol && sym !== String(params.symbol).toUpperCase()) continue;
        const subj = ["Outcome of Board Meeting", "Analysts/Institutional Investor Meet/Con. Call Updates", "Press Release", "Updates"][Math.floor(rand(`an${d}${i}s`) * 4)];
        data.push({ symbol: sym, sm_name: name, desc: subj, attchmntText: `${name}: ${subj.toLowerCase()} (demo).`, an_dt: `${d} ${String(9 + i * 2).padStart(2, "0")}:15:00`, seq_id: `demo-${d}-${i}`, attchmntFile: null });
      }
    return data;
  }
  if (MARKET_DEMO[kind]) {
    // Market headlines: a few per paper per day over the last three sessions, some naming a demo company or an index.
    const [paper, host] = MARKET_DEMO[kind];
    const items = [];
    for (const d of days.slice(0, 3))
      for (let i = 0; i < 4; i++) {
        const seed = `${kind}${d}${i}`;
        const [, name] = pickSym(seed);
        const short = name.replace(/\s+(Limited|Ltd)$/i, "");
        const pattern = HEADLINE_PATTERNS[Math.floor(rand(`${seed}p`) * HEADLINE_PATTERNS.length)];
        const title = `${pattern.replace("{co}", short).replace("{pct}", (0.4 + rand(`${seed}x`) * 3).toFixed(1))} (demo)`;
        const hh = String(15 - i * 2).padStart(2, "0");
        items.push({ title: title.replace(/&/g, "&amp;"), link: `https://${host}/demo/${d}-${i}`, desc: "", date: rfc(d, `${hh}:${String(Math.floor(rand(`${seed}m`) * 60)).padStart(2, "0")}:00`) });
      }
    return RSS(`${paper} markets (demo)`, items);
  }
  if (kind === "events") return demoMarketEventsFetcher("events", params);
  if (kind === "ban") {
    const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(today.slice(5, 7)) - 1];
    return `Securities in Ban For Trade Date ${today.slice(8, 10)}-${mon}-${today.slice(0, 4)}:\n1,RBLBANK\n2,BANDHANBNK\n`;
  }
  return null;
}
