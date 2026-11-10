/** Small table helpers: rows of CSV or JSON-lines files as objects, and CSV text from objects (no dependencies). */

function coerce(v) {
  if (v === "") return null;
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Split CSV text into rows of cells (quotes, doubled quotes and line breaks inside quotes are handled). */
function csvCells(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/**
 * Rows of a downloaded or recorded file as objects. `fmt` is "csv" or "jsonl". In CSV, numbers become numbers, empty
 * cells null, everything else (times, symbols) stays text. A leading byte-order mark is ignored.
 * @param {string} text
 * @param {"csv"|"jsonl"} [fmt]
 * @returns {Array<Record<string, any>>}
 */
export function parseTable(text, fmt = "csv") {
  text = text.replace(/^﻿/, "");
  if (fmt === "jsonl") return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (fmt !== "csv") throw new TypeError(`fmt must be csv or jsonl, not ${JSON.stringify(fmt)}`);
  const [head, ...rows] = csvCells(text);
  if (!head) return [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, coerce(r[i] ?? "")])));
}

/**
 * CSV text from an array of flat objects (header from the first row's keys unless `columns` is given). Lines end with \n.
 * @param {Array<Record<string, any>>} rows
 * @param {string[]} [columns]
 */
export function toCsv(rows, columns) {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n")}\n`;
}
