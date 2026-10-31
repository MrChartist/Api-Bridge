// The keyboard shortcuts and glossary sheet ("?" anywhere, the account menu, the palette). One searchable list of
// every shortcut grouped by page, from shortcuts-core.js, and a Glossary tab of options terms in plain words.
import { h, modal } from "./app.js";
import { segmented } from "./views.js";
import { GLOSSARY, filterGlossary, filterShortcuts, groupShortcuts, shortcutRegistry } from "./shortcuts-core.js";

/** One key string ("Ctrl K", "⇧B", "g") as key caps: a chord's parts side by side. */
const caps = (k) => h("span", { class: "kbd-group" }, String(k).split(" ").filter(Boolean).map((p) => h("kbd", { class: "kbd" }, p)));

/**
 * Open the sheet. `ctx`: { mod, pages, goKeys, have } for the registry (palette.js passes them); `group` scrolls to a
 * page's group first (the chain's "?" opens on Option Chain); `tab` "keys" | "glossary".
 */
export function openShortcuts({ mod = "Ctrl", pages = [], goKeys = [], have = {}, group = null, tab = "keys" } = {}) {
  const all = shortcutRegistry({ mod, pages, goKeys, have });
  const seg = segmented("Show", [["keys", "Shortcuts"], ["glossary", "Glossary"]], tab === "glossary" ? "glossary" : "keys");
  seg.classList.add("sc-seg");
  const input = h("input", { type: "search", class: "sc-search", placeholder: "Search shortcuts", "aria-label": "Search shortcuts", autocomplete: "off", spellcheck: "false" });
  const list = h("div", { class: "sc-list", "aria-live": "polite" });
  const empty = (text) => h("p", { class: "muted small sc-empty" }, text);
  const draw = () => {
    const q = input.value;
    if (seg.value === "glossary") {
      input.placeholder = "Search the glossary";
      input.setAttribute("aria-label", "Search the glossary");
      const rows = filterGlossary(q, GLOSSARY);
      list.replaceChildren(rows.length ? h("dl", { class: "sc-gloss" }, rows.map(([t, m]) => h("div", { class: "sc-gloss-row" }, h("dt", {}, t), h("dd", {}, m)))) : empty(`No term matches “${q}”.`));
      return;
    }
    input.placeholder = "Search shortcuts";
    input.setAttribute("aria-label", "Search shortcuts");
    const groups = groupShortcuts(filterShortcuts(all, q));
    list.replaceChildren(
      ...(groups.length
        ? groups.map((g) =>
            h(
              "section",
              { class: "sc-group", "data-group": g.group },
              h("h3", { class: "sc-cap" }, g.group, g.items.every((x) => x.coming) ? h("span", { class: "sc-soon" }, "Coming") : null),
              h(
                "div",
                { class: "sc-rows" },
                g.items.map((e) => h("div", { class: `sc-row${e.coming ? " coming" : ""}` }, h("span", { class: "sc-keys" }, e.keys.map(caps)), h("span", { class: "sc-what" }, e.what))),
              ),
            ),
          )
        : [empty(`No shortcut matches “${q}”.`)]),
    );
  };
  input.addEventListener("input", draw);
  seg.addEventListener("change", () => ((input.value = ""), draw(), input.focus()));
  draw();
  const done = modal({
    title: "Keyboard shortcuts",
    body: h("div", { class: "stack sc-sheet" }, h("div", { class: "sc-head" }, seg, input), list, h("p", { class: "muted small" }, `Some browsers keep ${mod} 1 to ${mod} 9 for switching tabs; the search (${mod} K) always works. Shortcuts never act while you type in a field.`)),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
  // Open on the page's own group, then the search box (typing filters at once).
  requestAnimationFrame(() => {
    // Scroll the list only (scrollIntoView would also scroll the sheet and hide the search above the list).
    const sec = group ? list.querySelector(`[data-group="${CSS.escape(group)}"]`) : null;
    if (sec) list.scrollTop = sec.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    input.focus({ preventScroll: Boolean(group) });
  });
  return done;
}
