// Sources > Providers: a catalogue of where data can come from. Your own brokers (pooled only with your consent) and
// the free and key-based sources, each with what it gives, how current it is, whether it is official, its terms, its
// state and a switch. Turning a source on is a guided sheet: a notice to acknowledge (opt-in sources), or a key to paste
// and test (key-based sources). Keys are sent once and never shown again.

import { alertBox, api, emptyState, h, icon, iconTile, istTime, modal, optional, toast } from "./app.js";
import { capabilityText, classAdvice, consentProblem, enableSteps, forgetSwitch, poolingModel, providerState, rememberSwitch, shortWait, tierChipText, withSwitches, POLICY_NOTE, POLICY_TONE, POLICY_WORD, classLabel } from "./sources-core.js";
import { brokerTile, classPill, createKeyedList, createPoller, healthTag, labelsHelp, officialBadge, setAttr, setData, setText, updateClassPill } from "./sources-ui.js";
import { formatInt, plural } from "./format.js";

const isMissing = (err) => err && (err.status === 404 || err.status === 405 || err.status === 501);

/** Run `fn`, putting a failure in `slot` as an alert (and returning false). */
/** Run `fn`; `asked("on")` is called first (the page can show the switch on at once) and `asked("failed")` if it did not work. */
async function attempt(slot, fn, asked = null) {
  slot.replaceChildren();
  asked?.("on");
  try {
    await fn();
    return true;
  } catch (err) {
    asked?.("failed");
    slot.replaceChildren(alertBox(err));
    return false;
  }
}

// ── The sheets ──

/** The notice of an opt-in source: what you are agreeing to, and an explicit button. Resolves true once it is on. */
export function openNoticeSheet(src, { asked = null } = {}) {
  const slot = h("div", { class: "sx-slot", role: "alert" });
  const note = src.terms?.note ?? "This source has its own terms.";
  return modal({
    title: `Turn on ${src.name}?`,
    body: h(
      "div",
      { class: "sx-sheet" },
      h("p", { class: "sx-badges" }, classPill(src.class, src.delaySec), " ", officialBadge(src.official)),
      h("h3", { class: "group-title sx-sheet-h" }, "What you agree to"),
      h("blockquote", { class: "sx-quote" }, note),
      h("p", {}, classAdvice(src.class, src.delaySec)),
      src.terms?.url ? h("a", { href: src.terms.url, target: "_blank", rel: "noopener noreferrer", class: "sx-ext" }, "Read the vendor's terms", icon("external")) : null,
      h("p", { class: "hint" }, "The Bridge records that you accepted this notice, and asks again if it changes."),
      slot,
    ),
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "I understand, turn it on",
        cls: "primary",
        onClick: async () => ((await attempt(slot, () => api(`/v1/sources/${encodeURIComponent(src.id)}`, { method: "PATCH", body: { enabled: true, acknowledge: src.noticeVersion } }), asked)) ? true : false),
      },
    ],
  });
}

/**
 * The key sheet: paste the key (a secure field), save it, test it, then turn the source on. The key is sent once and is
 * never shown again; afterwards the page says only "Key saved". Resolves true once the source is on.
 */
export function openKeySheet(src, { replacing = false, asked = null } = {}) {
  const slot = h("div", { class: "sx-slot", role: "alert" });
  const input = h("input", { type: "password", id: "sx-key", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-describedby": "sx-key-hint", placeholder: "Paste your key here" });
  const show = h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Show the key", "aria-pressed": "false" }, icon("eye"));
  show.addEventListener("click", () => {
    const on = input.type === "password";
    input.type = on ? "text" : "password";
    show.setAttribute("aria-pressed", String(on));
    show.setAttribute("aria-label", on ? "Hide the key" : "Show the key");
    show.replaceChildren(icon(on ? "eyeoff" : "eye"));
  });
  const field = h("label", { class: "field", for: "sx-key" }, h("span", {}, "Your key"), h("div", { class: "input-affix" }, input, show), h("span", { class: "hint", id: "sx-key-hint" }, "It is stored in the Bridge's secure store on this computer and is never shown again."));
  const saved = h("div", { class: "sx-saved-box", hidden: true, role: "status" }, h("span", { class: "sx-keyok" }, icon("check"), "Key saved"));
  const testBtn = h("button", { type: "button", class: "small tinted" }, icon("bolt"), "Test the key");
  const testOut = h("p", { class: "sx-test", role: "status" });
  saved.append(testBtn, testOut);
  let phase = "enter";
  let primary = null;
  const steps = enableSteps({ ...src, configured: false });
  const needsNotice = src.tier === "opt-in";

  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    testBtn.setAttribute("aria-busy", "true");
    testOut.className = "sx-test";
    setText(testOut, "Testing…");
    try {
      const r = await api(`/v1/sources/${encodeURIComponent(src.id)}/test`, { method: "POST" });
      const t = r.data?.data ?? r.data ?? {};
      testOut.className = `sx-test ${t.ok ? "ok" : "bad"}`;
      setText(testOut, t.ok ? `It works. ${t.latencyMs ? `Answered in ${formatInt(t.latencyMs)} ms. ` : ""}${t.detail ?? ""}`.trim() : `That did not work. ${t.detail ?? "The source did not accept the key."}`);
    } catch (err) {
      testOut.className = "sx-test bad";
      setText(testOut, err?.message ?? "The test could not run.");
    } finally {
      testBtn.disabled = false;
      testBtn.removeAttribute("aria-busy");
    }
  });

  return modal({
    dirty: () => phase === "enter" && input.value.trim() !== "",
    title: replacing ? `Replace the ${src.name} key` : `Add your ${src.name} key`,
    body: h(
      "div",
      { class: "sx-sheet" },
      h("p", {}, `${src.name} needs your own key. Get one from the vendor, paste it here, and the Bridge keeps it for you.`),
      src.terms?.note ? h("blockquote", { class: "sx-quote" }, src.terms.note) : null,
      src.terms?.url ? h("a", { href: src.terms.url, target: "_blank", rel: "noopener noreferrer", class: "sx-ext" }, "Read the vendor's terms", icon("external")) : null,
      field,
      saved,
      slot,
    ),
    buttons: [
      { label: "Close", value: false },
      {
        label: "Save the key",
        cls: "primary",
        ref: (el) => (primary = el),
        onClick: async () => {
          if (phase === "enter") {
            const key = input.value.trim();
            if (key.length < 6) {
              input.setAttribute("aria-invalid", "true");
              slot.replaceChildren(alertBox({ title: "That key looks too short", detail: "Paste the whole key from the vendor." }, "warn"));
              input.focus();
              return false;
            }
            input.removeAttribute("aria-invalid");
            const ok = await attempt(slot, () => api(`/v1/sources/${encodeURIComponent(src.id)}/config`, { method: "PUT", body: { apiKey: key } }));
            input.value = "";
            if (!ok) return false;
            phase = "saved";
            field.hidden = true;
            saved.hidden = false;
            if (replacing && src.enabled) {
              if (primary) primary.textContent = "Done";
              phase = "done";
            } else if (primary) primary.textContent = needsNotice ? "Continue" : `Turn on ${src.name}`;
            toast("Key saved");
            testBtn.focus();
            return false;
          }
          if (phase === "done") return true;
          if (needsNotice && steps.length) {
            // An opt-in source with a key still needs the notice: hand over to it.
            return "notice";
          }
          return (await attempt(slot, () => api(`/v1/sources/${encodeURIComponent(src.id)}`, { method: "PATCH", body: { enabled: true, ...(src.noticeVersion ? { acknowledge: src.noticeVersion } : {}) } }), asked)) ? "on" : false;
        },
      },
    ],
  }).then(async (v) => {
    if (v === "notice") return openNoticeSheet({ ...src, configured: true }, { asked });
    return v === "on" || v === true;
  });
}

/** The pooling consent sheet: the notice text from the Bridge, a tick and the accounts to pool. Resolves true once on. */
export function openPoolingSheet(model) {
  const slot = h("div", { class: "sx-slot", role: "alert" });
  const chosen = new Set(model.consent?.accounts ?? []);
  const tick = h("input", { type: "checkbox", id: "pool-ack" });
  const hint = h("p", { class: "hint sx-why-not", id: "pool-hint", "aria-live": "polite" });
  let submit = null;
  const refresh = () => {
    const problem = consentProblem({ ticked: tick.checked, chosen: [...chosen], groups: model.groups });
    setText(hint, problem ?? "Ready. Orders will still go only through the account they belong to.");
    if (submit) {
      submit.disabled = Boolean(problem);
      submit.setAttribute("aria-disabled", String(Boolean(problem)));
    }
  };
  tick.addEventListener("change", refresh);
  const groups = model.groups.map((g) =>
    h(
      "fieldset",
      { class: "sx-pick" },
      h("legend", { class: "group-title" }, g.holder),
      h(
        "div",
        { class: "list" },
        g.accounts.map((a) => {
          const box = h("input", { type: "checkbox", id: `pool-${a.id}`, disabled: !a.choosable, checked: chosen.has(a.id) });
          box.addEventListener("change", () => {
            if (box.checked) chosen.add(a.id);
            else chosen.delete(a.id);
            refresh();
          });
          return h(
            "label",
            { class: "list-row sx-pick-row", for: `pool-${a.id}` },
            brokerTile(a.broker, a.broker),
            h("span", { class: "names" }, h("span", { class: "nm" }, a.id), h("span", { class: "sub sx-wrap" }, POLICY_NOTE[a.policy] ?? "")),
            h("span", { class: `pill ${POLICY_TONE[a.policy]}` }, h("span", { class: "pdot", "aria-hidden": "true" }), POLICY_WORD[a.policy] ?? "Not stated"),
            box,
          );
        }),
      ),
    ),
  );
  const body = h(
    "div",
    { class: "sx-sheet" },
    h("p", {}, "Pooling spreads market-data calls across your own broker accounts, so each one has more room. It is off unless you turn it on here."),
    h("h3", { class: "group-title sx-sheet-h" }, "Read this first"),
    h("div", { class: "sx-notice", tabindex: "0", role: "region", "aria-label": "The pooling notice" }, ...String(model.notice.text || "").split(/\n+/).map((t) => h("p", {}, t))),
    h("h3", { class: "group-title sx-sheet-h" }, "Which accounts"),
    ...groups,
    h("label", { class: "check sx-ack" }, tick, h("span", {}, "I have read the notice and I accept it for the accounts I chose.")),
    hint,
    slot,
  );
  const done = modal({
    title: model.on ? "Change pooled accounts" : "Turn on pooling",
    body,
    buttons: [
      { label: "Cancel", value: false },
      {
        label: model.on ? "Save" : "Turn on pooling",
        cls: "primary",
        ref: (el) => {
          submit = el;
          refresh();
        },
        onClick: async () => {
          const problem = consentProblem({ ticked: tick.checked, chosen: [...chosen], groups: model.groups });
          if (problem) {
            setText(hint, problem);
            return false;
          }
          return (await attempt(slot, () => api("/v1/pooling/consent", { method: "PUT", body: { acknowledge: model.notice.version, accounts: [...chosen] } }))) ? true : false;
        },
      },
    ],
  });
  return done;
}

function confirmPoolingOff() {
  return modal({
    title: "Turn off pooling?",
    body: h("p", {}, "Each account will serve only its own calls again. Nothing is deleted, and you can turn pooling on again whenever you like."),
    buttons: [
      { label: "Keep it on", value: false },
      { label: "Turn it off", cls: "destructive", value: true },
    ],
  });
}

/** When a source that is on will actually be asked (it is never the first choice for real-time data). */
const fallbackUse = (auto) => (auto === true ? "Used only when your brokers cannot answer. Automatic fallback is on." : auto === false ? "Used only when your brokers cannot answer and the request allows backup data, because automatic fallback is off." : "Used only when your brokers cannot answer.");

// ── The page ──

/** @returns {Promise<HTMLElement>} the Providers tab */
export async function renderProviders() {
  const root = h("div", { class: "sx-tab" });
  let sources = null;
  let sourcesErr = null;
  let autoFallback = null;
  let pool = poolingModel(null);
  let poolErr = null;
  let lastRead = 0;
  let polls = 0;
  const pending = new Set();
  const tests = new Map();
  // A switch is shown the moment it is made (sources-core withSwitches) and the Bridge's own answer takes over when it agrees.
  function showAs(id, enabled) {
    rememberSwitch(id, enabled);
    paintSources();
  }
  /** What a sheet tells the page the moment its "turn it on" request goes out, so the switch moves then and not when the sheet has slid away. */
  const askedFor = (id) => (state) => {
    if (state === "on") showAs(id, true);
    else {
      forgetSwitch(id);
      paintSources();
    }
  };
  /** Read the Bridge again once its one-second memory has expired, in case it still disagreed. */
  const settle = () => setTimeout(() => root.isConnected && poller.tick(), 1300);

  // ── Your brokers ──
  const poolSwitch = h("input", { type: "checkbox", role: "switch", id: "pool-switch", "aria-label": "Pool my broker accounts" });
  const poolStatus = h("span", { class: "sx-pool-status" });
  const poolSub = h("p", { class: "sx-card-sub" });
  const poolBody = h("div", { class: "sx-pool-body" });
  const poolNeed = h("p", { class: "hint sx-pool-need", id: "pool-need", hidden: true }, "Pooling needs two or more of your own accounts. ", h("a", { href: "#/accounts" }, "Add one on Accounts"), ".");
  const poolChange = h("button", { type: "button", class: "small plain", hidden: true }, "Change accounts");
  const poolCard = h(
    "section",
    { class: "card sx-pool", "aria-labelledby": "sx-pool-h" },
    h("header", { class: "card-head" }, iconTile("accounts", "indigo"), h("div", { class: "card-titles" }, h("h3", { class: "sx-card-title", id: "sx-pool-h" }, "Pool your brokers"), poolSub), h("div", { class: "card-actions sx-switch-wrap" }, poolStatus, h("label", { class: "switch" }, poolSwitch, h("i")))),
    h("div", { class: "card-body stack" }, h("p", { class: "sx-pool-why" }, "Each broker limits how often the Bridge may ask it for prices. Pooling lets your accounts share the work, so busy tools get more room. It only ever moves reading prices between your own accounts. Orders never leave the account they belong to."), poolNeed, poolBody, h("div", { class: "sx-pool-acts" }, poolChange)),
  );
  const poolWrap = h("section", { class: "group sx-group", "aria-labelledby": "sx-brokers-h" }, h("h2", { class: "group-title", id: "sx-brokers-h" }, "Your brokers"), poolCard);

  poolSwitch.addEventListener("change", async () => {
    const want = poolSwitch.checked;
    poolSwitch.checked = !want;
    if (want) {
      if (await openPoolingSheet(pool)) {
        toast("Pooling is on");
        await poller.tick();
      }
    } else if (await confirmPoolingOff()) {
      try {
        await api("/v1/pooling/consent", { method: "DELETE" });
        toast("Pooling is off");
      } catch (err) {
        toast(err?.message ?? "Pooling could not be turned off", { tone: "error" });
      }
      await poller.tick();
    }
  });
  poolChange.addEventListener("click", async () => {
    if (await openPoolingSheet(pool)) {
      toast("Pooled accounts saved");
      await poller.tick();
    }
  });

  function paintPool() {
    if (poolErr) {
      poolBody.replaceChildren(isMissing(poolErr) ? alertBox({ title: "Pooling needs a newer Bridge", detail: "This Bridge cannot pool broker accounts yet. Everything else here still works." }, "info") : alertBox(poolErr));
      poolSwitch.disabled = true;
      poolSwitch.checked = false;
      poolNeed.hidden = true;
      setText(poolSub, "Not available");
      setText(poolStatus, "");
      poolChange.hidden = true;
      return;
    }
    poolSwitch.checked = pool.on;
    poolSwitch.disabled = !pool.on && !pool.canPool;
    // A switch that cannot be used says why, for everyone: a line beside it and the same words for a screen reader.
    poolNeed.hidden = !poolSwitch.disabled;
    setAttr(poolSwitch, "aria-describedby", poolSwitch.disabled ? "pool-need" : null);
    setText(poolStatus, pool.on ? "On" : "Off");
    setData(poolCard, "on", pool.on ? "1" : "0");
    setText(poolSub, pool.on ? `${plural(pool.inPoolCount, "account")} ${pool.inPoolCount === 1 ? "shares" : "share"} their room` : pool.canPool ? "Off. Each account serves only its own calls." : "Off. Needs two or more of your accounts.");
    poolChange.hidden = !pool.on;
    // The accounts are drawn again only when they changed, so a poll never replaces what is on screen (or has focus).
    const drawn = JSON.stringify(pool.groups);
    if (poolBody.dataset.drawn === drawn) return;
    poolBody.dataset.drawn = drawn;
    const nodes = [];
    if (!pool.groups.length) nodes.push(emptyState("accounts", "No broker accounts yet", "Connect two or more of your broker accounts and you can pool them here.", h("button", { type: "button", class: "primary", onclick: () => (location.hash = "#/accounts") }, "Go to Accounts")));
    for (const g of pool.groups) {
      nodes.push(
        h(
          "div",
          { class: "sx-pool-group" },
          pool.groups.length > 1 || g.holder ? h("h4", { class: "group-title sx-sub-h" }, g.holder) : null,
          h(
            "div",
            { class: "list" },
            g.accounts.map((a) =>
              h(
                "div",
                { class: "list-row static sx-acct" },
                brokerTile(a.broker, a.broker),
                h("span", { class: "names" }, h("span", { class: "nm" }, a.id), h("span", { class: "sub sx-wrap" }, a.inPool ? "In the pool" : POLICY_NOTE[a.policy] ?? "")),
                h("span", { class: `pill ${POLICY_TONE[a.policy]}` }, h("span", { class: "pdot", "aria-hidden": "true" }), POLICY_WORD[a.policy] ?? "Not stated"),
              ),
            ),
          ),
        ),
      );
    }
    poolBody.replaceChildren(...nodes);
  }

  // ── Free and key-based sources ──
  const grid = h("div", { class: "sx-prov-grid" });
  const list = createKeyedList(grid, { key: (s) => s.id, create: createCard, update: updateCard });
  const gridEmpty = h("div", { class: "list", hidden: true });
  const provFoot = h("p", { class: "group-foot sx-prov-foot" });
  const fallbackRow = h("p", { class: "sx-fallback", hidden: true });
  const provGroup = h(
    "section",
    { class: "group sx-group", "aria-labelledby": "sx-free-h" },
    h("h2", { class: "group-title", id: "sx-free-h" }, "Free and key-based sources"),
    h("p", { class: "sx-prov-intro" }, "Where your brokers cannot answer, or a delay is fine, these sources can. Every answer from one is labelled with how current it is, and none is ever used for orders, risk checks, paper fills or alerts."),
    fallbackRow,
    labelsHelp(),
    grid,
    gridEmpty,
    provFoot,
  );

  function createCard(src) {
    const title = h("h3", { class: "sx-card-title" }, src.name);
    const cls = classPill(src.class, src.delaySec);
    const off = officialBadge(src.official);
    const tier = h("span", { class: "chip" }, tierChipText(src));
    const input = h("input", { type: "checkbox", role: "switch", "aria-label": `Use ${src.name}` });
    const sw = h("label", { class: "switch" }, input, h("i"));
    const gives = h("p", { class: "sx-gives" });
    const advice = h("p", { class: "sx-advice" });
    const use = h("p", { class: "sx-advice sx-use", hidden: true });
    const note = h("p", { class: "sx-note" });
    const link = h("a", { class: "sx-ext", target: "_blank", rel: "noopener noreferrer" }, "Read the vendor's terms", icon("external"));
    const tag = healthTag();
    const state = h("p", { class: "sx-state" }, tag.el, h("span", { class: "sx-state-text", role: "status" }));
    const retry = h("time", { class: "sx-retry" });
    const keyBtn = h("button", { type: "button", class: "small" }, icon("keys"), "Add key");
    const testBtn = h("button", { type: "button", class: "small tinted" }, icon("bolt"), "Test");
    const keyOk = h("span", { class: "sx-keyok", hidden: true }, icon("check"), "Key saved");
    const testOut = h("p", { class: "sx-test", role: "status" });
    const el = h(
      "article",
      { class: "card sx-prov", "aria-labelledby": `sx-p-${src.id}` },
      h("header", { class: "sx-prov-head" }, iconTile("sources", "teal", "md"), h("div", { class: "sx-prov-titles" }, title, h("div", { class: "sx-prov-badges" }, cls, off, tier)), sw),
      h("div", { class: "sx-prov-body" }, gives, advice, use, note, link, state, h("div", { class: "sx-prov-actions" }, keyOk, keyBtn, testBtn), testOut),
    );
    title.id = `sx-p-${src.id}`;
    el._parts = { title, cls, off, tier, input, sw, gives, advice, use, note, link, tag, stateText: state.lastChild, retry, keyBtn, testBtn, keyOk, testOut, state };
    state.append(retry);
    input.addEventListener("change", () => onToggle(el._src, input));
    keyBtn.addEventListener("click", async () => {
      const src = el._src;
      if (await openKeySheet(src, { replacing: src.configured, asked: askedFor(src.id) })) {
        showAs(src.id, true);
        toast(`${src.name} is on`);
      }
      await poller.tick();
      settle();
    });
    testBtn.addEventListener("click", () => runTest(el));
    return el;
  }

  function updateCard(el, src) {
    const p = el._parts;
    el._src = src;
    const st = providerState(src, { time: istTime });
    setText(p.title, src.name);
    updateClassPill(p.cls, src.class, src.delaySec);
    p.off.className = `chip sx-official${src.official ? "" : " unofficial"}`;
    setText(p.off, src.official ? "Official" : "Unofficial");
    setText(p.tier, tierChipText(src));
    p.tier.hidden = src.tier === "builtin";
    setText(p.gives, `Gives ${capabilityText(src.capabilities)}.`);
    setText(p.advice, classAdvice(src.class, src.delaySec));
    // Turning a free source on does not mean it is asked: say when it will be.
    p.use.hidden = !st.on;
    setText(p.use, st.on ? fallbackUse(autoFallback) : "");
    setText(p.note, src.terms?.note ?? "");
    p.note.hidden = !src.terms?.note;
    if (src.terms?.url) {
      setAttr(p.link, "href", src.terms.url);
      p.link.hidden = false;
    } else p.link.hidden = true;
    p.tag.set(st);
    setText(p.stateText, st.detail);
    const until = st.state === "paused" && st.nextTryAt ? Date.parse(st.nextTryAt) : null;
    setData(p.retry, "until", Number.isFinite(until) ? until : null);
    if (!Number.isFinite(until)) setText(p.retry, "");
    setData(el, "state", st.state);
    const busy = pending.has(src.id);
    p.input.checked = st.on;
    p.input.disabled = busy || !st.canSwitch;
    if (busy) p.input.setAttribute("aria-busy", "true");
    else p.input.removeAttribute("aria-busy");
    if (src.tier === "plugin") p.input.setAttribute("title", "Plugins are approved from the command line on this computer.");
    const needsKey = Boolean(src.needsKey);
    p.keyBtn.hidden = !needsKey;
    setText(p.keyBtn.lastChild, src.configured ? "Replace key" : "Add key");
    p.keyBtn.classList.toggle("primary", st.state === "rejected");
    p.keyOk.hidden = !(needsKey && src.configured);
    p.testBtn.hidden = !(src.configured && (src.enabled || needsKey));
    const t = tests.get(src.id);
    p.testOut.className = `sx-test ${t ? (t.ok ? "ok" : "bad") : ""}`.trim();
    setText(p.testOut, t?.text ?? "");
    p.testOut.hidden = !t;
  }

  async function onToggle(src, input) {
    const want = input.checked;
    input.checked = !want;
    if (pending.has(src.id)) return;
    if (!want) {
      pending.add(src.id);
      showAs(src.id, false);
      try {
        await api(`/v1/sources/${encodeURIComponent(src.id)}`, { method: "PATCH", body: { enabled: false } });
        toast(`${src.name} is off`);
      } catch (err) {
        forgetSwitch(src.id);
        toast(err?.message ?? "It could not be turned off", { tone: "error" });
      } finally {
        pending.delete(src.id);
      }
      await poller.tick();
      settle();
      return;
    }
    const steps = enableSteps(src);
    let on = false;
    if (steps.includes("key")) on = await openKeySheet(src, { asked: askedFor(src.id) });
    else if (steps.includes("notice")) on = await openNoticeSheet(src, { asked: askedFor(src.id) });
    else {
      pending.add(src.id);
      showAs(src.id, true);
      try {
        await api(`/v1/sources/${encodeURIComponent(src.id)}`, { method: "PATCH", body: { enabled: true, ...(src.noticeVersion ? { acknowledge: src.noticeVersion } : {}) } });
        on = true;
      } catch (err) {
        forgetSwitch(src.id);
        toast(err?.message ?? "It could not be turned on", { tone: "error" });
      } finally {
        pending.delete(src.id);
      }
    }
    if (on) {
      showAs(src.id, true);
      toast(`${src.name} is on. Its answers are labelled ${classLabel(src.class, src.delaySec)}.${autoFallback === false ? " It is asked only when a request allows backup data." : ""}`);
    } else paintSources();
    await poller.tick();
    if (on) settle();
  }

  async function runTest(el) {
    const src = el._src;
    const p = el._parts;
    p.testBtn.disabled = true;
    p.testBtn.setAttribute("aria-busy", "true");
    tests.set(src.id, { ok: true, text: "Testing…" });
    updateCard(el, src);
    try {
      const r = await api(`/v1/sources/${encodeURIComponent(src.id)}/test`, { method: "POST" });
      const t = r.data?.data ?? r.data ?? {};
      tests.set(src.id, { ok: Boolean(t.ok), text: t.ok ? `It works. ${t.latencyMs ? `Answered in ${formatInt(t.latencyMs)} ms. ` : ""}${t.detail ?? ""}`.trim() : `That did not work. ${t.detail ?? "The source did not answer."}` });
    } catch (err) {
      tests.set(src.id, { ok: false, text: err?.message ?? "The test could not run." });
    } finally {
      p.testBtn.disabled = false;
      p.testBtn.removeAttribute("aria-busy");
      updateCard(el, src);
    }
  }

  function paintSources() {
    const free = (sources ?? []).filter((s) => s.kind !== "broker");
    gridEmpty.hidden = free.length > 0 || Boolean(sourcesErr);
    grid.hidden = free.length === 0;
    if (!free.length && sourcesErr) {
      gridEmpty.hidden = false;
      gridEmpty.replaceChildren(isMissing(sourcesErr) ? emptyState("sources", "Free sources need a newer Bridge", "This Bridge does not have data sources yet. Your broker accounts keep working as before.", null) : alertBox(sourcesErr));
    } else if (!free.length) {
      gridEmpty.replaceChildren(emptyState("sources", "No free sources here yet", "A source is a small read-only module. When one is installed it appears here, off, until you turn it on.", null));
    }
    list.sync(withSwitches(free), { reorder: false });
    if (typeof autoFallback === "boolean") {
      fallbackRow.hidden = false;
      setText(fallbackRow, autoFallback ? "Automatic fallback is on: when your brokers cannot answer, the Bridge tries the sources you turned on and labels each answer." : "Automatic fallback is off, so a source you turn on is asked only when a request allows backup data. To use it whenever your brokers cannot answer, set sources.autoFallback to true in bridge.config.json.");
    } else fallbackRow.hidden = true;
    setText(provFoot, free.length ? "The Bridge does not redistribute this data. Use it for yourself only, and follow each vendor's terms." : "");
  }

  function tick() {
    const now = Date.now();
    for (const t of root.querySelectorAll("time.sx-retry[data-until]")) {
      const left = Number(t.dataset.until) - now;
      setText(t, left > 0 ? ` (in ${shortWait(left)})` : "");
    }
  }

  async function poll() {
    polls += 1;
    const again = polls % 15 === 0;
    const [s, p] = await Promise.all([sourcesErr && isMissing(sourcesErr) && !again ? Promise.resolve({ error: sourcesErr }) : optional(api("/v1/sources", { fresh: true })), poolErr && isMissing(poolErr) && !again ? Promise.resolve({ error: poolErr }) : optional(api("/v1/pooling", { fresh: true }))]);
    if (!root.isConnected && lastRead) return;
    lastRead = Date.now();
    sourcesErr = s.error ?? null;
    if (s.data) {
      sources = s.data.data ?? [];
      autoFallback = s.data.meta?.autoFallback;
    }
    poolErr = p.error ?? null;
    if (p.data) pool = poolingModel(p.data.data ?? p.data);
    // A sheet over the page is not interrupted by a redraw of the switch it is about to change.
    paintPool();
    paintSources();
    tick();
  }

  const poller = createPoller({ root, ms: 4000, run: poll });
  const clock = setInterval(() => (root.isConnected ? tick() : clearInterval(clock)), 1000);
  root.append(poolWrap, provGroup);
  await poll();
  if (sourcesErr && !sources && poolErr && !pool.groups.length && !isMissing(sourcesErr) && !isMissing(poolErr)) {
    const retry = h("button", { type: "button", class: "small", onclick: () => poller.tick() }, icon("refresh"), "Try again");
    const box = alertBox(sourcesErr);
    box.lastElementChild.append(h("div", { class: "alert-actions" }, retry));
    root.prepend(box);
  }
  poller.start();
  return root;
}

