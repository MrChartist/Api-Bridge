/**
 * The order ticket's preview never prints "null" or "undefined": replaceChildren() turns a null child into the text
 * "null" (docs/HANDOFF.md §6), so every value that can be null (the stop-and-target figures, the risk line) is either
 * spread from a guarded list or passed where h() drops it. A source check over the preview's replaceChildren calls in
 * desk.js: no bare argument may be a name that is ever set to null.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./desk.js", import.meta.url), "utf8");

/** The text of every `previewEl.replaceChildren(...)` call, with balanced parentheses. */
function calls(text, head) {
  const out = [];
  let i = text.indexOf(head);
  while (i >= 0) {
    let depth = 0;
    let j = i + head.length - 1;
    for (; j < text.length; j += 1) {
      if (text[j] === "(") depth += 1;
      else if (text[j] === ")" && --depth === 0) break;
    }
    out.push(text.slice(i + head.length, j));
    i = text.indexOf(head, j);
  }
  return out;
}

/** Top-level comma-separated arguments of a call body. */
function args(body) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

describe("ticket preview", () => {
  const nullable = new Set([...src.matchAll(/const (\w+) =[^;]*?: null;/gs)].map((m) => m[1]));

  it("finds the names that can be null (stop-and-target figures among them)", () => {
    expect(nullable.has("exitFigs")).toBe(true);
    expect(nullable.has("atStop")).toBe(true);
  });

  it("passes no nullable name bare to the preview's replaceChildren, so no null or undefined line shows", () => {
    const bodies = calls(src, "previewEl.replaceChildren(");
    expect(bodies.length).toBeGreaterThan(3);
    const bad = bodies.flatMap(args).filter((a) => nullable.has(a));
    expect(bad).toEqual([]);
    expect(src).toContain("...(exitFigs ? [exitFigs] : [])");
  });
});
