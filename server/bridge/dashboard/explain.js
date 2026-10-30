// explain.js: the "Explain this" box on OI Analysis and Volatility. A folded <details> that lists, in plain words,
// what the page's numbers say now (explain-core.js writes the sentences; neutral copy, context not advice). Its open
// state is remembered per page.
import { app, h } from "./app.js";
import { EXPLAIN_NOTE } from "./explain-core.js";

/** @param {string} page "oi" | "vol" @returns {{ el: HTMLElement, set: (items: { key: string, text: string }[]) => void }} */
export function explainBox(page) {
  const slot = `mcb.dashboard.explain.${page}`;
  const list = h("ul", { class: "ex-list" });
  const el = h("details", { class: "ex-box" }, h("summary", { class: "ex-sum" }, h("span", { class: "ex-title" }, "Explain this"), h("span", { class: "ex-hint" }, "What these numbers say now, in plain words")), list, h("p", { class: "ex-note" }, EXPLAIN_NOTE));
  try {
    el.open = app.local.get(slot) === "1";
  } catch {
    // Folded by default.
  }
  el.addEventListener("toggle", () => {
    try {
      app.local.set(slot, el.open ? "1" : "0");
    } catch {
      // Not remembered in this browser.
    }
  });
  let sig = "";
  return {
    el,
    set(items) {
      const s = JSON.stringify(items);
      if (s === sig) return;
      sig = s;
      el.hidden = !items.length;
      list.replaceChildren(...items.map((x) => h("li", { "data-key": x.key }, x.text)));
    },
  };
}
