/** Small Markdown helpers for the search index and llms files (no dependencies). */

/** Lines of `md` outside fenced code blocks. */
export function proseLines(md) {
  const out = [];
  let fence = false;
  for (const line of md.replace(/\r/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (!fence) out.push(line);
  }
  return out;
}

const plain = (s) => s
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/`([^`]*)`/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
  .replace(/\s+/g, " ")
  .trim();

export const plainText = plain;

export function titleOf(md, fallback) {
  const h = proseLines(md).find((l) => /^# \S/.test(l));
  return h ? plain(h.slice(2)) : fallback;
}

/** Headings (levels 2 to 4) as plain text, in order. */
export function headingsOf(md) {
  return proseLines(md).filter((l) => /^#{2,4} \S/.test(l)).map((l) => plain(l.replace(/^#+\s+/, "")));
}

/** The first paragraphs of prose (no headings, tables or code), cut at a word boundary near `max` characters. */
export function snippetOf(md, max = 280) {
  const paras = [];
  let cur = [];
  const flush = () => { if (cur.length) paras.push(cur.join(" ")); cur = []; };
  for (const line of proseLines(md)) {
    if (!line.trim()) flush();
    else if (/^#{1,6}\s/.test(line) || /^\s*\|/.test(line) || /^---+$/.test(line.trim())) flush();
    else cur.push(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
  }
  flush();
  let text = "";
  for (const p of paras) {
    const t = plain(p);
    if (!t) continue;
    text = text ? `${text} ${t}` : t;
    if (text.length >= max) break;
  }
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max)}...`;
}
