// Morning login: one guided sheet for every account that needs a login today. It lists each account with how it logs in
// (session login, one-time code, OAuth link, access token), takes them one at a time through the same login sheet the
// Accounts page already uses, shows progress, and ends on a done state. It never logs in by itself and never keeps a
// code: every login is typed by the person, exactly as on the Accounts page. The pure parts are in morning-core.js.

import { alertBox, api, app, h, icon, iconTile, istDateTime, modal, optional, pill } from "./app.js";
import { loginPlan, progress, progressText } from "./morning-core.js";

const SINGLE_SESSION_TEXT = "Logging in here ends any session you already have open for this broker app, for example in another tool. Log in to your other tool again afterwards.";

/**
 * The "Morning login" button for the Accounts page, or null when nobody needs a login (or in demo mode).
 * @param {{ accounts: object[], brokers: object[], loginSheet: (account: object, broker: object) => Promise<unknown> }} ctx
 *   loginSheet: the Accounts page's own login sheet, so a login here is the same flow as everywhere else.
 */
export function morningLoginButton(ctx) {
  if (app.state.demo) return null;
  const plan = loginPlan(ctx.accounts, ctx.brokers, Date.now());
  if (!plan.length) return null;
  const n = plan.length;
  return h("button", { type: "button", class: "small tinted", "aria-label": `Morning login: ${n} ${n === 1 ? "account needs" : "accounts need"} a login`, onclick: () => openMorningLogin(ctx) }, icon("sun"), "Morning login");
}

async function freshAccounts(fallback) {
  const r = await optional(api("/v1/accounts"));
  return r.data?.data ?? fallback;
}

/** Run the guided sheet: a list that comes back after each login until everything is done or the person stops. */
export async function openMorningLogin(ctx) {
  let accounts = ctx.accounts;
  const startPlan = loginPlan(accounts, ctx.brokers, Date.now());
  const startIds = startPlan.map((p) => p.account.id);
  const skipped = new Set();
  const dones = new Map(); // id -> "until ..." text for the done rows
  for (;;) {
    const plan = loginPlan(accounts, ctx.brokers, Date.now());
    const p = progress(startIds, plan, skipped);
    for (const id of startIds) {
      const a = accounts.find((x) => x.id === id);
      if (a && !plan.some((x) => x.account.id === id) && !dones.has(id)) dones.set(id, a.session?.expiresAt ? `Logged in until ${istDateTime(a.session.expiresAt)}` : "Logged in");
    }
    const choice = await modal({ title: "Morning login", body: (close) => sheetBody({ p, plan, startIds, skipped, dones, accounts, close }), buttons: [{ label: p.finished ? "Done" : "Not now", value: "close", cls: p.finished ? "primary" : "" }] });
    if (!choice || choice === "close") break;
    if (choice.do === "skip") {
      skipped.add(choice.id);
      continue;
    }
    if (choice.do === "login") {
      const item = plan.find((x) => x.account.id === choice.id);
      if (item?.broker) await ctx.loginSheet(item.account, item.broker);
      accounts = await freshAccounts(accounts);
    }
  }
}

function sheetBody({ p, plan, startIds, skipped, dones, accounts, close }) {
  const byId = new Map(plan.map((x) => [x.account.id, x]));
  const total = Math.max(1, p.total);
  const fill = h("span", {});
  fill.style.width = `${Math.round((p.done / total) * 100)}%`; // through the style object: the page CSP refuses a style attribute
  const bar = h("div", { class: `bar ${p.finished ? "ok" : ""}`.trim(), role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(p.total), "aria-valuenow": String(p.done), "aria-label": "Accounts logged in" }, fill);
  const head = h("div", { class: "stack" }, h("p", { class: "muted", role: "status", "aria-live": "polite" }, progressText(p)), bar);
  const intro = p.finished
    ? alertBox(
        p.skipped
          ? { title: "Done for now", detail: `${p.skipped} ${p.skipped === 1 ? "account is" : "accounts are"} still logged out. Log in from the Accounts page when you are ready.` }
          : { title: p.total ? "All set" : "Nothing to do", detail: p.total ? "Every account is logged in. Apps that use this Bridge can read prices again." : "Every account is logged in for today." },
        "ok",
      )
    : h("p", { class: "hint" }, "One account at a time. Each login is typed by you and sent only to your broker; the Bridge never logs in for you and never saves a one-time code.");
  const rows = startIds.map((id) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) return null;
    const item = byId.get(id);
    const isNext = p.current?.account.id === id;
    if (!item) return row(a, "check", "green", dones.get(id) ?? "Logged in", pill("Done", "ok"));
    if (skipped.has(id)) return row(a, "clock", "gray", "Left for later", pill("Skipped", ""));
    const sub = [item.method.label, item.endsAt ? `ends today, ${istDateTime(item.endsAt)}` : null].filter(Boolean).join(" · ");
    const acts = isNext
      ? h(
          "div",
          { class: "row nowrap" },
          h("button", { type: "button", class: "small primary", "aria-label": `Log in to ${a.label}`, onclick: () => close({ do: "login", id }) }, "Log in"),
          h("button", { type: "button", class: "small", "aria-label": `Skip ${a.label} for now`, onclick: () => close({ do: "skip", id }) }, "Skip"),
        )
      : null;
    return row(a, isNext ? "keys" : "clock", isNext ? "indigo" : "gray", sub, isNext ? pill("Next", "info") : pill(item.needText, item.tone), item.singleSession && isNext ? SINGLE_SESSION_TEXT : null, isNext, isNext ? item.method.hint : null, acts);
  });
  return h("div", { class: "stack mn-sheet" }, head, intro, h("div", { class: "list", role: "list", "aria-label": "Accounts to log in to" }, rows.filter(Boolean)));
}

function row(a, glyph, tint, sub, trailing, warning = null, current = false, hint = null, actions = null) {
  return h(
    "div",
    { class: "list-row static", role: "listitem", ...(current ? { "aria-current": "step" } : {}) },
    iconTile(glyph, tint, "sm"),
    h("span", { class: "names" }, h("span", { class: "nm" }, a.label), h("span", { class: "sub" }, sub), hint ? h("span", { class: "sub" }, hint) : null, warning ? h("span", { class: "sub", role: "note" }, icon("warn"), " ", warning) : null, actions),
    trailing,
  );
}
