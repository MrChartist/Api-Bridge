// The Get started checklist on the Accounts page: five short steps from nothing to a working call. It is a card in the
// page (no modal), shown only while something is left to do and hidden for good when the person hides it. Each step's
// done state comes from the Bridge (getstarted-core.js), and the card keeps itself current while the page is open.

import { api, app, codeBlock, currentKey, h, icon, optional, toast } from "./app.js";
import { DISMISS_SLOT, KEY_PLACEHOLDER, accountStepText, SOURCES_SEEN_SLOT, STEP_DONE_TEXT, curlLtp, deriveSteps, newlyDone, shouldShow } from "./getstarted-core.js";

const flag = (slot) => app.local.get(slot) === "1";

// Opening Sources, from anywhere, is what completes step 5 (the dashboard keeps no other record of it).
function noteRoute() {
  if (/^#\/?sources(?:[/?]|$)/i.test(location.hash)) app.local.set(SOURCES_SEEN_SLOT, "1");
}
if (typeof window !== "undefined") {
  noteRoute();
  window.addEventListener("hashchange", noteRoute);
}

/**
 * @param {{ accounts?: object[], keyLink: string, addBroker?: () => void, every?: (fn: () => Promise<void>) => void }} opts
 *   accounts: what the Accounts page already read; keyLink: where step 2 leads; addBroker: opens the add-a-broker flow;
 *   every: starts a repeating refresh that stops with the page.
 * @returns {{ el: HTMLElement, ready: Promise<void>, refresh: () => Promise<void> }}
 */
export function createGetStarted({ accounts = [], keyLink, addBroker, every }) {
  const demo = Boolean(app.state.demo);
  const el = h("div", { class: "gs-wrap" });
  let data = { accounts, keys: undefined, requests: undefined, orders: undefined }; // undefined: not read yet; null: could not be read
  let model = null;
  let dismissed = flag(DISMISS_SLOT);
  let nodes = null;
  const live = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });
  const ownKeyId = () => String(currentKey() ?? "").split("_")[1] ?? null;

  const derive = () => deriveSteps({ demo, ...data, sourcesSeen: flag(SOURCES_SEEN_SLOT), ownKeyId: ownKeyId() });

  const STEP_COPY = {
    account: { title: "Try it with the demo or add your broker", text: accountStepText({ demo, accounts }) },
    key: { title: "Create an API key for your tool", text: "One key per tool, with only the access it needs. You say what will use it and the rest is filled in." },
    call: { title: "Make your first call", text: `Paste this into a terminal and press Enter. Replace ${KEY_PLACEHOLDER} with the key from step 2.${demo ? " In demo mode the prices it returns are samples." : ""}` },
    order: { title: "Place a paper order", text: "A practice order with practice money. The Orders page shows how to send one." },
    sources: { title: "See where data comes from", text: "Sources shows which broker or free source answered your calls and how much room each one has left." },
  };

  function actionFor(id) {
    if (id === "account") return addBroker ? h("button", { type: "button", class: "small tinted", onclick: addBroker }, icon("plus"), "Add a broker") : null;
    const to = { key: [keyLink, "Create a key"], order: ["#/orders", "Open Orders"], sources: ["#/sources", "Open Sources"] }[id];
    return to ? h("a", { class: "btn small tinted", href: to[0] }, to[1]) : null;
  }

  function build() {
    const count = h("span", { class: "gs-count" });
    const fill = h("i");
    const bar = h("div", { class: "gs-bar", role: "progressbar", "aria-labelledby": "gs-h", "aria-valuemin": "0", "aria-valuemax": "5" }, fill);
    const hide = h("button", { type: "button", class: "small plain gs-hide", "aria-label": "Hide the Get started checklist", onclick: dismiss }, "Hide");
    const steps = ["account", "key", "call", "order", "sources"].map((id, i) => {
      const mark = h("span", { class: "gs-mark", "aria-hidden": "true" });
      const state = h("span", { class: "gs-state" });
      const action = actionFor(id);
      const extra = id === "call" ? h("div", { class: "gs-curl" }, codeBlock(curlLtp({ base: location.origin }), { title: "Terminal (curl)" }), h("p", { class: "gs-wait", "data-for": "call" })) : null;
      const li = h(
        "li",
        { class: "gs-step", "data-step": id },
        mark,
        h("div", { class: "gs-main" }, h("h3", { class: "gs-title" }, h("span", {}, STEP_COPY[id].title), state), h("p", { class: "gs-text" }, STEP_COPY[id].text), extra, action ? h("div", { class: "gs-act" }, action) : null),
      );
      return { id, li, mark, state, action, n: i + 1, wait: extra?.querySelector(".gs-wait") ?? null, text: li.querySelector(".gs-text") };
    });
    const card = h(
      "section",
      { class: "card gs", "aria-labelledby": "gs-h" },
      h("header", { class: "gs-head" }, h("div", { class: "gs-titles" }, h("h2", { id: "gs-h" }, demo ? "Get started (demo)" : "Get started"), h("p", {}, "Five short steps from nothing to your first working call.")), h("div", { class: "gs-side" }, count, hide)),
      bar,
      h("ol", { class: "gs-steps" }, steps.map((s) => s.li)),
      h("p", { class: "gs-more hint" }, "Optional: ", h("a", { href: "#/api/integrations?tool=telegram" }, "get alerts and prices on your phone with Telegram"), "."),
      live,
    );
    nodes = { card, count, fill, bar, steps };
    return card;
  }

  function paint(prev) {
    if (!nodes) return;
    for (const s of nodes.steps) {
      const st = model.steps.find((x) => x.id === s.id);
      s.li.dataset.done = st.done ? "1" : "0";
      s.li.dataset.current = model.current === s.id ? "1" : "0";
      s.mark.replaceChildren(st.done ? icon("check") : document.createTextNode(String(s.n)));
      s.state.textContent = st.done ? "Done" : "";
      s.state.hidden = !st.done;
      if (s.id === "account") s.text.textContent = accountStepText({ demo, accounts: data.accounts });
      if (s.action) s.action.hidden = st.done;
      if (s.wait) s.wait.textContent = st.done ? "A tool outside the dashboard has called the Bridge." : data.requests === null ? "The request log could not be read with this key, so this step cannot tick itself." : "Waiting for a call from outside the dashboard. This ticks by itself when it arrives.";
    }
    nodes.count.textContent = model.progress;
    nodes.fill.style.width = `${(model.doneCount / model.total) * 100}%`;
    nodes.bar.setAttribute("aria-valuenow", String(model.doneCount));
    nodes.bar.setAttribute("aria-valuetext", `${model.progress} steps done`);
    const fresh = newlyDone(prev, model);
    if (fresh.length) live.textContent = fresh.map((id) => STEP_DONE_TEXT[id]).join(" ");
  }

  function draw() {
    const prev = model;
    model = derive();
    if (!shouldShow({ dismissed, complete: model.complete })) {
      nodes = null;
      // Hidden by choice but not finished: one quiet way back, at the same place.
      el.replaceChildren(dismissed && !model.complete ? h("button", { type: "button", class: "small plain gs-show", onclick: restore }, "Show the Get started checklist") : "");
      return;
    }
    if (!nodes || !el.contains(nodes.card)) el.replaceChildren(build());
    paint(prev);
  }

  function dismiss() {
    dismissed = true;
    app.local.set(DISMISS_SLOT, "1");
    draw();
    document.getElementById("acct-h-accounts")?.focus?.({ preventScroll: true });
    toast("Checklist hidden. You can show it again at the top of this page.");
  }
  function restore() {
    dismissed = false;
    app.local.set(DISMISS_SLOT, null);
    draw();
    el.querySelector(".gs-hide")?.focus?.({ preventScroll: true });
  }

  async function refresh() {
    if (document.hidden) return;
    const [a, k, r, o] = await Promise.all([optional(api("/v1/accounts", { fresh: true })), optional(api("/v1/keys", { fresh: true })), optional(api("/v1/requests?limit=200", { fresh: true })), optional(api("/v1/orders?limit=1", { fresh: true }))]);
    data = { accounts: a.error ? data.accounts : (a.data?.data ?? []), keys: k.error ? null : (k.data?.data ?? []), requests: r.error ? null : (r.data?.data ?? []), orders: o.error ? null : (o.data?.data ?? []) };
    draw();
  }

  draw();
  const ready = refresh().catch(() => {});
  every?.(refresh);
  return { el, ready, refresh };
}
