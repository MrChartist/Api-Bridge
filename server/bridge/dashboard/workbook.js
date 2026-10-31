// workbook.js: "Excel workbook" on Accounts and Watchlists. Reads the watchlist shown on Home (else the first) and
// the open positions of the paper and logged-in accounts, and saves a .xlsx whose prices are live WEBSERVICE formulas
// against this Bridge (workbook-core.js, xlsx-core.js; no dependency). The key is never written into the file: the
// Setup sheet says where to paste a read-only one.
import { api, optional, toast } from "./app.js";
import { formatInt } from "./format.js";
import { saveFile } from "./journal.js";
import { bridgeWorkbook } from "./workbook-core.js";

export async function downloadWorkbook() {
  const [wl, acc] = await Promise.all([optional(api("/v1/watchlists")), optional(api("/v1/accounts"))]);
  const lists = wl.data?.data?.items ?? [];
  const watchlist = lists.find((l) => l.home) ?? lists[0] ?? null;
  const readable = (acc.data?.data ?? []).filter((a) => a.broker === "paper" || a.session?.state === "connected").slice(0, 8);
  const pos = await Promise.all(readable.map((a) => optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`))));
  const positions = pos.flatMap((r, i) => (r.data?.data ?? []).map((p) => ({ ...p, accountId: p.accountId ?? readable[i].id })));
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const bytes = bridgeWorkbook({ host: location.origin, watchlist, positions, madeAt: today });
  const open = positions.filter((p) => Number(p.netQty)).length;
  if (saveFile(`bridge-workbook-${today}.xlsx`, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) {
    toast(`Workbook saved: ${formatInt(watchlist?.symbols.length ?? 0)} watchlist symbols, ${formatInt(open)} positions. Paste a read-only key in Setup › B3`);
  }
}
