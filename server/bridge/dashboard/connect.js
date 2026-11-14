// Connect a tool (#/connect): pick what you want to connect, press one button, and get a key with only the access that
// tool needs plus the exact setup to paste, already filled in with this Bridge's address. "Test it" then makes a real
// read call with that key from this browser. The rules (which key, which setup, what a failure means) are in
// easy-core.js; the key rules themselves are the Keys page's (flows.js, snippets.js).
import { alertBox, api, app, copyButton, h, icon, iconTile, runFix, toast } from "./app.js";
import { CONNECT_TOOLS, SETUP_NAME, connectCapabilities, connectHeading, connectKey, connectSetup, connectTool, ordersChoice, setMode, sourcesSentence, testOutcome, testRequest } from "./easy-core.js";

let deps = { segmented: null, snippetBlock: null };
/** views.js passes the shared building blocks (segmented control, code block) so they are not written twice. */
export function configureConnect(d) {
  deps = { ...deps, ...d };
}

const TOOL_TILE = Object.freeze({ excel: ["integrations", "green"], ai: ["bolt", "purple"], python: ["console", "blue"], node: ["console", "teal"], app: ["plug", "orange"], amibroker: ["chart", "indigo"] });
const busy = (b, on) => {
  b.disabled = on;
  if (on) b.setAttribute("aria-busy", "true");
  else b.removeAttribute("aria-busy");
};

/** The page. It keeps its own small state: which step is showing. */
export async function renderConnect() {
  const root = h("div", { class: "cn" });
  const [accounts, keys] = await Promise.all([api("/v1/accounts").catch(() => null), api("/v1/keys").catch(() => null)]);
  const accs = accounts?.data?.data ?? [];
  const taken = (keys?.data?.data ?? []).map((k) => k.label);
  const paperAcc = accs.find((a) => a.broker === "paper")?.id ?? "demo-paper";
  const onlySample = !accs.some((a) => a.broker !== "paper" && a.broker !== "demo");

  const note = onlySample
    ? h("div", { class: "cn-note" }, icon("info"), h("p", {}, "You are using sample prices. To use real prices, add your broker first."), h("a", { class: "btn small tinted", href: "#/accounts" }, "Add your broker"))
    : null;

  // Step 1: what do you want to connect?
  function chooser() {
    const grid = h(
      "div",
      { class: "api-pick cn-grid" },
      CONNECT_TOOLS.map((t) => {
        const [glyph, tint] = TOOL_TILE[t.id] ?? ["plug", "gray"];
        return h("button", { type: "button", class: "api-pick-item cn-tool", "data-tool": t.id, onclick: () => options(t.id) }, iconTile(glyph, tint, "sm"), h("span", { class: "api-pick-text" }, h("span", { class: "api-pick-name" }, t.name), h("span", { class: "api-pick-sub" }, t.blurb)), icon("chevron"));
      }),
    );
    show(h("section", { class: "cn-step", "aria-labelledby": "cn-h" }, h("h2", { id: "cn-h", class: "cn-q" }, "What do you want to connect?"), grid));
  }

  // Step 2: what may it do? (one choice at most) and one button.
  function options(toolId) {
    const tool = connectTool(toolId);
    const choice = ordersChoice(toolId);
    const seg = choice && deps.segmented ? deps.segmented(choice.label, choice.options, choice.options[0][0]) : null;
    const caps = h("div", { class: "cn-caps", "aria-live": "polite" });
    const drawCaps = () => {
      const c = connectCapabilities(toolId, { orders: seg?.value === "yes" });
      caps.replaceChildren(h("p", { class: "cn-can" }, icon("check"), h("span", {}, c.can)), h("p", { class: "cn-cannot" }, icon("close"), h("span", {}, c.cannot)), ...(c.needs ? [h("p", { class: "cn-small cn-needs" }, c.needs), h("code", { class: "cn-small cn-needs-code", tabindex: "0" }, c.needsCode)] : []));
    };
    drawCaps();
    seg?.addEventListener("change", drawCaps);
    const err = h("div", { "aria-live": "polite" });
    const make = h("button", { type: "button", class: "primary lg", onclick: () => create(toolId, seg?.value === "yes", make, err) }, icon("keys"), "Create key and show setup");
    const back = h("button", { type: "button", class: "plain small cn-back", onclick: chooser }, icon("chevron"), "Choose another tool");
    show(
      h(
        "section",
        { class: "cn-step", "aria-labelledby": "cn-h" },
        back,
        h("h2", { id: "cn-h", class: "cn-q" }, connectHeading(tool)),
        choice ? h("div", { class: "cn-choice" }, h("span", { class: "cn-choice-label", id: "cn-choice-l" }, choice.label), seg) : null,
        caps,
        h("p", { class: "cn-small" }, "The key is made with only this access. You can revoke it any time under Keys."),
        err,
        h("div", { class: "cn-go" }, make),
      ),
    );
  }

  async function create(toolId, orders, btn, err) {
    err.replaceChildren();
    busy(btn, true);
    try {
      const body = connectKey(toolId, { orders, taken });
      const r = await api("/v1/keys", { method: "POST", body });
      const key = r.data.data?.key;
      taken.push(body.label);
      ready(toolId, key, body, orders);
    } catch (e) {
      err.replaceChildren(alertBox(e));
      busy(btn, false);
    }
  }

  // Step 3: the key (once), the setup to paste, and Test it.
  function ready(toolId, key, body, orders) {
    const tool = connectTool(toolId);
    const groups = connectSetup(toolId, { base: location.origin, key, account: paperAcc, folder: app.state.meta?.installDir || undefined, orders });
    const blocks = h("div", { class: "stack cn-blocks" });
    const seg = groups.length > 1 && deps.segmented ? deps.segmented("Paste it into", groups.map((g) => [g.id, SETUP_NAME[g.id] ?? g.id]), groups[0].id) : null;
    const draw = () => blocks.replaceChildren(...(groups.find((g) => g.id === (seg?.value ?? groups[0].id))?.blocks ?? []).map((b) => deps.snippetBlock(b)));
    seg?.addEventListener("change", draw);
    draw();

    const result = h("div", { class: "cn-result", role: "status", "aria-live": "polite" });
    const test = h("button", { type: "button", class: "primary lg", onclick: () => runTest() }, icon("play"), "Test it");
    async function runTest() {
      busy(test, true);
      result.replaceChildren(h("p", { class: "cn-small" }, "Asking the Bridge for a price…"));
      let out;
      try {
        const q = testRequest(toolId, key);
        const res = await fetch(q.url, { headers: q.headers, cache: "no-store" });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* plain text answer (the spreadsheet routes) */
        }
        out = testOutcome({ status: res.status, text, json });
      } catch {
        out = testOutcome({ network: true });
      }
      busy(test, false);
      const box = h("div", { class: `alert ${out.ok ? "ok" : "bad"}` }, icon(out.ok ? "check" : "warn"), h("div", {}, h("strong", {}, out.title), h("span", { class: "detail" }, out.detail), out.fix ? h("div", { class: "alert-actions" }, h("button", { type: "button", class: "small tinted", onclick: () => (out.fix.id === "retry" ? runTest() : runFix(out.fix)) }, out.fix.label)) : null));
      result.replaceChildren(box);
      if (out.ok) toast("Test passed");
    }

    // Excel: the ready workbook has the key in it already (Setup, B6), which saves naming a cell.
    const workbook = toolId === "excel"
      ? h("div", { class: "cn-go" }, h("button", { type: "button", class: "primary lg", onclick: () => import("./workbook.js").then((m) => m.downloadWorkbook({ key })) }, icon("download"), "Download a ready workbook"), h("span", { class: "cn-small" }, "The key is inside the file. Do not share it."))
      : null;
    const caps = connectCapabilities(toolId, { orders });
    const developer = ["python", "node", "app"].includes(toolId);
    const again = h("button", { type: "button", class: "plain small", onclick: chooser }, "Connect another tool");
    const keyRow = h("div", { class: "cn-key" }, h("code", { class: "cn-key-v", tabindex: "0", "aria-label": "Your new key" }, key), copyButton(key, { label: "Copy key", toastLabel: "Key copied", cls: "small", ariaLabel: "Copy your new key" }));
    show(
      h(
        "section",
        { class: "cn-step cn-ready", "aria-labelledby": "cn-h" },
        h("header", { class: "cn-head" }, iconTile("check", "green", "lg"), h("div", {}, h("h2", { id: "cn-h", class: "cn-q" }, "Your key is ready"), h("p", { class: "cn-small" }, `Key name: ${body.label}. ${caps.can}`))),
        h("div", { class: "cn-keybox" }, h("span", { class: "cn-label" }, "Your key"), keyRow, h("p", { class: "cn-small" }, "Copy it now. The Bridge shows it only once and keeps only a short code to recognise it.")),
        h("div", { class: "cn-setup" }, h("h3", { class: "cn-h3" }, "Set it up"), h("p", { class: "cn-small" }, tool.paste), workbook, tool.steps ? h("ol", { class: "cn-steps" }, tool.steps.map((t) => h("li", {}, t))) : null, seg, blocks),
        h("div", { class: "cn-test" }, h("div", { class: "cn-go" }, test, h("span", { class: "cn-small" }, "Asks the Bridge for a price with this key, the way your tool will.")), result),
        h("p", { class: "cn-small cn-cannot-line" }, caps.cannot),
        caps.needs ? h("div", { class: "alert info cn-needs" }, icon("info"), h("div", {}, h("span", { class: "detail" }, caps.needs), h("code", { class: "cn-needs-code", tabindex: "0" }, caps.needsCode))) : null,
        developer ? h("p", { class: "cn-small cn-next" }, "Next: have the Bridge tell your program when an order changes or a download finishes, instead of asking again and again.") : null,
        h("div", { class: "cn-foot" }, again, developer ? h("a", { class: "btn tinted small", href: "#/developers?view=events" }, "Receive order events") : null, h("a", { class: "btn plain small", href: "#/developers" }, "Developers"), h("a", { class: "btn plain small", href: "#/api/keys" }, "Manage keys"), h("a", { class: "btn plain small", href: "#/api/integrations" }, "More integrations")),
      ),
    );
  }

  const slot = h("div", { class: "cn-slot" });
  let first = true;
  function show(node) {
    slot.replaceChildren(node);
    // Move focus into the new step so a keyboard or screen reader user lands on it (not on the old button, now gone).
    // The first step is the page itself: it does not take focus.
    const head = node.querySelector("h2");
    head?.setAttribute("tabindex", "-1");
    if (!first) {
      head?.focus?.({ preventScroll: true });
      node.scrollIntoView?.({ block: "nearest" });
    }
    first = false;
  }
  root.append(...[note, slot].filter(Boolean));
  // #/connect?tool=ai (the Orders page's "Set up an AI assistant") starts at that tool's step.
  const asked = new URLSearchParams(location.hash.split("?")[1] ?? "").get("tool");
  if (asked && connectTool(asked)) options(asked);
  else chooser();
  return root;
}

/** Simple view, Sources: where prices come from in one sentence, and one way to the detailed pages. */
export async function simpleSourcesNote() {
  let list = [];
  try {
    list = (await api("/v1/sources")).data.data ?? [];
  } catch {
    return null;
  }
  const more = h(
    "button",
    {
      type: "button",
      class: "plain small",
      onclick: () => {
        setMode("advanced");
        location.hash = "#/sources/overview";
      },
    },
    "Show quotas, route trace and per-key meters",
  );
  return h("section", { class: "cn-status", "aria-label": "Where your prices come from" }, iconTile("sources", "teal", "md"), h("p", {}, sourcesSentence(list)), more);
}
