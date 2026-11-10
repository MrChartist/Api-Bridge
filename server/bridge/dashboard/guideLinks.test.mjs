// The dashboard's "Guide" links: all built in one place (format.js guideUrl), and every guide they name exists.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE_REF, guideUrl } from "./format.js";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..", "..");
const files = readdirSync(HERE).filter((f) => f.endsWith(".js"));
const text = (f) => readFileSync(join(HERE, f), "utf8");

describe("dashboard guide links", () => {
  it("are built by guideUrl, so one line decides which version of the guides they open", () => {
    expect(guideUrl("telegram")).toBe(`https://github.com/MrChartist/api-bridge-v2/blob/${GUIDE_REF}/docs/guides/telegram.md`);
    expect(guideUrl("webhooks", "#tradingview")).toMatch(/webhooks\.md#tradingview$/);
    for (const f of files.filter((x) => x !== "format.js")) expect(text(f), `${f} builds its own guide address`).not.toMatch(/github\.com\/MrChartist\/api-bridge-v2\/blob/);
  });

  it("never tell a person in a checkout to type a bare mc-bridge command (it is not on their PATH)", () => {
    // The Bridge says which form fits this setup (meta.cliCommand). A fixed `mc-bridge <command>` in a message is only
    // allowed with the checkout form beside it, as a server-supplied default, or in a comment.
    const bad = [];
    for (const f of files) {
      text(f).split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!/\bmc-bridge (kill|backup|open|restore|keys|doctor|accounts|init|start|expose)\b/.test(line)) return;
        if (/npm run bridge|\?\? "mc-bridge|\|\| "mc-bridge/.test(line)) return;
        bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("name only guides that exist", () => {
    const names = new Set();
    for (const f of files) {
      for (const m of text(f).matchAll(/guideUrl\("([a-z-]+)"/g)) names.add(m[1]);
      for (const m of text(f).matchAll(/\bguide\("([a-z-]+)"/g)) names.add(m[1]);
      for (const m of text(f).matchAll(/\bGUIDE\("([a-z-]+)"/g)) names.add(m[1]);
    }
    const map = /const GUIDES = \{([^}]*)\}/.exec(text("views.js"))?.[1] ?? "";
    for (const m of map.matchAll(/:\s*"([a-z-]+)"/g)) names.add(m[1]);
    expect(names.size).toBeGreaterThan(8);
    for (const n of names) expect(existsSync(join(ROOT, "docs/guides", `${n}.md`)), `docs/guides/${n}.md`).toBe(true);
  });
});
