/**
 * A small reader for the `curl` commands in the docs: line continuations, single and double quotes, `-X`, `-H`, `-d`,
 * `-s`/`-i`/`-N` and the URL. It does not run a shell: `$NAME` is left in place for the caller to replace.
 */

/** Split a shell-like command line into words (quotes removed, `\` + newline joined). */
export function shellWords(text) {
  const src = text.replace(/\\\r?\n/g, " ");
  const words = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated ' in: ${text}`);
      cur += src.slice(i + 1, end);
      has = true;
      i = end;
    } else if (c === '"') {
      i++;
      while (src[i] !== '"') {
        if (i >= src.length) throw new Error(`unterminated " in: ${text}`);
        if (src[i] === "\\" && '"\\$`'.includes(src[i + 1])) i++;
        cur += src[i++];
      }
      has = true;
    } else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

/** @returns {{ method: string, url: string, headers: Record<string, string>, body: string|null }} */
export function parseCurl(text) {
  const w = shellWords(text.trim());
  if (w[0] !== "curl") throw new Error(`not a curl command: ${text.slice(0, 60)}`);
  let method = null;
  let url = null;
  let body = null;
  const headers = {};
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (a === "-X" || a === "--request") method = w[++i];
    else if (a === "-H" || a === "--header") {
      const h = w[++i];
      const at = h.indexOf(":");
      headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
    } else if (a === "-d" || a === "--data" || a === "--data-raw") body = w[++i];
    else if (/^-[siNL]+$/.test(a) || a === "--silent") continue;
    else if (a.startsWith("-")) throw new Error(`curl option not understood by the docs test: ${a}`);
    else url = a;
  }
  if (!url) throw new Error(`no URL in: ${text.slice(0, 60)}`);
  return { method: method ?? (body === null ? "GET" : "POST"), url, headers, body };
}

/** Every `curl ...` command in the ```bash and ```sh fences of a Markdown text (continuation lines joined). */
export function curlCommands(markdown) {
  const out = [];
  for (const m of markdown.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
    let cur = null;
    for (const line of m[1].split("\n")) {
      if (cur !== null) {
        cur += `\n${line}`;
        if (!/\\\s*$/.test(line)) { out.push(cur); cur = null; }
      } else if (/^curl\s/.test(line)) {
        if (/\\\s*$/.test(line)) cur = line;
        else out.push(line);
      }
    }
  }
  return out;
}
