// index.html preloads the modules every page needs, so they load in parallel instead of one import level at a time.
// The list is derived here from the real import graph: when a module is added to (or dropped from) what app.js or
// views.js import, this test fails until index.html says the same.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBOARD_FILES } from "../core/app.mjs";

const here = import.meta.dirname;
const read = (f) => readFileSync(resolve(here, f), "utf8");

/** The relative modules a file imports statically (`import ... from "./x.js"`, `import "./x.js"`, `export ... from`), multi-line included. */
const staticImports = (f) => [...read(f).matchAll(/(?:\bfrom\s+|^\s*import\s+)"\.\/([^"]+\.js)"/gm)].map((m) => m[1]);
/** The relative modules a file imports dynamically with a literal path (`import("./x.js")`). */
const dynamicImports = (f) => [...read(f).matchAll(/\bimport\(\s*"\.\/([^"]+\.js)"\s*\)/g)].map((m) => m[1]);

/** A file and everything it imports statically, transitively. */
function closure(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const dep of staticImports(entry)) closure(dep, seen);
  return seen;
}

/**
 * Dynamic imports that the first page after sign-in always makes (Accounts is the landing page): preloaded too, because
 * every visit to the dashboard pays for them.
 */
const LANDING_PAGE_DYNAMIC = ["today-core.js"];

const html = read("index.html");
const preloaded = [...html.matchAll(/<link\s+rel="modulepreload"\s+href="\/dashboard\/([^"]+)"[^>]*>/g)].map((m) => m[1]);

describe("modulepreload list in index.html", () => {
  // app.js is loaded by its own <script>; views.js is imported dynamically by app.js once the key is checked, so its
  // whole static graph is needed on every signed-in load.
  const needed = new Set([...closure("app.js"), ...closure("views.js"), ...LANDING_PAGE_DYNAMIC]);
  needed.delete("app.js");

  it("lists every module every page needs", () => {
    const missing = [...needed].filter((f) => !preloaded.includes(f));
    expect(missing, `add <link rel="modulepreload" href="/dashboard/…"> for these to index.html`).toEqual([]);
  });

  it("lists nothing that is not needed (lazy pages must stay lazy)", () => {
    const extra = preloaded.filter((f) => !needed.has(f));
    expect(extra, "these are not in the import graph of app.js and views.js any more, or only load on one page").toEqual([]);
  });

  it("lists each module once, and none that the server would refuse", () => {
    expect(new Set(preloaded).size).toBe(preloaded.length);
    for (const f of preloaded) expect(Object.hasOwn(DASHBOARD_FILES, f), `${f} is in DASHBOARD_FILES`).toBe(true);
  });

  it("the landing page's dynamic imports are still real", () => {
    const all = new Set([...needed].flatMap((f) => dynamicImports(f)));
    for (const f of LANDING_PAGE_DYNAMIC) expect(all.has(f), `${f} is imported dynamically by a preloaded module`).toBe(true);
  });

  it("page-only modules are not preloaded", () => {
    for (const f of ["sources-page.js", "sources-providers.js", "quotas-view.js", "workbook.js", "workbook-core.js", "xlsx-core.js"]) expect(preloaded).not.toContain(f);
  });

  it("what only the pages need waits in a template that boot.js opens, so the sign-in screen's first paint is not delayed", () => {
    const template = /<template id="views-preload">([\s\S]*?)<\/template>/.exec(html);
    expect(template, "index.html has the views-preload template").not.toBeNull();
    const inTemplate = [...template[1].matchAll(/href="\/dashboard\/([^"]+)"/g)].map((m) => m[1]);
    const direct = [...html.replace(template[0], "").matchAll(/<link\s+rel="modulepreload"\s+href="\/dashboard\/([^"]+)"/g)].map((m) => m[1]);
    // The direct links are exactly what app.js imports; the template holds the rest of the graph.
    expect(direct.sort()).toEqual([...staticImports("app.js")].sort());
    expect(inTemplate.length).toBeGreaterThan(5);
    expect([...direct, ...inTemplate].sort()).toEqual([...preloaded].sort());
    expect(html.indexOf('<template id="views-preload">')).toBeLessThan(html.indexOf('src="/dashboard/boot.js"'));
    expect(read("boot.js")).toContain('"views-preload"');
  });

  it("the first group (what app.js imports) is at normal priority, the rest low", () => {
    const first = new Set(staticImports("app.js"));
    for (const m of html.matchAll(/<link\s+rel="modulepreload"\s+href="\/dashboard\/([^"]+)"([^>]*)>/g)) {
      const low = /fetchpriority="low"/.test(m[2]);
      expect(low, m[1]).toBe(!first.has(m[1]));
    }
  });
});

describe("first paint", () => {
  it("boot.js is a classic script before the module script, and the module script is high priority", () => {
    const boot = html.indexOf('<script src="/dashboard/boot.js"></script>');
    const app = html.indexOf('<script type="module" src="/dashboard/app.js" fetchpriority="high"></script>');
    expect(boot).toBeGreaterThan(0);
    expect(app).toBeGreaterThan(boot);
    expect(html.indexOf("</head>")).toBeGreaterThan(app);
    // No inline script anywhere: the CSP is script-src 'self'.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it("boot.js only reads storage and sets attributes: no network, no imports", () => {
    const src = read("boot.js");
    expect(src).not.toMatch(/\b(fetch|XMLHttpRequest|import|eval|innerHTML)\b/);
    expect(src).toContain("data-early");
    expect(src).toContain("mcb.dashboard.key");
  });

  it("every image tag the pages draw for a broker logo is lazy and sized (no layout shift)", () => {
    for (const f of ["views.js", "sources-ui.js"]) {
      const src = read(f);
      let n = 0;
      for (const m of src.matchAll(/h\("img",/g)) {
        // The attribute object ends at the first "onerror" or the closing of the call; 400 characters cover both tags.
        const tag = src.slice(m.index, m.index + 400);
        n += 1;
        expect(tag, `${f} img #${n}`).toMatch(/loading: "lazy"/);
        expect(tag, `${f} img #${n}`).toMatch(/width: \d+/);
        expect(tag, `${f} img #${n}`).toMatch(/height: \d+/);
      }
      expect(n, `${f} draws a logo`).toBeGreaterThan(0);
    }
  });
});
