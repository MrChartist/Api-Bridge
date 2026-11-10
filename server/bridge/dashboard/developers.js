// Developers (#/developers): from zero to a working call in five minutes, which scope and key to use, your own requests
// live, and every error explained. Four views in one page: Start, Apps, Requests, Errors. Apps are keys (one key, its scope,
// quota and use), so nothing here stores anything of its own: it reads /v1/keys, /v1/quotas, /v1/requests and /v1/errors.
// The rules and the words are in developers-core.js (pure, tested); this file only draws them.
import { alertBox, api, app, copyButton, currentKey, emptyState, h, icon, iconTile, istTime, modal, optional, pill, toast } from "./app.js";
import { formatInt, plural } from "./format.js";
import { countTo, patchList, setText } from "./motion.js";
import { searchIcon } from "./palette.js";
import {
  APP_PRESETS, ERROR_GROUPS, EXPIRY_CHOICES, OPENAPI_PATH, STARTERS, appBody, appSnippetGroups, appUseLine, buildApps, capabilityLines, defaultAppName, filterCatalogue,
  filterRequests, findRoutes, isErrorStatus, logFilters, presetById, presetForScope, quickStart, requestOwner, requestStats, sampleProblem, scopeAdvice, starterCommand, statusTone,
} from "./developers-core.js";
import { snippets } from "./snippets.js";

/** What views.js hands over (it owns these, and this file is loaded only when the page opens). */
let deps = { segmented: null, snippetBlock: null, every: null, stop: null, hashParams: () => new URLSearchParams(), setHashParam: () => {} };
export function configureDevelopers(d) {
  deps = { ...deps, ...d };
}

const VIEWS = Object.freeze([["start", "Start"], ["apps", "Apps"], ["requests", "Requests"], ["errors", "Errors"]]);
const STARTER_TILE = Object.freeze({ node: ["console", "teal"], python: ["console", "blue"], curl: ["console", "gray"], sheets: ["integrations", "green"], "webhook-receiver": ["bolt", "orange"], "mcp-client": ["plug", "purple"] });
const LOG_MS = 3000;
const APPS_MS = 6000;

const busy = (b, on) => {
  b.disabled = on;
  if (on) b.setAttribute("aria-busy", "true");
  else b.removeAttribute("aria-busy");
};
const code = (text) => h("code", { class: "dev-code" }, text);
/** A command or address on one line, with a Copy button that keeps its place on narrow screens. */
const commandLine = (text, label) => h("div", { class: "dev-cmd" }, h("code", { tabindex: "0", "aria-label": label ?? text }, text), copyButton(text, { ariaLabel: `Copy: ${label ?? text}`, cls: "small copy" }));

export async function renderDevelopers() {
  const root = h("div", { class: "api-tab dev" });
  const base = location.origin;
  const meta = app.state.meta ?? {};
  const cli = meta.cliCommand ?? "mc-bridge";
  const folder = meta.installDir || undefined;
  const ownKeyId = String(currentKey() ?? "").split("_")[1] ?? null;

  const [keysRes, quotasRes, errorsRes, accountsRes] = await Promise.all([optional(api("/v1/keys")), optional(api("/v1/quotas")), optional(api("/v1/errors")), optional(api("/v1/accounts"))]);
  const state = {
    apps: [],
    keysError: keysRes.error ?? null,
    catalogue: errorsRes.error ? null : errorsRes.data?.data ?? [],
    catalogueError: errorsRes.error ?? null,
    accounts: accountsRes.error ? [] : accountsRes.data?.data ?? [],
    requests: [],
    requestsError: null,
    routes: meta.routes ?? [],
    appFilter: deps.hashParams().get("app") || "all",
  };
  const draw = (keys, quotas) => (state.apps = buildApps({ keys: keys ?? [], quotas, ownKeyId }));
  draw(keysRes.error ? [] : keysRes.data?.data, quotasRes.error ? null : quotasRes.data?.data);

  const reloadApps = async () => {
    const [k, q] = await Promise.all([optional(api("/v1/keys")), optional(api("/v1/quotas"))]);
    state.keysError = k.error ?? null;
    draw(k.error ? [] : k.data?.data, q.error ? null : q.data?.data);
  };

  // ── The header: the four views, and the one main action ──
  const params = deps.hashParams();
  let view = VIEWS.some(([id]) => id === params.get("view")) ? params.get("view") : state.apps.some((a) => a.usable) ? "apps" : "start";
  const seg = deps.segmented("Developers", VIEWS, view);
  const createBtn = h("button", { type: "button", class: "primary", onclick: () => openCreate() }, icon("plus"), "Create app");
  const body = h("div", { class: "dev-body" });
  root.append(h("div", { class: "dev-head" }, h("h2", { class: "sr-only" }, "Developers"), seg, createBtn), body);

  /** Open a view. A filter that belongs to another view (a status, a code, an app) does not follow the person to this one. */
  const go = (next, extra = {}) => {
    view = next;
    if (seg.value !== next) seg.value = next;
    deps.setHashParam("view", next);
    for (const k of ["status", "code", "app"]) deps.setHashParam(k, extra[k] ?? "");
    if (extra.app) state.appFilter = extra.app;
    show();
  };
  seg.addEventListener("change", () => {
    if (seg.value !== view) go(seg.value);
  });

  function show() {
    deps.stop?.();
    const panels = { start: startPanel, apps: appsPanel, requests: requestsPanel, errors: errorsPanel };
    body.replaceChildren(panels[view]());
  }

  // ── Create app (a sheet): pick what it is for, name it, get the key once with its setup ──
  function openCreate(startPreset = null) {
    return modal({
      title: "Create an app",
      body: (close) => createForm(close, startPreset),
      buttons: [],
    });
  }

  function createForm(close, startPreset) {
    let presetId = startPreset ?? "read";
    const taken = state.apps.map((a) => a.name);
    let touchedName = false;
    const err = h("div", { "aria-live": "polite" });
    const name = h("input", { id: "dev-app-name", maxlength: "60", autocomplete: "off", spellcheck: "false", "aria-required": "true" });
    name.value = defaultAppName(presetId, new Date(), taken);
    name.addEventListener("input", () => (touchedName = true));
    const expiry = deps.segmented("Expires", EXPIRY_CHOICES, presetById(presetId).expiresDays ? String(presetById(presetId).expiresDays) : "");
    const personal = state.accounts.filter((a) => a.broker !== "paper" && a.broker !== "demo");
    const account = h("select", { id: "dev-app-account" }, h("option", { value: "*" }, "All accounts"), state.accounts.map((a) => h("option", { value: a.id }, `${a.label ?? a.id} (${a.id})`)));
    const caps = h("div", { class: "dev-caps", "aria-live": "polite" });
    const pick = h("div", { class: "api-pick dev-pick", role: "radiogroup", "aria-label": "What will use this app" });
    const buttons = APP_PRESETS.map((p) => {
      const b = h("button", { type: "button", class: "api-pick-item", role: "radio", "data-id": p.id, onclick: () => choose(p.id, true) }, iconTile(p.glyph, p.tint, "sm"), h("span", { class: "api-pick-text" }, h("span", { class: "api-pick-name" }, p.name), h("span", { class: "api-pick-sub" }, p.blurb)), icon("check"));
      return b;
    });
    pick.append(...buttons);
    pick.addEventListener("keydown", (e) => {
      const i = APP_PRESETS.findIndex((p) => p.id === presetId);
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      choose(APP_PRESETS[(i + step + APP_PRESETS.length) % APP_PRESETS.length].id, true);
    });
    function choose(id, focus) {
      presetId = id;
      const p = presetById(id);
      for (const b of buttons) {
        const on = b.dataset.id === id;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      }
      if (!touchedName) name.value = defaultAppName(id, new Date(), taken);
      expiry.value = p.expiresDays ? String(p.expiresDays) : "";
      const c = capabilityLines(p.scopes, p.clientKind);
      caps.replaceChildren(
        h("p", { class: "dev-can" }, icon("check"), h("span", {}, c.can.join(" "))),
        h("p", { class: "dev-cannot" }, icon("close"), h("span", {}, c.cannot.join(" "))),
        p.id === "admin" ? alertBox({ title: "An admin key can make and revoke other keys", detail: "It works from this computer only. Give it only to programs you run yourself, and keep its expiry short." }, "warn") : "",
      );
    }
    choose(presetId, false);
    const make = h("button", { type: "button", class: "primary lg", onclick: submit }, icon("keys"), "Create app");
    const cancel = h("button", { type: "button", class: "quiet lg", onclick: () => close(undefined) }, "Cancel");
    const form = h(
      "div",
      { class: "stack dev-form" },
      h("p", { class: "dev-lead" }, "An app is one key with only the access its job needs. Pick what it is for."),
      pick,
      h("label", { class: "field", for: "dev-app-name" }, h("span", {}, "Name"), name, h("span", { class: "hint" }, "So you can tell apps apart later.")),
      h("div", { class: "field seg-field" }, h("span", { id: "dev-exp-l" }, "Expires"), expiry),
      personal.length ? h("label", { class: "field", for: "dev-app-account" }, h("span", {}, "Accounts it may use"), account) : null,
      caps,
      err,
      h("div", { class: "dev-actions" }, cancel, make),
    );
    expiry.removeAttribute("aria-label");
    expiry.setAttribute("aria-labelledby", "dev-exp-l");

    async function submit() {
      err.replaceChildren();
      const out = appBody(presetId, { name: name.value, expiresDays: expiry.value, account: personal.length ? account.value : "*" });
      if (out.error) {
        err.replaceChildren(h("p", { class: "field-msg", role: "alert" }, out.error.message));
        name.focus();
        return;
      }
      busy(make, true);
      try {
        const r = await api("/v1/keys", { method: "POST", body: out.body });
        const { key, record } = r.data.data;
        await reloadApps();
        revealKey(key, record, form);
        if (view === "apps") show();
      } catch (e) {
        err.replaceChildren(alertBox(e));
        busy(make, false);
      }
    }

    // The key, once: big, copyable, with the setup that already has it in.
    function revealKey(key, record, host) {
      const made = state.apps.find((a) => a.id === record.id) ?? buildApps({ keys: [record] })[0];
      const groups = appSnippetGroups(made, { base, key, folder });
      const gseg = groups.length > 1 ? deps.segmented("Setup for", groups.map((g) => [g.id, g.label]), groups[0].id) : null;
      const blocks = h("div", { class: "stack dev-blocks" });
      const drawBlocks = () => blocks.replaceChildren(...(groups.find((g) => g.id === (gseg?.value ?? groups[0].id))?.blocks ?? []).map((b) => deps.snippetBlock(b)));
      gseg?.addEventListener("change", drawBlocks);
      drawBlocks();
      const done = h("button", { type: "button", class: "primary lg", onclick: () => close(true) }, "Done");
      host.replaceChildren(
        h("div", { class: "dev-reveal", tabindex: "-1" }, iconTile("check", "green", "lg"), h("div", {}, h("h3", {}, `${record.label} is ready`), h("p", {}, `${presetById(presetId).name}. ${made.badge.word}${record.expiresAt ? `, ${made.expiryText}` : ", no expiry"}.`))),
        alertBox({ title: "Copy the key now. It is shown only once.", detail: "The Bridge keeps only a short code that recognises it, so it cannot show it again. If you lose it, make another app and revoke this one." }, "warn"),
        h("div", { class: "dev-keybox" }, h("span", { class: "dev-keylabel", id: "dev-key-l" }, "Your key"), h("div", { class: "dev-keyrow" }, h("code", { class: "dev-keyvalue", tabindex: "0", "aria-labelledby": "dev-key-l" }, key), copyButton(key, { label: "Copy key", toastLabel: "Key copied", cls: "primary lg", ariaLabel: "Copy the key" }))),
        h("p", { class: "dev-small" }, "Keep it in an environment variable or in a .env file that is in .gitignore. Never put it in code you share or in a web address."),
        gseg ? h("div", { class: "field seg-field" }, h("span", {}, "Setup, with the key filled in"), gseg) : "",
        blocks,
        h("p", { class: "dev-small" }, "Or start a whole project: ", code(`${cli} init node --with-key`), " writes one with its own read-only key in .env."),
        h("div", { class: "dev-actions" }, done),
      );
      host.querySelector(".dev-reveal")?.focus({ preventScroll: true });
    }
    return form;
  }

  // ── One app (a sheet): what it may do, its use, its setup, and Revoke ──
  async function openApp(a) {
    const c = capabilityLines(a.scopes, a.clientKind);
    const groups = appSnippetGroups(a, { base, folder });
    const gseg = groups.length > 1 ? deps.segmented("Setup for", groups.map((g) => [g.id, g.label]), groups[0].id) : null;
    const blocks = h("div", { class: "stack dev-blocks" });
    const drawBlocks = () => blocks.replaceChildren(...(groups.find((g) => g.id === (gseg?.value ?? groups[0].id))?.blocks ?? []).map((b) => deps.snippetBlock(b)));
    gseg?.addEventListener("change", drawBlocks);
    drawBlocks();
    const kv = h(
      "dl",
      { class: "kv dev-kv" },
      ...[
        ["Key id", a.id],
        ["Access", `${a.badge.word}${a.scopes.length > 1 ? ` (${a.scopes.join(", ")})` : ""}`],
        ["Accounts", a.accountsText],
        ["Status", `${a.statusText}, ${a.expiryText}`],
        ["Last used", a.lastUsedAt ? a.lastUsedText : "never"],
        ["Requests today", `${formatInt(a.requestsToday)}${a.throttledToday ? `, ${formatInt(a.throttledToday)} slowed down` : ""}`],
        ["Quota", `${a.quotaText}${a.quotaCustom ? " (changed)" : ""}`],
      ].flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, k === "Key id" ? code(v) : v)]),
    );
    const revoke = a.status === "revoked" ? null : { label: a.own ? "Revoke and sign out" : "Revoke app", cls: "tinted destructive", value: "revoke" };
    const choice = await modal({
      title: a.name,
      body: (close) => h(
        "div",
        { class: "stack dev-sheet" },
        h("div", { class: "dev-sheet-pills" }, pill(a.badge.word, a.badge.tone), pill(a.statusText, a.status === "active" ? "ok" : a.status === "expiring" ? "warn" : "bad")),
        h("p", { class: "dev-can" }, icon("check"), h("span", {}, c.can.join(" "))),
        h("p", { class: "dev-cannot" }, icon("close"), h("span", {}, c.cannot.join(" "))),
        kv,
        a.usable ? h("div", { class: "dev-sheet-acts" }, h("button", { type: "button", class: "small tinted", onclick: () => close("requests") }, icon("activity"), "See its requests"), h("button", { type: "button", class: "small", onclick: () => close("quota") }, icon("limits"), "Change quota")) : null,
        a.usable
          ? h("div", { class: "stack" }, h("h3", {}, "Setup with your address"), h("p", { class: "dev-small" }, `The secret is shown only once, when an app is made, so these say ${"PASTE_THE_SECRET_HERE"} where it goes. Lost it? Make a new app and revoke this one.`), gseg ? h("div", { class: "field seg-field" }, h("span", {}, "Setup for"), gseg) : null, blocks)
          : null,
      ),
      buttons: [{ label: "Close", value: "close" }, ...(revoke ? [revoke] : [])],
    });
    if (choice === "requests") return go("requests", { app: a.id });
    if (choice === "quota") {
      location.hash = "#/sources/quotas";
      return;
    }
    if (choice !== "revoke") return;
    const ok = await modal({
      title: `Revoke “${a.name}”?`,
      body: h("div", { class: "stack" }, h("p", {}, "It stops working on its very next request, and its open streams close. This cannot be undone."), a.own ? alertBox({ title: "This browser is signed in with this key", detail: "You will be signed out at once." }, "warn") : null),
      buttons: [{ label: "Cancel", value: false }, { label: a.own ? "Revoke and sign out" : "Revoke app", cls: "destructive", value: true }],
    });
    if (!ok) return;
    try {
      await api(`/v1/keys/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      toast(`Revoked ${a.name}`);
    } catch (e) {
      toast(`Could not revoke ${a.name}: ${e.message}`, { tone: "error" });
    }
    await reloadApps();
    if (view === "apps") show();
  }

  // ── View: Start ──
  function startPanel() {
    const steps = quickStart({ base, cli, haveApps: state.apps.some((a) => a.usable) });
    const health = h("div", { class: "dev-health", role: "status", "aria-live": "polite" });
    const check = h("button", { type: "button", class: "small tinted", onclick: async () => {
      busy(check, true);
      health.replaceChildren(h("span", { class: "dev-small" }, "Asking the Bridge…"));
      try {
        const res = await fetch("/v1/health", { cache: "no-store" });
        const j = await res.json();
        health.replaceChildren(alertBox({ title: `It answers: Bridge ${j.version} is ${j.status}`, detail: j.demo ? "Demo mode: prices are sample data, not market data." : "Your Bridge is up." }, "ok"));
      } catch {
        health.replaceChildren(alertBox({ title: "No answer", detail: `Nothing answered at ${base}. Is the Bridge running?` }));
      }
      busy(check, false);
    } }, icon("play"), "Check now");

    const generic = { id: "yourkey", scopes: ["read"], allowQuery: false, clientKind: "script" };
    const groups = appSnippetGroups(generic, { base, key: "mcb_YOUR_KEY", folder });
    const gseg = deps.segmented("Language", groups.map((g) => [g.id, g.label]), "curl");
    const blocks = h("div", { class: "stack dev-blocks" });
    const drawBlocks = () => blocks.replaceChildren(...groups.find((g) => g.id === gseg.value).blocks.map((b) => deps.snippetBlock(b)));
    gseg.addEventListener("change", drawBlocks);
    drawBlocks();

    const step = (s, ...content) => h("li", { class: "dev-step" }, h("span", { class: "dev-n", "aria-hidden": "true" }, String(s.n)), h("div", { class: "dev-step-body" }, h("h3", {}, s.title), h("p", {}, s.text), ...content));
    const sdk = snippets({ base, folder, key: "mcb_YOUR_KEY" });
    return h(
      "div",
      { class: "stack dev-start" },
      h(
        "section",
        { class: "card dev-card", "aria-labelledby": "dev-s1" },
        h("header", { class: "card-head" }, iconTile("play", "teal"), h("div", { class: "card-titles" }, h("h2", { id: "dev-s1" }, "Zero to a working call in five minutes"), h("p", {}, "Three steps. Every command below already has this Bridge's address in it."))),
        h(
          "ol",
          { class: "card-body dev-steps" },
          step(steps[0], commandLine(steps[0].code), h("div", { class: "dev-step-acts" }, check), health),
          step(steps[1], h("div", { class: "dev-step-acts" }, h("button", { type: "button", class: "primary", onclick: () => openCreate() }, icon("plus"), "Create app"), h("button", { type: "button", class: "plain", onclick: () => go("apps") }, "Which key do I need?"))),
          step(steps[2], gseg, blocks),
        ),
      ),
      h(
        "section",
        { class: "card dev-card", "aria-labelledby": "dev-s2" },
        h("header", { class: "card-head" }, iconTile("download", "indigo"), h("div", { class: "card-titles" }, h("h2", { id: "dev-s2" }, "Or start from a project"), h("p", {}, "One command writes a ready folder with this address, a README with three steps, and a key only if you ask."))),
        h(
          "div",
          { class: "card-body dev-starters" },
          STARTERS.map((s) => {
            const [glyph, tint] = STARTER_TILE[s.id] ?? ["console", "gray"];
            const cmd = starterCommand(s.id, cli);
            return h("div", { class: "dev-starter" }, h("div", { class: "dev-starter-top" }, iconTile(glyph, tint, "sm"), h("div", { class: "dev-starter-text" }, h("strong", { "data-gloss": "off" }, s.title), h("span", {}, s.about))), commandLine(cmd, `Command for the ${s.title} starter`));
          }),
        ),
      ),
      h(
        "section",
        { class: "card dev-card", "aria-labelledby": "dev-s3" },
        h("header", { class: "card-head" }, iconTile("list", "purple"), h("div", { class: "card-titles" }, h("h2", { id: "dev-s3" }, "Libraries and the full reference"), h("p", {}, "The clients ship with the Bridge, in its sdk folder."))),
        h(
          "div",
          { class: "card-body stack" },
          h("div", { class: "dev-links" }, h("a", { class: "btn small tinted", href: OPENAPI_PATH, target: "_blank", rel: "noopener" }, icon("external"), "OpenAPI description"), h("button", { type: "button", class: "small", onclick: () => go("errors") }, icon("info"), "Every error and its fix")),
          deps.snippetBlock(sdk.python[0]),
          deps.snippetBlock(sdk.node[0]),
          h("p", { class: "dev-small" }, "Events without polling: ", code("GET /v1/events/stream"), " (server-sent, with ", code("since="), " to catch up) and signed webhooks to an address on your own computer or network. The ", code("webhook-receiver"), " starter checks the signature for you."),
          h("p", { class: "dev-small" }, "Promise: routes under /v1 only gain things. A field is never renamed or removed there, and an error code is never renamed; anything breaking would be /v2 beside it. Read the `code` of an error, not its text."),
        ),
      ),
    );
  }

  // ── View: Apps ──
  function appsPanel() {
    const wrap = h("div", { class: "stack dev-apps" });
    if (state.keysError) {
      wrap.append(alertBox({ title: "Apps need an admin key", detail: "This page lists your API keys, and only an admin key (the one the dashboard signs in with, on this computer) may. Sign in again with mc-bridge open." }, "warn"));
    }
    const list = h("div", { class: "list dev-list", role: "list", "aria-label": "Apps" });
    const appsN = h("strong", {}, "0");
    const callsN = h("strong", { class: "dev-calls" }, "0");
    const summary = h("p", { class: "dev-summary" }, appsN, " ", h("span", {}, "apps"), " · ", callsN, " ", h("span", { class: "dev-calls-word" }, "requests today"));
    const gone = h("details", { class: "dev-gone" });
    const emptyHost = h("div", { class: "card" }, emptyState("keys", "No apps yet", "An app is one key with only the access its job needs. Make one, then copy its setup.", h("button", { type: "button", class: "primary", onclick: () => openCreate() }, icon("plus"), "Create app")));
    const paint = () => {
      const now = state.apps.filter((a) => a.usable);
      const old = state.apps.filter((a) => !a.usable);
      const calls = now.reduce((n, a) => n + a.requestsToday, 0);
      countTo(appsN, now.length, { format: formatInt });
      setText(appsN.nextElementSibling, now.length === 1 ? "app" : "apps");
      countTo(callsN, calls, { format: formatInt });
      setText(callsN.nextElementSibling, calls === 1 ? "request today" : "requests today");
      summary.hidden = now.length === 0;
      patchList(list, now, (a) => a.id, appRow);
      list.hidden = now.length === 0;
      emptyHost.hidden = now.length > 0 || Boolean(state.keysError);
      gone.hidden = old.length === 0;
      if (old.length) {
        const open = gone.open;
        gone.replaceChildren(
          h("summary", {}, `Expired and revoked (${formatInt(old.length)})`),
          h("div", { class: "list" }, old.map((a) => h("div", { class: "list-row static dev-row" }, iconTile("lock", "gray", "sm"), h("span", { class: "names" }, h("span", { class: "nm" }, a.name), h("span", { class: "sub" }, `${a.badge.word} · ${a.expiryText}`)), pill(a.statusText, "bad")))),
        );
        gone.open = open;
      }
    };
    wrap.append(summary, list, emptyHost, gone, scopeFinder());
    paint();
    if (!state.keysError) {
      deps.every(APPS_MS, async () => {
        await reloadApps();
        if (view === "apps") paint();
      });
    }
    return wrap;
  }

  /** One app: a row that opens its sheet. Updated in place on each refresh, so focus and the sheet's trigger survive. */
  function appRow(a, existing) {
    const glyph = { excel: "integrations", mcp: "bolt" }[a.clientKind] ?? (a.scopes.includes("admin") ? "keys" : a.scopes.includes("paper") ? "orders" : "chart");
    const tint = { excel: "green", mcp: "purple" }[a.clientKind] ?? (a.scopes.includes("admin") ? "red" : a.scopes.includes("paper") ? "orange" : "teal");
    if (existing) {
      setText(existing.querySelector(".nm"), a.name);
      setText(existing.querySelector(".sub"), appUseLine(a));
      setText(existing.querySelector(".dev-scope"), a.badge.word);
      existing.onclick = () => openApp(a);
      return existing;
    }
    return h(
      "button",
      { type: "button", class: "list-row dev-row", "data-key": a.id, onclick: () => openApp(a), "aria-haspopup": "dialog" },
      iconTile(glyph, tint, "sm"),
      h("span", { class: "names" }, h("span", { class: "nm" }, a.name), h("span", { class: "sub dev-sub" }, appUseLine(a))),
      h("span", { class: `pill ${a.badge.tone}` }, h("span", { class: "pdot" }), h("span", { class: "dev-scope" }, a.badge.word)),
      icon("chevron"),
    );
  }

  // The scope finder: type what you want to call, learn which key it needs.
  function scopeFinder() {
    const input = h("input", { type: "search", id: "dev-find", placeholder: "Try: history, orders, keys", "aria-label": "Find a call and see which key it needs", autocomplete: "off", spellcheck: "false" });
    const clear = h("button", { type: "button", class: "clear", "aria-label": "Clear", onclick: () => ((input.value = ""), run(), input.focus()) }, icon("close"));
    const out = h("div", { class: "dev-find-out", "aria-live": "polite" });
    const chips = h("div", { class: "chips dev-find-chips" }, ["ltp", "history", "optionchain", "orders", "keys"].map((w) => h("button", { type: "button", class: "chip-btn", onclick: () => ((input.value = w), run()) }, w)));
    function run() {
      const found = findRoutes(state.routes, input.value);
      if (!input.value.trim()) return out.replaceChildren(h("p", { class: "dev-small" }, "Every call needs a key with a scope. Type a word from the path and see which one. Read keys cover prices and data; paper keys add practice orders; admin keys manage the Bridge itself from this computer."));
      if (!found.length) return out.replaceChildren(h("p", { class: "dev-small" }, state.routes.length ? "No call matches. Try a word from the path, like orders or history." : "This Bridge did not list its calls. Open the OpenAPI description instead."));
      out.replaceChildren(
        h(
          "ul",
          { class: "list dev-found" },
          found.map((r) => {
            const preset = presetForScope(r.scope);
            return h(
              "li",
              { class: "list-row static dev-found-row" },
              h("span", { class: `method m-${r.method}` }, r.method),
              h("span", { class: "names" }, h("span", { class: "nm mono" }, r.path), h("span", { class: "sub dev-wrap" }, r.words)),
              r.scope ? pill(r.scope, r.scope === "admin" ? "warn" : "info") : pill(r.auth === "none" ? "no key" : "own sign-in"),
              preset ? h("button", { type: "button", class: "small tinted", onclick: () => openCreate(preset) }, "Make one") : null,
            );
          }),
        ),
      );
    }
    input.addEventListener("input", run);
    run();
    return h(
      "section",
      { class: "card dev-card", "aria-labelledby": "dev-find-h" },
      h("header", { class: "card-head" }, iconTile("search", "blue"), h("div", { class: "card-titles" }, h("h2", { id: "dev-find-h" }, "Which key does a call need?"), h("p", {}, scopeAdvice("read")))),
      h("div", { class: "card-body stack" }, h("div", { class: "search-field dev-find" }, searchIcon(), input, clear), chips, out),
    );
  }

  // ── View: Requests (live, by app) ──
  function requestsPanel() {
    const wrap = h("div", { class: "stack dev-requests" });
    let status = "all";
    let q = "";
    let paused = false;
    let app_ = state.appFilter;
    const select = h("select", { id: "dev-log-app", "aria-label": "Show requests from" });
    let optionsKey = "";
    const fillSelect = () => {
      const opts = logFilters(state.apps, state.requests);
      // Only when the choices changed: a select that is rebuilt every poll closes while it is open.
      const key = JSON.stringify(opts);
      if (key !== optionsKey) {
        optionsKey = key;
        select.replaceChildren(...opts.map(([v, label]) => h("option", { value: v }, label)));
      }
      if (!opts.some(([v]) => v === app_)) app_ = "all";
      if (select.value !== app_) select.value = app_;
    };
    const search = h("input", { type: "search", id: "dev-log-q", placeholder: "Filter by path or status", "aria-label": "Filter requests", autocomplete: "off", spellcheck: "false" });
    const clear = h("button", { type: "button", class: "clear", "aria-label": "Clear the filter", onclick: () => ((search.value = ""), (q = ""), paint(), search.focus()) }, icon("close"));
    const chips = h("div", { class: "aa-chips", role: "group", "aria-label": "Outcome" });
    const chipN = {};
    for (const [id, text] of [["all", "All"], ["ok", "Succeeded"], ["err", "Errors"]]) {
      chipN[id] = h("span", { class: "aa-n" }, "0");
      chips.append(h("button", { type: "button", class: "chip-btn", "data-status": id, "aria-pressed": String(id === "all"), onclick: () => ((status = id), paint()) }, `${text} `, chipN[id]));
    }
    const pause = h("button", { type: "button", class: "small", "aria-pressed": "false", onclick: () => {
      paused = !paused;
      pause.setAttribute("aria-pressed", String(paused));
      pause.replaceChildren(icon(paused ? "play" : "clock"), paused ? "Resume" : "Pause");
      live.textContent = paused ? "Paused. The list stays as it is." : "Updating every 3 seconds.";
    } }, icon("clock"), "Pause");
    const live = h("span", { class: "dev-live", role: "status" }, "Updating every 3 seconds.");
    const list = h("ul", { class: "list aa-log dev-log", "aria-label": "Requests, newest first" });
    const stats = h("p", { class: "aa-foot dev-stats", "aria-live": "polite" });
    const empty = h("div", { class: "card dev-log-empty" });

    function logRow(x, existing) {
      if (existing) return existing;
      const failed = isErrorStatus(x.status);
      const st = [pill(String(x.status), statusTone(x.status)), failed ? h("button", { type: "button", class: "icon-btn tiny dev-why", "aria-label": `Explain status ${x.status}`, "data-tip": "What does this mean?", onclick: () => go("errors", { status: String(x.status) }) }, icon("info")) : null];
      return h(
        "li",
        { class: "aa-row dev-log-row", "data-key": x.requestId },
        h("span", { class: "aa-time" }, istTime(x.at)),
        h("span", { class: `method aa-method m-${x.method}` }, x.method),
        h("span", { class: "aa-path mono", title: x.path }, x.path),
        h("span", { class: "aa-status dev-st" }, ...st),
        h("span", { class: "aa-ms" }, `${formatInt(x.ms)} ms`),
        h("span", { class: "aa-key" }, requestOwner(x, state.apps)),
      );
    }

    function paint() {
      fillSelect();
      const base_ = filterRequests(state.requests, { app: app_, q });
      const okN = base_.filter((x) => x.status < 400).length;
      chipN.all.textContent = formatInt(base_.length);
      chipN.ok.textContent = formatInt(okN);
      chipN.err.textContent = formatInt(base_.length - okN);
      for (const b of chips.children) b.setAttribute("aria-pressed", String(b.dataset.status === status));
      const rows = filterRequests(state.requests, { app: app_, q, status }).slice(0, 100);
      const st = requestStats(rows);
      setText(stats, rows.length ? `${formatInt(rows.length)} shown · ${formatInt(st.errors)} ${st.errors === 1 ? "error" : "errors"}${st.medianMs !== null ? ` · median ${formatInt(st.medianMs)} ms` : ""}. Kept in memory only: the last 200 requests, paths only, never query strings, bodies or keys.` : "");
      patchList(list, rows, (x) => x.requestId, logRow);
      list.hidden = rows.length === 0;
      if (state.requestsError) {
        empty.replaceChildren(alertBox(state.requestsError));
      } else if (!rows.length) {
        const mine = app_ !== "all" && app_ !== "dashboard" && app_ !== "none" ? state.apps.find((a) => a.id === app_) : null;
        empty.replaceChildren(
          state.requests.length
            ? emptyState("search", "No requests match", "Change the app, the outcome or the words to see more.", h("button", { type: "button", class: "small", onclick: () => ((app_ = "all"), (status = "all"), (search.value = ""), (q = ""), paint()) }, "Show everything"))
            : emptyState("activity", mine ? `${mine.name} has not called yet` : "No requests yet", `Requests from your scripts, charts, Excel and AI tools appear here as they arrive. Try the first call from Start.`, h("button", { type: "button", class: "primary", onclick: () => go("start") }, "Go to Start")),
        );
      }
      empty.hidden = rows.length > 0 ? true : false;
    }
    select.addEventListener("change", () => {
      app_ = select.value;
      state.appFilter = app_;
      if (app_ === "all") deps.setHashParam("app", "all");
      else deps.setHashParam("app", app_);
      paint();
    });
    search.addEventListener("input", () => ((q = search.value), paint()));

    const refresh = async () => {
      if (paused) return;
      try {
        const r = await api("/v1/requests?limit=200");
        state.requests = r.data.data ?? [];
        state.requestsError = null;
      } catch (e) {
        state.requestsError = e;
      }
      if (view === "requests") paint();
    };
    wrap.append(
      h("div", { class: "aa-bar dev-bar" }, h("label", { class: "field dev-app-pick", for: "dev-log-app" }, h("span", {}, "App"), select), h("div", { class: "search-field aa-search" }, searchIcon(), search, clear), chips),
      h("div", { class: "dev-livebar" }, pause, live),
      list,
      empty,
      stats,
    );
    fillSelect();
    paint();
    deps.every(LOG_MS, refresh);
    refresh();
    return wrap;
  }

  // ── View: Errors (the catalogue) ──
  function errorsPanel() {
    const wrap = h("div", { class: "stack dev-errors" });
    if (state.catalogueError || !state.catalogue) {
      wrap.append(alertBox(state.catalogueError ?? { title: "The error list is not available", detail: "This Bridge did not answer GET /v1/errors. Update the Bridge." }));
      return wrap;
    }
    const all = state.catalogue;
    let group = "all";
    let q = "";
    let only = Number(deps.hashParams().get("status")) || null;
    const openCode = deps.hashParams().get("code");
    const search = h("input", { type: "search", id: "dev-err-q", placeholder: "Search a code, a status or a word", "aria-label": "Search error codes", autocomplete: "off", spellcheck: "false" });
    const clear = h("button", { type: "button", class: "clear", "aria-label": "Clear the search", onclick: () => ((search.value = ""), (q = ""), paint(), search.focus()) }, icon("close"));
    const chips = h("div", { class: "aa-chips", role: "group", "aria-label": "Kind of error" });
    for (const [id, label] of ERROR_GROUPS) chips.append(h("button", { type: "button", class: "chip-btn", "data-group": id, "aria-pressed": String(id === "all"), onclick: () => ((group = id), (only = null), deps.setHashParam("status", ""), paint()) }, label));
    const statusChip = h("div", { class: "dev-status-chip", hidden: true });
    const list = h("div", { class: "list dev-err-list" });
    const count = h("p", { class: "aa-foot", "aria-live": "polite" });
    const entry = (e) => {
      const d = h(
        "details",
        { class: "list-row static dev-err", id: `err-${e.code}`, "data-code": e.code },
        h("summary", {}, h("code", { class: "dev-err-code" }, e.code), h("span", { class: "dev-err-title" }, e.title), h("span", { class: "dev-err-pills" }, pill(String(e.status), e.status < 500 ? (e.status === 429 ? "warn" : "info") : "bad"), pill(e.retryable ? "Safe to retry" : "Do not retry unchanged", e.retryable ? "ok" : "warn"))),
        h(
          "div",
          { class: "dev-err-body" },
          h("dl", { class: "dev-err-dl" }, h("dt", {}, "What it means"), h("dd", {}, e.means), h("dt", {}, "What to do"), h("dd", {}, e.fix), h("dt", {}, "Retrying"), h("dd", {}, e.retry)),
          h("div", { class: "dev-err-acts" }, copyButton(e.code, { label: "Copy code", toastLabel: "Code copied", ariaLabel: `Copy ${e.code}` }), copyButton(`${location.href.split("#")[0]}#/developers?view=errors&code=${e.code}`, { label: "Copy link", toastLabel: "Link copied", cls: "small plain", ariaLabel: `Copy a link to ${e.code}` })),
          deps.snippetBlock({ title: "What the answer looks like", lang: "json", code: sampleProblem(e) }),
        ),
      );
      return d;
    };
    function paint() {
      for (const b of chips.children) b.setAttribute("aria-pressed", String(b.dataset.group === group));
      statusChip.hidden = only === null;
      if (only !== null) statusChip.replaceChildren(h("span", {}, `Showing status ${only}`), h("button", { type: "button", class: "small plain", onclick: () => ((only = null), deps.setHashParam("status", ""), paint()) }, icon("close"), "Show all"));
      const rows = filterCatalogue(all, { q, group, status: only });
      if (!rows.length) {
        list.replaceChildren(emptyState("search", "No error matches", only !== null ? `This Bridge has no catalogue entry for status ${only}. It may come from a proxy or a tunnel in front of it.` : "Try a code, a status number or a word like retry.", h("button", { type: "button", class: "small", onclick: () => ((q = ""), (group = "all"), (only = null), (search.value = ""), paint()) }, "Show all")));
      } else list.replaceChildren(...rows.map(entry));
      setText(count, `${formatInt(rows.length)} of ${formatInt(all.length)} error codes. Codes are stable: they are added, never renamed. Read the code, not the text.`);
    }
    search.addEventListener("input", () => ((q = search.value), paint()));
    wrap.append(
      h("p", { class: "dev-lead" }, "Every error answer has a `code`, a `status` and a `retryable` flag. This is every code this Bridge can send, with what to do about it."),
      h("div", { class: "aa-bar dev-bar" }, h("div", { class: "search-field aa-search" }, searchIcon(), search, clear), chips),
      statusChip,
      list,
      count,
    );
    paint();
    if (openCode) {
      const d = list.querySelector(`#err-${CSS.escape(openCode)}`);
      if (d) {
        d.open = true;
        queueMicrotask(() => d.scrollIntoView?.({ block: "center" }));
      }
    }
    return wrap;
  }

  show();
  return root;
}
