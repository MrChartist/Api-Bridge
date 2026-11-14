// xlsx-core.js: a small Excel workbook writer (Office Open XML in a stored ZIP) with no dependency, for the Bridge's
// workbook download (workbook.js). Pure: it returns bytes. Cells are numbers, text or formulas; formulas carry no
// cached value, so Excel calculates them on open. Defined names (BridgeKey) point at a cell or hold a formula.
//
// Formulas are written the way the FILE format wants them: functions added after Excel 2007 (WEBSERVICE, ENCODEURL,
// NUMBERVALUE, TEXTJOIN ...) must be stored with a "_xlfn." prefix, or Excel shows #NAME? until each cell is edited.
// Write them plain in a cell object ({ f: "=WEBSERVICE(...)" }); prefixNewFunctions() adds the prefix on the way out.
// WEBSERVICE itself exists only in Excel for Windows (Microsoft's function page: not on Mac, not in Excel for the web).

const enc = new TextEncoder();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let CRC_TABLE = null;
/** CRC-32 (IEEE) of bytes, as the ZIP format needs. */
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive with every file stored (no compression). files: [{ name, data: Uint8Array|string }]. */
export function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    // Version 2.0, flag bit 11 (UTF-8 names), method 0 (stored), time and date 1 Jan 2026 00:00.
    const head = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x5c21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    parts.push(Uint8Array.from(head), name, data);
    central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x5c21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += head.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** "A1" for row and column numbers from 0. */
export function cellRef(row, col) {
  let s = "";
  let c = col + 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return `${s}${row + 1}`;
}

/**
 * Functions Excel stores with a prefix in the file because they are newer than Excel 2007: [name, stored prefix].
 * Without the prefix the cell shows #NAME?. (Microsoft: "Issue: an _xlfn. prefix is displayed in front of a formula".)
 */
const NEW_FUNCTIONS = [
  ...["WEBSERVICE", "ENCODEURL", "FILTERXML", "NUMBERVALUE", "TEXTJOIN", "CONCAT", "IFS", "SWITCH", "MAXIFS", "MINIFS", "XLOOKUP", "XMATCH", "TEXTSPLIT", "TEXTBEFORE", "TEXTAFTER", "VSTACK", "HSTACK", "TOCOL", "TOROW", "TAKE", "DROP", "LET", "UNIQUE", "SEQUENCE", "RANDARRAY", "DAYS", "ISOWEEKNUM", "IFNA", "XOR", "ISFORMULA", "SHEET", "SHEETS", "FORMULATEXT", "UNICODE", "UNICHAR", "STDEV.S", "STDEV.P", "VAR.S", "VAR.P", "RANK.EQ", "PERCENTILE.INC", "QUARTILE.INC", "CEILING.MATH", "FLOOR.MATH"].map((n) => [n, "_xlfn."]),
  ...["FILTER", "SORT", "SORTBY"].map((n) => [n, "_xlfn._xlws."]),
];
const PREFIX_OF = new Map(NEW_FUNCTIONS);
const NEW_FUNCTION_RE = new RegExp(`(^|[^A-Za-z0-9_.])(${NEW_FUNCTIONS.map(([n]) => n.replace(".", "\\.")).join("|")})\\(`, "gi");

/**
 * A formula (without the leading "=") with the file-format prefix on every function newer than Excel 2007. Text inside
 * double quotes is left alone, and a function that already carries a prefix is not prefixed twice.
 */
export function prefixNewFunctions(formula) {
  return String(formula)
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) => (i % 2 ? part : part.replace(NEW_FUNCTION_RE, (_m, lead, name) => `${lead}${PREFIX_OF.get(name.toUpperCase())}${name.toUpperCase()}(`)))
    .join("");
}

/** Cell styles a cell can ask for by name: { v, s: "header" } or { f, s: "number" }. Index = position in cellXfs. */
export const STYLES = Object.freeze({ header: 1, title: 2, note: 3, input: 4, warn: 5, number: 6, integer: 7, datetime: 8, wrap: 9, status: 10 });

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/><numFmt numFmtId="165" formatCode="0.00##"/></numFmts><fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="15"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF7"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF7F7F7F"/></bottom><diagonal/></border><border><left style="thin"><color rgb="FFBF9000"/></left><right style="thin"><color rgb="FFBF9000"/></right><top style="thin"><color rgb="FFBF9000"/></top><bottom style="thin"><color rgb="FFBF9000"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="11"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="2" xfId="0" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** The style index of a cell: its own `s` (a name in STYLES), else the header style for a first row when boldFirst. */
function styleAttr(v, r, boldFirst) {
  const name = v && typeof v === "object" ? v.s : undefined;
  const id = name !== undefined ? STYLES[name] : boldFirst && r === 0 ? STYLES.header : undefined;
  return id ? ` s="${id}"` : "";
}

function sheetXml(rows, { widths = [], boldFirst = true, freeze = null, validations = [], tab = null } = {}) {
  const pr = tab ? `<sheetPr><tabColor rgb="${tab}"/></sheetPr>` : "";
  const views = freeze
    ? `<sheetViews><sheetView workbookViewId="0"><pane${freeze.col ? ` xSplit="${freeze.col}"` : ""}${freeze.row ? ` ySplit="${freeze.row}"` : ""} topLeftCell="${cellRef(freeze.row || 0, freeze.col || 0)}" activePane="${freeze.row && freeze.col ? "bottomRight" : freeze.row ? "bottomLeft" : "topRight"}" state="frozen"/></sheetView></sheetViews>`
    : "";
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          if (v === null || v === undefined || v === "") return "";
          const ref = cellRef(r, c);
          const s = styleAttr(v, r, boldFirst);
          if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : "";
          if (typeof v === "object" && v.f) return `<c r="${ref}"${s}><f>${esc(prefixNewFunctions(String(v.f).replace(/^=/, "")))}</f></c>`;
          if (typeof v === "object" && typeof v.v === "number") return Number.isFinite(v.v) ? `<c r="${ref}"${s}><v>${v.v}</v></c>` : "";
          if (typeof v === "object" && v.v === "") return s ? `<c r="${ref}"${s}/>` : "";
          const t = typeof v === "object" ? String(v.v ?? "") : String(v);
          return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(t)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const dv = validations.length
    ? `<dataValidations count="${validations.length}">${validations.map((d) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${esc(d.ref)}"><formula1>${esc(`"${d.list.join(",")}"`)}</formula1></dataValidation>`).join("")}</dataValidations>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pr}${views}${cols}<sheetData>${body}</sheetData>${dv}</worksheet>`;
}

/**
 * A workbook as .xlsx bytes.
 * @param {{ sheets: { name: string, rows: Array<Array<string|number|{ f: string, s?: string }|{ v: string|number, s?: string }|null>>,
 *   widths?: number[], boldFirst?: boolean, freeze?: { row?: number, col?: number }, validations?: { ref: string, list: string[] }[], tab?: string }[],
 *   names?: Record<string, string> }} wb  names: defined name → reference or formula text, e.g. { BridgeKey: "Setup!$B$3" }
 */
export function buildXlsx({ sheets, names = {} }) {
  const ss = sheets.map((s, i) => ({ ...s, name: String(s.name).replace(/[\\/?*[\]:]/g, " ").slice(0, 31), i: i + 1 }));
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${ss.map((s) => `<Override PartName="/xl/worksheets/sheet${s.i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${ss.map((s) => `<sheet name="${esc(s.name)}" sheetId="${s.i}" r:id="rId${s.i}"/>`).join("")}</sheets>${Object.keys(names).length ? `<definedNames>${Object.entries(names).map(([n, ref]) => `<definedName name="${esc(n)}">${esc(prefixNewFunctions(ref))}</definedName>`).join("")}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ss.map((s) => `<Relationship Id="rId${s.i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.i}.xml"/>`).join("")}<Relationship Id="rId${ss.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...ss.map((s) => ({ name: `xl/worksheets/sheet${s.i}.xml`, data: sheetXml(s.rows, { widths: s.widths, boldFirst: s.boldFirst, freeze: s.freeze, validations: s.validations, tab: s.tab }) })),
  ];
  return zipStore(files);
}
