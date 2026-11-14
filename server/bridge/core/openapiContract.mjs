/**
 * A small, readable snapshot of the public contract in docs/openapi.yaml, used by openapiGuard.test.mjs to keep the
 * versioning promise (docs/guides/developers.md): under /v1 nothing is removed or renamed, and a route's request or
 * response does not change shape without someone meaning it.
 *
 * What it records, per operation: the operationId, the scope, the parameters (name, where, required), the request body
 * (is it required, which named schemas it uses, its inline `required` lists) and the same for the 2xx responses; and, per
 * named schema, its `required` list. It is a line reader for the disciplined layout of the spec (the same approach as
 * openapi.test.mjs), not a YAML parser: no new dependency.
 */

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === "" || line.trimStart().startsWith("#");

/** The lines after `lines[i]` that are indented deeper than it. */
function childrenOf(lines, i) {
  const base = indentOf(lines[i]);
  const out = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (isBlank(lines[j])) continue;
    if (indentOf(lines[j]) <= base) break;
    out.push(lines[j]);
  }
  return out;
}

const listOf = (text) =>
  text
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .sort()
    .join(",");

/** `required: [a, b]` lists, in the order they appear, as "a,b" (sorted inside). */
function requiredLists(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const flow = /^\s*(?:- )?required:\s*\[(.*)\]\s*(?:#.*)?$/.exec(lines[i]);
    if (flow) {
      out.push(listOf(flow[1]));
      continue;
    }
    if (/^\s*required:\s*$/.test(lines[i])) {
      const items = [];
      const base = indentOf(lines[i]);
      for (let j = i + 1; j < lines.length && /^\s*- /.test(lines[j]) && indentOf(lines[j]) >= base; j += 1) items.push(lines[j].replace(/^\s*- /, ""));
      out.push(listOf(items.join(",")));
    }
  }
  return out;
}

const schemaRefs = (lines) => [...new Set(lines.flatMap((l) => [...l.matchAll(/\$ref:\s*["']?#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map((m) => m[1])))].sort();

/** "name:in" with "!" when required, or "$ref:Name". */
function parametersOf(lines, i) {
  const items = [];
  const kids = childrenOf(lines, i);
  let cur = null;
  const itemIndent = kids.length ? indentOf(kids[0]) : 0;
  for (const l of kids) {
    if (indentOf(l) === itemIndent && l.trimStart().startsWith("- ")) {
      cur = [l];
      items.push(cur);
    } else if (cur) cur.push(l);
  }
  return items.map((item) => {
    const text = item.join(" ");
    const ref = /\$ref:\s*["']?#\/components\/parameters\/([A-Za-z0-9_]+)/.exec(text);
    if (ref) return `$ref:${ref[1]}`;
    const name = /\bname:\s*["']?([^\s,"'}]+)/.exec(text)?.[1] ?? "?";
    const where = /\bin:\s*["']?(\w+)/.exec(text)?.[1] ?? "?";
    const required = where === "path" || /\brequired:\s*true\b/.test(text);
    return `${name}:${where}${required ? "!" : ""}`;
  });
}

function sectionOf(blockLines, key, baseIndent) {
  for (let i = 0; i < blockLines.length; i += 1) {
    if (indentOf(blockLines[i]) === baseIndent && new RegExp(`^\\s*${key}:\\s*$`).test(blockLines[i])) return { at: i, lines: childrenOf(blockLines, i) };
  }
  return null;
}

/**
 * @param {string} text the spec
 * @returns {{ operations: Map<string, object>, schemas: Map<string, string> }} operations keyed "METHOD /path"
 */
export function extractContract(text) {
  const lines = text.split("\n");
  const operations = new Map();
  const schemas = new Map();
  const pathParams = new Map();
  let section = null;
  let path = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlank(line)) continue;
    if (/^\S/.test(line)) section = /^paths:/.test(line) ? "paths" : /^components:/.test(line) ? "components" : null;
    if (section === "paths") {
      const p = /^ {2}(\/\S*):\s*$/.exec(line);
      if (p) {
        path = p[1];
        continue;
      }
      if (path && /^ {4}parameters:\s*$/.test(line)) pathParams.set(path, parametersOf(lines, i));
      const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
      if (m && path) {
        const block = [line, ...childrenOf(lines, i)];
        const op = { operationId: /^\s{6}operationId:\s*(\S+)/m.exec(block.join("\n"))?.[1] ?? null, scope: /^\s{6}x-scope:\s*(\S+)/m.exec(block.join("\n"))?.[1] ?? null, params: [], body: null, responses: {} };
        const pi = block.findIndex((l) => /^ {6}parameters:\s*$/.test(l));
        if (pi >= 0) op.params = parametersOf(block, pi);
        const rb = sectionOf(block, "requestBody", 6);
        if (rb) op.body = { required: /^\s*required:\s*true\b/m.test(rb.lines.join("\n")), schemas: schemaRefs(rb.lines), requiredLists: requiredLists(rb.lines) };
        const rs = sectionOf(block, "responses", 6);
        if (rs) {
          for (let k = 0; k < rs.lines.length; k += 1) {
            const code = /^ {8}["']?(2\d\d)["']?:/.exec(rs.lines[k]);
            if (!code) continue;
            const mine = [rs.lines[k], ...childrenOf(rs.lines, k)];
            op.responses[code[1]] = { schemas: schemaRefs(mine), requiredLists: requiredLists(mine) };
          }
        }
        operations.set(`${m[1].toUpperCase()} ${path}`, op);
      }
    } else if (section === "components" && /^ {2}schemas:\s*$/.test(line)) {
      const kids = childrenOf(lines, i);
      for (let k = 0; k < kids.length; k += 1) {
        const name = /^ {4}([A-Za-z0-9_]+):\s*$/.exec(kids[k]);
        if (!name) continue;
        const body = childrenOf(kids, k).filter((l) => indentOf(l) === 6 || /^ {8}- /.test(l));
        const own = requiredLists(body.filter((l) => /^ {6}required:/.test(l) || /^ {8}- /.test(l)));
        schemas.set(name[1], own[0] ?? "");
      }
    }
  }
  // Path-level parameters apply to every operation of the path.
  for (const [key, op] of operations) {
    const p = key.slice(key.indexOf(" ") + 1);
    if (pathParams.has(p)) op.params = [...pathParams.get(p), ...op.params];
  }
  return { operations, schemas };
}

/** One JSON line per operation or schema, sorted: the committed baseline (easy to read in a diff). */
export function renderContract({ operations, schemas }) {
  const out = [];
  for (const [key, op] of [...operations].sort((a, b) => a[0].localeCompare(b[0]))) out.push(JSON.stringify({ op: key, id: op.operationId, scope: op.scope, params: [...op.params].sort(), body: op.body, responses: op.responses }));
  for (const [name, required] of [...schemas].sort((a, b) => a[0].localeCompare(b[0]))) out.push(JSON.stringify({ schema: name, required }));
  return `${out.join("\n")}\n`;
}

/** @returns {{ operations: Map<string, any>, schemas: Map<string, string> }} the baseline read back */
export function parseBaseline(text) {
  const operations = new Map();
  const schemas = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.op) operations.set(row.op, { operationId: row.id, scope: row.scope, params: row.params, body: row.body, responses: row.responses });
    else if (row.schema) schemas.set(row.schema, row.required);
  }
  return { operations, schemas };
}

/**
 * What changed against the baseline that the versioning promise forbids, in words. Additions (a new route, a new optional
 * parameter, a new response schema, a new named schema) are fine; anything that existed and now differs is reported.
 * @returns {string[]}
 */
export function breakingChanges(baseline, current) {
  const out = [];
  for (const [key, was] of baseline.operations) {
    const now = current.operations.get(key);
    if (!now) {
      out.push(`${key}: the route is gone (or its path or method changed)`);
      continue;
    }
    if (now.operationId !== was.operationId) out.push(`${key}: operationId ${was.operationId} is now ${now.operationId}`);
    if (now.scope !== was.scope) out.push(`${key}: scope ${was.scope} is now ${now.scope}`);
    const nowParams = new Map(now.params.map((x) => [x.replace(/!$/, ""), x.endsWith("!")]));
    for (const x of was.params) {
      const name = x.replace(/!$/, "");
      if (!nowParams.has(name)) out.push(`${key}: parameter ${name} was removed`);
      else if (nowParams.get(name) && !x.endsWith("!")) out.push(`${key}: parameter ${name} is now required`);
    }
    const wasNames = new Set(was.params.map((x) => x.replace(/!$/, "")));
    for (const [name, required] of nowParams) if (required && !wasNames.has(name)) out.push(`${key}: a new parameter ${name} is required`);
    if (was.body && !now.body) out.push(`${key}: the request body was removed`);
    if (!was.body && now.body?.required) out.push(`${key}: a request body is now required`);
    if (was.body && now.body) {
      if (!was.body.required && now.body.required) out.push(`${key}: the request body is now required`);
      for (const sc of was.body.schemas) if (!now.body.schemas.includes(sc)) out.push(`${key}: the request no longer uses schema ${sc}`);
      if (JSON.stringify(was.body.requiredLists) !== JSON.stringify(now.body.requiredLists)) out.push(`${key}: the request's required fields changed (${was.body.requiredLists.join(" ; ") || "none"} -> ${now.body.requiredLists.join(" ; ") || "none"})`);
    }
    for (const [code, r] of Object.entries(was.responses)) {
      const nr = now.responses[code];
      if (!nr) {
        out.push(`${key}: the ${code} response is gone`);
        continue;
      }
      for (const sc of r.schemas) if (!nr.schemas.includes(sc)) out.push(`${key}: the ${code} response no longer uses schema ${sc}`);
      if (JSON.stringify(r.requiredLists) !== JSON.stringify(nr.requiredLists)) out.push(`${key}: the ${code} response's required fields changed (${r.requiredLists.join(" ; ") || "none"} -> ${nr.requiredLists.join(" ; ") || "none"})`);
    }
  }
  for (const [name, required] of baseline.schemas) {
    if (!current.schemas.has(name)) out.push(`schema ${name}: removed`);
    else if (current.schemas.get(name) !== required) out.push(`schema ${name}: required fields changed (${required || "none"} -> ${current.schemas.get(name) || "none"})`);
  }
  return out;
}
