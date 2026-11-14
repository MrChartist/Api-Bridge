// The Get started checklist on the Accounts page: five short steps from nothing to a working call. It is a card in the
// page (no modal), shown only while something is left to do and hidden for good when the person hides it. Each step's
// done state comes from the Bridge (getstarted-core.js), and the card keeps itself current while the page is open.

import { api, app, codeBlock, currentKey, h, icon, optional, toast } from "./app.js";
import { GOALS, GOAL_SLOT, KEY_PLACEHOLDER, accountStepText, SOURCES_SEEN_SLOT, curlLtp, deriveGoal, dismissSlot, goalById, newlyDone, shouldShow, stepDoneText } from "./getstarted-core.js";

const flag = (slot) => app.local.get(slot) === "1";
const savedGoal = () => {
  const g = app.local.get(GOAL_SLOT);
  return goalById(g) ? g : null;
};

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
  let data = { accounts, keys: undefined, requests: undefined, orders: undefined, downloads: undefined, rules: undefined, recordings: undefined, subs: undefined }; // undefined: not read yet; null: could not be read
  let model = null;
  let goal = savedGoal();
  let dismissed = goal ? flag(dismissSlot(goal)) : false;
  let nodes = null;
  const live = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });
  const ownKeyId = () => String(currentKey() ?? "").split("_")[1] ?? null;

  const derive = () => deriveGoal(goal ?? "api", { demo, ...data, sourcesSeen: flag(SOURCES_SEEN_SLOT), ownKeyId: ownKeyId() });

  const STEP_COPY = {
    account: { title: "Try it with the demo or add your broker", text: accountStepText({ demo, accounts }) },
    key: { title: "Create an API key for your tool", text: "One key per tool, with only the access it needs. You say what will use it and the rest is filled in." },
    call: { title: "Make your first call", text: `Paste this into a terminal and press Enter. Replace ${KEY_PLACEHOLDER} with the key from step 2.${demo ? " In demo mode the prices it returns are samples." : ""}` },
    order: { title: "Place a paper order", text: "A practice order with practice money. The Orders page shows how to send one." },
    sources: { title: "See where data comes from", text: "Sources shows which broker or free source answered your calls and how much room each one has left." },
    excelKey: { title: "Make a key for Excel or Sheets", text: "Connect a tool makes a read-only key that expires, and gives you a ready workbook with the key already in it." },
    excel: { title: "Open the workbook", text: "Download it from Connect a tool and open it in Excel, or paste the formula. This ticks by itself when a spreadsheet asks the Bridge for a price." },
    download: { title: "Start a download", text: "Pick symbols, bar size and dates. The Bridge saves them as files on this computer and shows the size and time first." },
    files: { title: "Open your files", text: "When a download finishes its files are listed with a Download button each. This ticks when the first one is done." },
    rule: { title: "Turn on a recording", text: "One click records NIFTY and BANKNIFTY option chains every trading day, by itself. Brokers do not give this history later, so it has to be saved as it happens." },
    recorded: { title: "See the first file", text: "Recording starts at the next market session. This ticks when the first file has been written." },
    receiver: { title: "Add a receiver", text: "The address of your program. The Bridge sends it a signed message when something happens. A message can never place or approve an order." },
    delivered: { title: "Send a test message", text: "Open the receiver and press Send a test message. This ticks when the first message gets through." },
  };
  const LINKS = {
    key: [null, "Create a key"], order: ["#/orders", "Open Orders"], sources: ["#/sources", "Open Sources"],
    excelKey: ["#/connect?tool=excel", "Make the key"], excel: ["#/connect?tool=excel", "Open Connect a tool"],
    download: ["#/data/downloads", "Open Data"], files: ["#/data/downloads", "Open Data"],
    rule: ["#/data/recordings", "Open Recordings"], recorded: ["#/data/recordings", "Open Recordings"],
    receiver: ["#/developers?view=events", "Open Events"], delivered: ["#/developers?view=events", "Open Events"],
  };

  function actionFor(id) {
    if (id === "account") return addBroker ? h("button", { type: "button", class: "small tinted", onclick: addBroker }, icon("plus"), "Add a broker") : null;
    const to = LINKS[id];
    if (!to) return null;
    return h("a", { class: "btn small tinted", href: to[0] ?? keyLink }, to[1]);
  }

  function chooser() {
    return h(
      "div",
      { class: "gs-goals", role: "group", "aria-labelledby": "gs-q" },
      h("p", { class: "gs-q", id: "gs-q" }, "What do you want to do first?"),
      h("div", { class: "chips" }, GOALS.map((g) => h("button", { type: "button", class: "chip-btn", "data-goal": g.id, "aria-pressed": String(goal === g.id), onclick: () => choose(g.id) }, g.title))),
    );
  }

  function build() {
    const g = goalById(goal);
    const count = h("span", { class: "gs-count" });
    const fill = h("i");
    const bar = h("div", { class: "gs-bar", role: "progressbar", "aria-labelledby": "gs-h", "aria-valuemin": "0", "aria-valuemax": String(model.total) }, fill);
    const hide = h("button", { type: "button", class: "small plain gs-hide", "aria-label": "Hide the Get started checklist", onclick: dismiss }, "Hide");
    const steps = model.steps.map(({ id }, i) => {
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
      h("header", { class: "gs-head" }, h("div", { class: "gs-titles" }, h("h2", { id: "gs-h" }, demo ? "Get started (demo)" : "Get started"), h("p", {}, g ? `${g.title}: ${model.total === 5 ? "five" : "three"} short steps.` : "Pick one and the Bridge shows the few steps for it.")), h("div", { class: "gs-side" }, ...(g ? [count, hide] : []))),
      chooser(),
      ...(g
        ? [
            bar,
            h("ol", { class: "gs-steps" }, steps.map((s) => s.li)),
            h("p", { class: "gs-more hint" }, "Optional: ", h("a", { href: "#/api/integrations?tool=telegram" }, "get alerts and prices on your phone with Telegram"), "."),
          ]
        : []),
      live,
    );
    nodes = { card, count, fill, bar, steps };
    return card;
  }

  function choose(id) {
    goal = id;
    app.local.set(GOAL_SLOT, id);
    dismissed = flag(dismissSlot(id));
    nodes = null;
    draw();
    el.querySelector(`[data-goal="${id}"]`)?.focus?.({ preventScroll: true });
    refresh().catch(() => {});
  }

  function paint(prev) {
    if (!nodes || !goal) return;
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
    if (fresh.length) live.textContent = fresh.map((id) => stepDoneText(id, model.steps.findIndex((x) => x.id === id) + 1)).join(" ");
  }

  function draw() {
    const prev = model;
    model = derive();
    // With no goal picked yet the card only asks the question, whatever the original steps say.
    if (!goal) model = { ...model, complete: false };
    if (!shouldShow({ dismissed, complete: model.complete })) {
      nodes = null;
      // Hidden by choice but not finished: one quiet way back, at the same place. Finished: a way to pick another goal.
      el.replaceChildren(
        dismissed && !model.complete
          ? h("button", { type: "button", class: "small plain gs-show", onclick: restore }, "Show the Get started checklist")
          : model.complete
            ? h("button", { type: "button", class: "small plain gs-show", onclick: another }, `Done: ${goalById(goal).title}. Get started with something else`)
            : "",
      );
      return;
    }
    if (!nodes || !el.contains(nodes.card)) el.replaceChildren(build());
    paint(prev);
  }

  function dismiss() {
    dismissed = true;
    app.local.set(dismissSlot(goal ?? "api"), "1");
    draw();
    document.getElementById("acct-h-accounts")?.focus?.({ preventScroll: true });
    toast("Checklist hidden. You can show it again at the top of this page.");
  }
  function restore() {
    dismissed = false;
    app.local.set(dismissSlot(goal ?? "api"), null);
    draw();
    el.querySelector(".gs-hide")?.focus?.({ preventScroll: true });
  }
  function another() {
    goal = null;
    dismissed = false;
    app.local.set(GOAL_SLOT, null);
    nodes = null;
    draw();
    el.querySelector("[data-goal]")?.focus?.({ preventScroll: true });
  }

  async function refresh() {
    if (document.hidden) return;
    const [a, k, r, o] = await Promise.all([optional(api("/v1/accounts", { fresh: true })), optional(api("/v1/keys", { fresh: true })), optional(api("/v1/requests?limit=200", { fresh: true })), optional(api("/v1/orders?limit=1", { fresh: true }))]);
    data = { accounts: a.error ? data.accounts : (a.data?.data ?? []), keys: k.error ? null : (k.data?.data ?? []), requests: r.error ? null : (r.data?.data ?? []), orders: o.error ? null : (o.data?.data ?? []) };
    // Only the goal's own lists are read (a 404 or a 403 for one is "could not be read", never "done").
    const list = async (path) => {
      const r = await optional(api(path, { fresh: true }));
      return r.error ? null : (r.data?.data ?? []);
    };
    if (goal === "history") data.downloads = await list("/v1/downloads");
    if (goal === "record") [data.rules, data.recordings] = await Promise.all([list("/v1/recordings/rules"), list("/v1/recordings")]);
    if (goal === "events") data.subs = await list("/v1/subscriptions");
    draw();
  }

  draw();
  const ready = refresh().catch(() => {});
  every?.(refresh);
  return { el, ready, refresh };
}
