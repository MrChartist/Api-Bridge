// Help that finds you: a "Something wrong?" button in the toolbar of every page, and the emergency Stop beside it. Both
// are one click from anywhere; Stop still asks before it does anything (readiness.js engageKillSwitch).
import { h, icon, iconTile, sheetPopover } from "./app.js";
import { HELP_TOPICS } from "./easy-core.js";
import { engageKillSwitch, refreshReadiness } from "./readiness.js";

/** Stop every new order, after the usual question; then a fresh readiness reading. */
export async function stopEverything() {
  if (await engageKillSwitch()) {
    await refreshReadiness();
    if (location.hash.startsWith("#/safety")) dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

const closeSheet = (pop, next) => {
  const d = document.getElementById("dialog");
  const wasOpen = Boolean(d?.open);
  pop?.close();
  // On phones the popover is the shared sheet: let it finish closing before anything else opens.
  if (wasOpen && d.open === false) d.addEventListener("close", () => setTimeout(next, 0), { once: true });
  else setTimeout(next, 0);
};

/** The sheet of questions. `trigger` is the button it opened from (focus returns to it). */
export function openHelp(trigger) {
  let pop = null;
  const rows = HELP_TOPICS.map((t) =>
    h(
      "button",
      {
        type: "button",
        class: `list-row help-row${t.danger ? " danger" : ""}`,
        onclick: () => closeSheet(pop, () => (t.to === "stop" ? stopEverything() : (location.hash = `#/${t.to}`))),
      },
      iconTile(t.icon, t.danger ? "red" : "blue", "md"),
      h("span", { class: "names" }, h("span", { class: "nm" }, t.title), h("span", { class: "sub" }, t.sub)),
      icon("chevron"),
    ),
  );
  const body = h("div", { class: "help-sheet" }, h("p", { class: "help-lead" }, "Pick what is happening. Each one takes you to the place that explains it and fixes it."), h("div", { class: "list" }, rows));
  pop = sheetPopover({ trigger, title: "Something wrong?", cls: "help-popover", body });
  return pop;
}

/** The two toolbar buttons. Their text hides on small screens (the labels stay for screen readers). */
export function toolbarHelp() {
  const help = h("button", { type: "button", class: "toolbar-help", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Something wrong? Get help", onclick: () => openHelp(help) }, icon("info"), h("span", { class: "tb-text" }, "Something wrong?"));
  const stop = h("button", { type: "button", class: "toolbar-stop", title: "Stop all orders: asks you to confirm first", "aria-label": "Stop all orders", onclick: stopEverything }, icon("stop"), h("span", { class: "tb-text" }, "Stop"));
  return [help, stop];
}

/** "Something wrong?" as a row in the phone More sheet. */
export const helpRow = (onPick) => h("button", { type: "button", class: "list-row", onclick: onPick }, iconTile("info", "blue", "md"), h("span", { class: "names" }, h("span", { class: "nm" }, "Something wrong?"), h("span", { class: "sub" }, "Rate limited, an old price, stop everything")), icon("chevron"));

