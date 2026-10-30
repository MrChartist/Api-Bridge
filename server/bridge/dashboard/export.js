// Table export: CSV download and copy-as-TSV on every table card. Written once here; the dashboard opts in by calling
// addExports(root) after it draws (views.js does, through the same observer that labels tables), and a table opts out
// with data-noexport. CSP-safe: the file is a Blob offered through an <a download>, nothing is fetched or inlined.
// The formatting functions are pure and tested in export.test.mjs.

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell as text that a spreadsheet will not run: a cell that starts with = + - @ (or a tab or CR) gets a leading quote. */
export function safeCell(value) {
  const text = String(value ?? "").replace(/ /g, " ").trim();
  return FORMULA_START.test(text) ? `'${text}` : text;
}

const csvField = (text) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** Rows of cells to CSV (RFC 4180 quoting, CRLF lines, a BOM so Excel reads ₹ and – as UTF-8). Pure. */
export function toCsv(matrix, { bom = true } = {}) {
  return (bom ? "﻿" : "") + matrix.map((row) => row.map((c) => csvField(safeCell(c))).join(",")).join("\r\n") + "\r\n";
}

/** Rows of cells to tab-separated text for pasting into a sheet: tabs and line breaks inside a cell become spaces. Pure. */
export function toTsv(matrix) {
  return matrix.map((row) => row.map((c) => safeCell(c).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n") + "\n";
}

/** A file name from a title: lower case, a-z 0-9 and dashes, plus the day. Pure. */
export function exportName(title, ext, day = new Date().toISOString().slice(0, 10)) {
  const slug = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "table";
  return `${slug}-${day}.${ext}`;
}

// ───────────────────────── DOM ─────────────────────────

const visibleText = (node) => {
  const parts = [];
  const walk = (n) => {
    if (n.nodeType === 3) {
      const t = n.nodeValue.replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    } else if (n.nodeType === 1 && !/^(BUTTON|SCRIPT|STYLE|SVG|INPUT|SELECT)$/i.test(n.tagName)) for (const c of n.childNodes) walk(c);
  };
  walk(node);
  return parts.join(" ");
};

/** The header and body rows of a <table> as text, leaving out the columns that hold only actions. Reads the DOM. */
export function tableMatrix(table) {
  const headRow = table.tHead?.rows?.[table.tHead.rows.length - 1];
  const heads = headRow ? [...headRow.cells] : [];
  const skip = new Set();
  heads.forEach((th, i) => {
    if (!th.textContent.trim() || th.querySelector(":scope > .pal-sr-only")) skip.add(i); // the Actions column
  });
  const pick = (cells) => [...cells].map((c, i) => (skip.has(i) ? null : visibleText(c))).filter((c) => c !== null);
  const out = [];
  if (heads.length) out.push(pick(heads));
  for (const body of table.tBodies) for (const tr of body.rows) out.push(pick(tr.cells));
  return out;
}

/** Offer `text` as a file. Blob and anchor only. */
export function downloadText(text, filename, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("aria-hidden", "true");
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** The name an export should carry: the card's heading, else the open page's title. */
function titleFor(wrap) {
  const card = wrap.closest(".card");
  return card?.querySelector(".card-head h2, .card-head h3")?.textContent || wrap.closest("details")?.querySelector("summary")?.textContent || document.getElementById("page-title")?.textContent || "table";
}

/**
 * Put a CSV button and a Copy-as-TSV button above every table that does not have them yet (idempotent: call it after
 * any redraw). `notify(text)` shows the confirmation (the dashboard's toast). Tables with data-noexport are skipped.
 */
export function addExports(root, notify = () => {}) {
  for (const wrap of root.querySelectorAll(".table-wrap")) {
    const table = wrap.querySelector(":scope > table");
    if (!table || table.hasAttribute("data-noexport") || wrap.dataset.export === "1") continue;
    wrap.dataset.export = "1";
    const mk = (label, title, run) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "small export-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", () => run());
      return b;
    };
    const rowsCount = () => table.tBodies[0]?.rows.length ?? 0;
    const bar = document.createElement("div");
    bar.className = "table-tools";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Export this table");
    bar.append(
      mk("CSV", "Download this table as a CSV file", () => {
        downloadText(toCsv(tableMatrix(table)), exportName(titleFor(wrap), "csv"));
        notify(`Downloaded ${rowsCount()} rows as CSV`);
      }),
      mk("Copy TSV", "Copy this table as tab-separated text, ready to paste into a sheet", async () => {
        const ok = await copy(toTsv(tableMatrix(table)));
        notify(ok ? `Copied ${rowsCount()} rows as TSV` : "Could not copy. Use the CSV download instead.");
      }),
    );
    wrap.before(bar);
  }
}
