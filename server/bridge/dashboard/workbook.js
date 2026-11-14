// workbook.js: saves the Bridge's Excel workbook (workbook-core.js, xlsx-core.js; no dependency). The workbook reads prices
// and your book from this Bridge with one request per sheet. It holds no key unless the person asks for one.
import { h, toast } from "./app.js";
import { bridgeWorkbook } from "./workbook-core.js";

/** Save bytes or text as a file: a Blob link clicked once. */
export function saveFile(name, data, type) {
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

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** Today's date in IST, as YYYY-MM-DD. */
export const istToday = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);

/**
 * Download the workbook. `opts`: { include, symbols, key } as workbookSheets() takes them. Returns true when saved.
 * Called with nothing, it saves the standard workbook (every sheet, a sample watchlist, no key).
 */
export function downloadWorkbook(opts = {}) {
  const today = istToday();
  const bytes = bridgeWorkbook({ host: location.origin, madeAt: today, ...opts });
  const ok = saveFile(`bridge-workbook-${today}.xlsx`, bytes, XLSX_TYPE);
  if (ok && !opts.key) toast("Workbook saved. Paste a read-only key in Setup, cell B6 (Integrations > Excel and Sheets makes one)");
  return ok;
}
