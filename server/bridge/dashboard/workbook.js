// workbook.js: "Excel workbook" on Accounts. Reads the open positions of the paper and logged-in accounts and saves a
// .xlsx whose prices are live WEBSERVICE formulas against this Bridge (workbook-core.js, xlsx-core.js; no dependency).
// The key is never written into the file: the Setup sheet says where to paste a read-only one.
import { api, h, optional, toast } from "./app.js";
import { formatInt } from "./format.js";
import { bridgeWorkbook } from "./workbook-core.js";

/** Save bytes or text as a file: a Blob link clicked once. */
function saveFile(name, data, type) {
  try {
    const blob = new Blob([data], { type });
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return true;
  } catch {
    toast("This browser could not save the file", { tone: "error" });
    return false;
  }
}

export async function downloadWorkbook() {
  const acc = await optional(api("/v1/accounts"));
  const readable = (acc.data?.data ?? []).filter((a) => a.broker === "paper" || a.session?.state === "connected").slice(0, 8);
  const pos = await Promise.all(readable.map((a) => optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`))));
  const positions = pos.flatMap((r, i) => (r.data?.data ?? []).map((p) => ({ ...p, accountId: p.accountId ?? readable[i].id })));
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const bytes = bridgeWorkbook({ host: location.origin, positions, madeAt: today });
  const open = positions.filter((p) => Number(p.netQty)).length;
  if (saveFile(`bridge-workbook-${today}.xlsx`, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) {
    toast(`Workbook saved with ${formatInt(open)} open position${open === 1 ? "" : "s"}. Paste a read-only key in Setup › B3`);
  }
}
