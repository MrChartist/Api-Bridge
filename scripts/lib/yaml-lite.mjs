/**
 * A small YAML reader for the disciplined layout of docs/openapi.yaml (no dependency). It understands block maps and
 * lists, flow maps and lists on one line, quoted and plain scalars, and `|` / `>` block scalars. It does not
 * understand anchors, tags, multi-document files or complex keys, and it throws on a line it cannot place instead of
 * guessing. scripts/yaml-lite.test.mjs holds the cases.
 */

const stripComment = (s) => {
  let quote = null;
  let prev = " ";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
    } else if ((c === '"' || c === "'") && /[\s:\-[{,]/.test(prev) && (i === 0 || /[\s[{,]/.test(s[i - 1]) || prev === ":")) {
      quote = c;
    } else if (c === "#" && /\s/.test(s[i - 1] ?? " ")) {
      return s.slice(0, i).trimEnd();
    }
    if (!/\s/.test(c)) prev = c;
    else if (prev !== " ") prev = " ";
  }
  return s.trimEnd();
};

function scalar(text) {
  const t = text.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t[0] === '"') return JSON.parse(t);
  if (t[0] === "'") return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Parse one flow value starting at `pos`; returns [value, nextPos]. */
function flow(s, pos) {
  const skip = () => { while (pos < s.length && /\s/.test(s[pos])) pos++; };
  skip();
  const c = s[pos];
  if (c === "[") {
    const out = [];
    pos++;
    for (;;) {
      skip();
      if (s[pos] === "]") return [out, pos + 1];
      const [v, p] = flow(s, pos);
      out.push(v);
      pos = p;
      skip();
      if (s[pos] === ",") pos++;
      else if (s[pos] !== "]") throw new Error(`yaml-lite: bad flow list in: ${s}`);
    }
  }
  if (c === "{") {
    const out = {};
    pos++;
    for (;;) {
      skip();
      if (s[pos] === "}") return [out, pos + 1];
      const [k, p] = flowKey(s, pos);
      pos = p;
      skip();
      let v = null;
      if (s[pos] !== "," && s[pos] !== "}") [v, pos] = flow(s, pos);
      out[k] = v;
      skip();
      if (s[pos] === ",") pos++;
      else if (s[pos] !== "}") throw new Error(`yaml-lite: bad flow map in: ${s}`);
    }
  }
  if (c === '"') {
    let i = pos + 1;
    while (s[i] !== '"') { if (s[i] === "\\") i++; i++; if (i > s.length) throw new Error(`yaml-lite: unterminated string in: ${s}`); }
    return [JSON.parse(s.slice(pos, i + 1)), i + 1];
  }
  if (c === "'") {
    let i = pos + 1;
    for (;;) {
      if (s[i] === "'" && s[i + 1] === "'") i += 2;
      else if (s[i] === "'") break;
      else i++;
      if (i > s.length) throw new Error(`yaml-lite: unterminated string in: ${s}`);
    }
    return [s.slice(pos + 1, i).replace(/''/g, "'"), i + 1];
  }
  let i = pos;
  while (i < s.length && !",]}".includes(s[i])) i++;
  return [scalar(s.slice(pos, i)), i];
}

function flowKey(s, pos) {
  if (s[pos] === '"' || s[pos] === "'") {
    const [k, p] = flow(s, pos);
    let q = p;
    while (/\s/.test(s[q])) q++;
    if (s[q] !== ":") throw new Error(`yaml-lite: key without colon in: ${s}`);
    return [String(k), q + 1];
  }
  let i = pos;
  while (i < s.length && !(s[i] === ":" && (s[i + 1] === " " || i + 1 === s.length)) && !",}".includes(s[i])) i++;
  if (s[i] !== ":") return [s.slice(pos, i).trim(), i]; // a key with no value: { a, b }
  return [s.slice(pos, i).trim(), i + 1];
}

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:'"[{#][^:]*?|[^\s:#][^:\s]*)\s*:(?:\s+(.*))?$/;

export function parseYaml(text) {
  const lines = text.replace(/\r/g, "").split("\n").map((raw) => ({ raw, indent: raw.length - raw.trimStart().length }));
  let i = 0;

  const isBlank = (l) => l.raw.trim() === "" || l.raw.trim().startsWith("#");
  const skipBlank = () => { while (i < lines.length && isBlank(lines[i])) i++; };

  function blockScalar(header, parentIndent) {
    const style = header[0];
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const body = [];
    let blockIndent = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.raw.trim() === "") { body.push(""); i++; continue; }
      if (l.indent <= parentIndent) break;
      blockIndent ??= l.indent;
      if (l.indent < blockIndent) break;
      body.push(l.raw.slice(blockIndent));
      i++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") { body.pop(); trailing++; }
    let out;
    if (style === "|") out = body.join("\n");
    else {
      out = "";
      for (let k = 0; k < body.length; k++) {
        if (k === 0) out = body[k];
        else if (body[k] === "") out += "\n";
        else if (body[k - 1] === "") out += body[k];
        else out += (body[k].startsWith(" ") || body[k - 1].startsWith(" ") ? "\n" : " ") + body[k];
      }
    }
    if (chomp === "strip" || body.length === 0) return out;
    if (chomp === "clip") return out + "\n";
    return out + "\n".repeat(trailing + 1);
  }

  /** The value written after `key:` or `- `, on the same line (and its continuation lines). */
  function inlineValue(rest, indent) {
    const t = stripComment(rest);
    if (/^[|>][-+0-9]*$/.test(t)) return blockScalar(t, indent);
    if (t[0] === "[" || t[0] === "{") {
      let joined = t;
      for (;;) {
        try {
          const [v, p] = flow(joined, 0);
          if (joined.slice(p).trim() !== "") throw new Error("trailing text after a flow value");
          return v;
        } catch (e) {
          if (i >= lines.length || !/bad flow|unterminated|undefined/.test(String(e.message) + "undefined")) throw e;
          const next = lines[i++];
          joined += " " + stripComment(next.raw).trim();
          if (joined.length > 5000) throw e;
        }
      }
    }
    if (t[0] === '"' || t[0] === "'") {
      const [v, p] = flow(t, 0);
      if (t.slice(p).trim() !== "") throw new Error(`yaml-lite: text after a quoted value: ${t}`);
      return v;
    }
    // A plain scalar may continue on the following, deeper-indented lines.
    let s = t;
    while (i < lines.length && !isBlank(lines[i]) && lines[i].indent > indent) s += " " + stripComment(lines[i++].raw).trim();
    return scalar(s);
  }

  function block(indent) {
    skipBlank();
    if (i >= lines.length) return null;
    const first = lines[i];
    const body = stripComment(first.raw).trim();
    if (body === "-" || body.startsWith("- ")) return seq(first.indent);
    if (KEY.test(body)) return map(first.indent);
    i++;
    return inlineValue(body, indent);
  }

  function seq(indent) {
    const out = [];
    for (;;) {
      skipBlank();
      if (i >= lines.length || lines[i].indent !== indent) break;
      const body = stripComment(lines[i].raw).trim();
      if (!(body === "-" || body.startsWith("- "))) break;
      const rest = body.slice(1).trim();
      if (rest === "") {
        i++;
        skipBlank();
        out.push(i < lines.length && lines[i].indent > indent ? block(indent) : null);
      } else if (KEY.test(rest)) {
        // "- key: value" opens a map whose keys line up after the dash.
        const at = indent + (lines[i].raw.slice(indent).length - lines[i].raw.slice(indent).replace(/^-\s*/, "").length);
        lines[i] = { raw: " ".repeat(at) + rest, indent: at };
        out.push(map(at));
      } else {
        i++;
        out.push(inlineValue(rest, indent));
      }
    }
    return out;
  }

  function map(indent) {
    const out = {};
    for (;;) {
      skipBlank();
      if (i >= lines.length || lines[i].indent !== indent) break;
      const body = stripComment(lines[i].raw).trim();
      if (body === "-" || body.startsWith("- ")) break;
      const m = KEY.exec(body);
      if (!m) throw new Error(`yaml-lite: cannot read line ${i + 1}: ${lines[i].raw}`);
      const key = m[1][0] === '"' ? JSON.parse(m[1]) : m[1][0] === "'" ? m[1].slice(1, -1).replace(/''/g, "'") : m[1];
      const rest = m[2] ?? "";
      i++;
      if (rest.trim() === "" || rest.trim().startsWith("#")) {
        skipBlank();
        if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && /^-(\s|$)/.test(lines[i].raw.trim())))) out[key] = block(indent);
        else out[key] = null;
      } else out[key] = inlineValue(rest, indent);
    }
    return out;
  }

  const result = block(-1);
  skipBlank();
  if (i < lines.length) throw new Error(`yaml-lite: unexpected content at line ${i + 1}: ${lines[i].raw}`);
  return result;
}
