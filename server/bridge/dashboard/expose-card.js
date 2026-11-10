// The "Reaching the Bridge from outside" card of API > Integrations (Webhooks and Excel and Sheets panels).
// It reads GET /v1/expose (what is set up, with the doctor's exposure checks) and runs POST /v1/expose/check (local
// probes only: the dashboard never asks the Bridge to call a public address). It changes nothing: setting up is the
// terminal command `mc-bridge expose`, shown with a copy button, because the Bridge reads its settings only at start.
//
// exposeModel and checkModel are pure and exported for expose-card.test.mjs; the DOM code runs only in a browser.
import { alertBox, api, app, copyButton, h, icon, pill, toast } from "./app.js";
import { GUIDE_URL } from "./readiness.js";

/** The state as words: the pill, the headline, one row per listener and the problems (each with its one-line fix). Pure. */
export function exposeModel(state, cli = "mc-bridge") {
  const checks = Array.isArray(state?.checks) ? state.checks : [];
  const problems = checks.filter((c) => c.level === "warn").map((c) => ({ message: c.message, fix: c.fix ?? "", blocking: c.blocking === true }));
  const tone = state?.state !== "on" ? "off" : problems.some((p) => p.blocking) ? "bad" : problems.length ? "warn" : "ok";
  const word = { off: "Not exposed", ok: "On", warn: "Check", bad: "Unsafe" }[tone];
  const listener = (id, name, l, setup) => ({
    id,
    name,
    on: Boolean(l?.enabled),
    address: l?.enabled ? (l.urlPattern ?? "No public address set yet") : null,
    copy: l?.enabled && l.urlPattern ? l.urlPattern : null,
    setup: `${cli} expose ${setup}`,
  });
  return {
    pill: { text: word, tone: tone === "off" ? "" : tone },
    tone,
    headline: String(state?.headline ?? ""),
    listeners: [listener("alerts", "TradingView alerts", state?.alerts, "alerts"), listener("sheets", "Google Sheets", state?.sheets, "sheets")],
    problems,
    restartNote: String(state?.restartNote ?? ""),
  };
}

/** The self-check result as rows with a word and a tone each (never colour only). Pure. */
export function checkModel(result) {
  const word = { pass: "OK", warn: "Note", fail: "Failing", skipped: "Skipped" };
  const tone = { pass: "ok", warn: "warn", fail: "bad", skipped: "" };
  return {
    headline: String(result?.headline ?? ""),
    tone: result?.verdict === "unsafe" ? "bad" : result?.verdict === "not_working" || result?.verdict === "notes" ? "warn" : "ok",
    rows: (result?.items ?? []).map((i) => ({ title: i.title, detail: i.detail, fix: i.fix ?? "", word: word[i.status] ?? i.status, tone: tone[i.status] ?? "" })),
  };
}

const guideLink = (text = "Guide") => h("a", { class: "btn small quiet", href: `${GUIDE_URL}expose-alerts.md`, target: "_blank", rel: "noopener", "aria-label": `${text}: reaching the Bridge from outside (opens in a new tab)` }, text, icon("external"));

const row = ({ title, sub, chips, aside }) =>
  h("div", { class: "list-row static api-row" }, h("div", { class: "api-row-main" }, h("div", { class: "api-row-title" }, h("strong", {}, title)), sub ? h("div", { class: "api-row-sub" }, sub) : null, chips ? h("div", { class: "chips" }, chips) : null), aside ? h("div", { class: "api-row-aside" }, aside) : null);

/**
 * Draw the card into `host`. `focus` is "alerts" or "sheets": the listener this panel is about is listed first.
 * @param {HTMLElement} host @param {"alerts"|"sheets"} focus
 */
export async function exposeCard(host, focus = "alerts") {
  if (!host) return;
  const box = h("section", { class: "group ai-expose-card", "aria-live": "polite" });
  host.replaceChildren(box);
  const cli = app.state.meta?.cliCommand || "mc-bridge";
  let checkSlot = null;

  const draw = (state) => {
    const m = exposeModel(state, cli);
    const order = m.listeners.slice().sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : 0));
    const rowOf = (x) => row({ title: x.title, sub: x.fix ? `${x.detail} Fix: ${x.fix}` : x.detail, chips: [pill(x.word, x.tone)] });
    const runBtn = h("button", { type: "button", class: "small tinted" }, icon("check"), "Check it now");
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      runBtn.setAttribute("aria-busy", "true");
      try {
        const r = await api("/v1/expose/check", { method: "POST", body: {} });
        const c = checkModel(r.data.data);
        checkSlot.replaceChildren(...[
          h("p", { class: "ai-expose-verdict" }, pill(c.tone === "ok" ? "Good" : c.tone === "bad" ? "Unsafe" : "Notes", c.tone === "ok" ? "ok" : c.tone === "bad" ? "bad" : "warn"), " ", c.headline),
          h("div", { class: "list" }, c.rows.filter((x) => x.tone !== "ok").map(rowOf)),
          c.rows.some((x) => x.tone === "ok") ? h("details", { class: "ai-expose-passed" }, h("summary", {}, `${c.rows.filter((x) => x.tone === "ok").length} checks passed`), h("div", { class: "list" }, c.rows.filter((x) => x.tone === "ok").map(rowOf))) : null,
          h("p", { class: "api-row-note" }, "These tests ran on this computer only. Nothing was sent to the internet."),
        ].filter(Boolean));
      } catch (err) {
        toast(err.message, { tone: "error" });
      } finally {
        runBtn.disabled = false;
        runBtn.removeAttribute("aria-busy");
      }
    });
    checkSlot = h("div", { class: "stack" });
    box.replaceChildren(...[
      h("h3", { class: "group-title" }, "Reaching the Bridge from outside"),
      h("div", { class: "list" }, row({ title: m.headline || "Not set up.", chips: [pill(m.pill.text, m.pill.tone)], aside: [guideLink()] })),
      m.tone === "bad" ? alertBox({ title: "Something here is not safe.", detail: "Turn the tunnel off until you have fixed it (the lines below say how). Your keys and orders are not affected by turning it off." }, "bad") : null,
      h("div", { class: "list" }, order.map((l) => row({
        title: l.name,
        sub: l.on ? h("span", {}, l.address === "No public address set yet" ? l.address : [h("span", {}, "Address: "), h("code", {}, l.address)]) : h("span", {}, "Off. To turn it on, run this in a terminal: ", h("code", {}, l.setup)),
        chips: [pill(l.on ? "On" : "Off", l.on ? "ok" : "")],
        aside: l.copy ? [copyButton(l.copy, { ariaLabel: `Copy the ${l.name} address pattern`, toastLabel: "Address copied", cls: "small copy" })] : [copyButton(l.setup, { label: "Copy command", ariaLabel: `Copy command: sets up ${l.name}`, toastLabel: "Command copied", cls: "small copy" })],
      }))),
      m.problems.length
        ? h("div", { class: "list" }, m.problems.map((p) => row({ title: p.message, sub: p.fix ? `Fix: ${p.fix}` : null, chips: [pill(p.blocking ? "Fix now" : "Check", p.blocking ? "bad" : "warn")], aside: p.fix ? [copyButton(p.fix, { ariaLabel: "Copy the fix", toastLabel: "Fix copied", cls: "small copy" })] : null })))
        : null,
      h("p", { class: "api-row-note" }, m.restartNote ? `Changes from the setup command need a restart of the Bridge.` : null),
      h("div", { class: "card-actions" }, runBtn),
      checkSlot,
    ].filter(Boolean));
  };

  try {
    const r = await api("/v1/expose");
    draw(r.data.data);
  } catch (err) {
    box.replaceChildren(h("h3", { class: "group-title" }, "Reaching the Bridge from outside"), alertBox({ title: "Could not read the setup", detail: String(err?.message ?? err) }, "warn"));
  }
}
