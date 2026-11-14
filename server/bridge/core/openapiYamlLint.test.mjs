// docs/openapi.yaml is read by the Bridge's own small reader, which is lenient. Standard tools (Swagger UI, code
// generators, PyYAML) are strict: a plain description or summary that contains ": " is not valid YAML for them. This
// test catches that, so the spec stays usable outside the Bridge.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SPEC = readFileSync(resolve(import.meta.dirname, "../../../docs/openapi.yaml"), "utf8");

describe("docs/openapi.yaml stays valid strict YAML", () => {
  it("has no plain description or summary value that contains ': ' or ' #'", () => {
    const bad = [];
    SPEC.split("\n").forEach((line, i) => {
      const m = /^\s*(?:description|summary):\s+(?!["'|>{\[])(.+)$/.exec(line);
      if (m && /: |\s#/.test(m[1])) bad.push(`line ${i + 1}: ${line.trim().slice(0, 90)}`);
    });
    expect(bad).toEqual([]);
  });
});
