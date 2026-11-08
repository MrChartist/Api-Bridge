/**
 * The stylesheets must parse the way they read: a comment that is never closed silently turns the next rules into
 * comment text (a merge once did this to .card and .glass), so every comment closes and every brace pairs up.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

for (const file of ["app.css", "palette.css"]) {
  describe(`${file} syntax`, () => {
    const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

    it("opens and closes every comment, never nested", () => {
      let open = false;
      for (const m of css.matchAll(/\/\*|\*\//g)) {
        const line = css.slice(0, m.index).split("\n").length;
        if (m[0] === "/*") {
          expect(open, `comment opened inside a comment at line ${line}`).toBe(false);
          open = true;
        } else {
          expect(open, `stray comment end at line ${line}`).toBe(true);
          open = false;
        }
      }
      expect(open, "the last comment is closed").toBe(false);
    });

    it("pairs every brace", () => {
      const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code.split("{").length).toBe(code.split("}").length);
    });
  });
}
