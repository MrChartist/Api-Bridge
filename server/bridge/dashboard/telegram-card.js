// API > Integrations > Telegram: get the Bridge's alerts on a phone and ask for prices and status from Telegram.
//
// Everything here goes through the Bridge's own routes (/v1/notify/*), which accept a bot token only from this computer and
// never send one back: the page only ever shows the bot's name, four characters of the token and the last four digits of a
// chat id. Four short parts: connect the bot (paste the token), find your chat (send the bot a message, confirm it), choose
// what is sent (plain labels), and check it works (a test message, and what went wrong in plain words).
//
// The card draws itself and keeps its own state; views.js only mounts it. Read-only by design: the page says plainly that
// orders are approved on this computer.

import { groupEvents, healthView } from "./telegram-core.js";
import { alertBox, api, emptyState, h, icon, iconTile, istTime, modal, optional, pill, toast } from "./app.js";

const missing = (err) => err && (err.status === 404 || err.status === 405 || err.status === 501);
const busy = (b, on) => {
  b.disabled = on;
  if (on) b.setAttribute("aria-busy", "true");
  else b.removeAttribute("aria-busy");
};

/**
 * @param {{ guideHref?: string }} [opts]
 * @returns {HTMLElement}
 */
export function createTelegramCard({ guideHref } = {}) {
  const root = h("div", { class: "stack tg-card" });
  const state = { targets: null, events: null, status: null, found: [], finding: false, changingToken: false, lastTest: null };
  let findToken = 0;
  let loadToken = 0;

  const target = () => state.targets?.[0] ?? null;
  const note = (text) => h("p", { class: "hint" }, text);

  async function load() {
    const mine = ++loadToken;
    const [t, e, s] = await Promise.all([optional(api("/v1/notify/targets", { fresh: true })), optional(api("/v1/notify/events", { fresh: true })), optional(api("/v1/notify/status", { fresh: true }))]);
    if (mine !== loadToken) return;
    if (t.error) {
      root.replaceChildren(missing(t.error) ? alertBox({ title: "This Bridge has no Telegram support", detail: "Update the Bridge to use Telegram." }, "info") : alertBox(t.error));
      return;
    }
    state.targets = t.data?.data ?? [];
    state.events = e.error ? null : e.data?.data ?? null;
    state.status = s.error ? null : s.data?.data ?? null;
    draw();
  }

  // ── 1 · Connect the bot ──
  function tokenForm({ replace = false } = {}) {
    const input = h("input", { id: "tg-token", type: "password", autocomplete: "off", spellcheck: "false", autocapitalize: "off", placeholder: "123456789:ABC…", "aria-describedby": "tg-token-hint" });
    const btn = h("button", { type: "submit", class: "primary" }, icon("check"), replace ? "Save the new token" : "Check and save");
    const msg = h("div", { "aria-live": "polite" });
    const form = h(
      "form",
      { class: "stack", novalidate: true },
      h("label", { class: "field", for: "tg-token" }, h("span", {}, "Bot token"), input, h("span", { class: "hint", id: "tg-token-hint" }, "The Bridge checks it with Telegram and keeps it encrypted on this computer. It is never shown again.")),
      msg,
      h("div", { class: "row-acts" }, btn, replace ? h("button", { type: "button", class: "plain", onclick: () => ((state.changingToken = false), draw()) }, "Cancel") : null),
    );
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const token = input.value.trim();
      if (!token) {
        msg.replaceChildren(alertBox({ title: "Paste the token from BotFather first" }, "warn"));
        input.focus();
        return;
      }
      busy(btn, true);
      msg.replaceChildren();
      try {
        const r = await api("/v1/notify/targets", { method: "POST", body: { token } });
        input.value = "";
        state.changingToken = false;
        toast(r.data?.data?.replaced ? "Token replaced" : `Connected to @${r.data?.data?.bot?.username ?? "your bot"}`);
        await load();
        if (!(target()?.chats ?? []).length) startFinding();
      } catch (err) {
        input.value = "";
        msg.replaceChildren(alertBox(err));
        busy(btn, false);
      }
    });
    return form;
  }

  function connectSection() {
    const t = target();
    if (!t) {
      return h(
        "section",
        { class: "group" },
        h("h3", { class: "group-title" }, "1 · Create your bot and paste its token"),
        h(
          "div",
          { class: "card-pad stack" },
          h("ol", { class: "tg-steps" }, h("li", {}, "In Telegram, open a chat with ", h("strong", {}, "@BotFather"), " and send ", h("code", {}, "/newbot"), "."), h("li", {}, "Pick a name and a username that ends in ", h("code", {}, "bot"), ". BotFather answers with a token."), h("li", {}, "Copy the token and paste it below.")),
          tokenForm(),
          note("Only you will read these messages: the Bridge writes only to chats you confirm in step 2."),
        ),
      );
    }
    const hv = healthView(t.health);
    return h(
      "section",
      { class: "group" },
      h("h3", { class: "group-title" }, "Your bot"),
      h(
        "div",
        { class: "list" },
        h(
          "div",
          { class: "list-row static" },
          iconTile("inbox", "blue"),
          h("div", { class: "names" }, h("span", { class: "nm" }, `@${t.bot.username}`), h("span", { class: "sub tg-wrap" }, t.health?.message ?? "")),
          pill(hv.word, hv.tone),
        ),
      ),
      h("div", { class: "row-acts tg-acts" }, h("button", { type: "button", class: "small plain", onclick: () => ((state.changingToken = !state.changingToken), draw()) }, "Change token"), h("button", { type: "button", class: "small plain destructive", onclick: removeBot }, icon("trash"), "Remove this bot")),
      state.changingToken ? h("div", { class: "card-pad" }, tokenForm({ replace: true })) : null,
    );
  }

  async function removeBot() {
    const t = target();
    const ok = await modal({ title: `Remove @${t.bot.username}?`, body: h("p", {}, "The Bridge forgets the token and your chats, and stops sending alerts. Your bot stays in Telegram."), buttons: [{ label: "Cancel", value: false }, { label: "Remove", cls: "destructive", value: true }] });
    if (!ok) return;
    try {
      await api(`/v1/notify/targets/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      toast("Telegram removed");
      state.found = [];
      state.lastTest = null;
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  // ── 2 · Find my chat ──
  async function startFinding() {
    const t = target();
    if (!t || state.finding) return;
    const mine = ++findToken;
    state.finding = true;
    draw();
    for (let i = 0; i < 40 && mine === findToken && root.isConnected; i += 1) {
      const r = await optional(api(`/v1/notify/targets/${encodeURIComponent(t.id)}/find-chat`, { method: "POST" }));
      if (mine !== findToken || !root.isConnected) return;
      if (r.error) {
        state.finding = false;
        draw(alertBox(r.error));
        return;
      }
      state.found = r.data?.data ?? [];
      if (state.found.length) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (mine !== findToken) return;
    state.finding = false;
    draw();
  }
  const stopFinding = () => {
    findToken += 1;
    state.finding = false;
    draw();
  };

  async function addChat(f) {
    const t = target();
    try {
      const first = !t.chats.length;
      await api(`/v1/notify/targets/${encodeURIComponent(t.id)}/chats`, { method: "POST", body: { ref: f.ref } });
      state.found = state.found.filter((x) => x.ref !== f.ref);
      toast(`Added ${f.name}`);
      await load();
      if (first) await sendTest();
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  function chatsSection() {
    const t = target();
    if (!t) return null;
    const waiting = state.finding
      ? h("div", { class: "alert info", role: "status" }, icon("info"), h("div", {}, h("strong", {}, "Waiting for your message"), h("span", { class: "detail" }, `Open Telegram, find @${t.bot.username} and press Start (or send it any message). This page notices it by itself.`)), h("button", { type: "button", class: "small plain", onclick: stopFinding }, "Stop"))
      : null;
    const foundRows = state.found.map((f) =>
      h(
        "div",
        { class: "list-row static" },
        iconTile("accounts", "teal"),
        h("div", { class: "names" }, h("span", { class: "nm" }, f.name), h("span", { class: "sub" }, `${f.type === "private" ? "Private chat" : f.type}, id ending ${f.idHint.replace("••••", "")}`)),
        h("button", { type: "button", class: "small tinted", onclick: () => addChat(f), "aria-label": `Use the chat ${f.name}` }, icon("check"), "Use this chat"),
      ),
    );
    const chatRows = t.chats.map((c) => {
      const sw = h("input", { type: "checkbox", role: "switch", id: `tg-cmd-${c.key}`, "aria-labelledby": `tg-cn-${c.key}`, "aria-describedby": `tg-cs-${c.key}` });
      sw.checked = c.commands;
      sw.addEventListener("change", async () => {
        sw.disabled = true;
        try {
          await api(`/v1/notify/targets/${encodeURIComponent(t.id)}/chats/${c.key}`, { method: "PATCH", body: { commands: sw.checked } });
          toast(sw.checked ? `${c.name} may ask for prices and status` : `${c.name} receives alerts only`);
          await load();
        } catch (err) {
          sw.checked = !sw.checked;
          sw.disabled = false;
          toast(err.message, { tone: "error" });
        }
      });
      const bad = c.state?.message;
      return h(
        "div",
        { class: "list-row static tg-chat" },
        iconTile("accounts", bad ? "gray" : "teal"),
        h("div", { class: "names" }, h("span", { class: "nm", id: `tg-cn-${c.key}` }, c.name), h("span", { class: "sub tg-wrap", id: `tg-cs-${c.key}` }, bad ? bad : `${c.type === "private" ? "Private chat" : c.type}, id ending ${c.idHint.replace("••••", "")}. Switch on to let this chat ask for prices and status.`)),
        h("label", { class: "switch", for: `tg-cmd-${c.key}`, title: "Allow commands from this chat" }, sw, h("i")),
        h("button", { type: "button", class: "small plain destructive", "aria-label": `Remove the chat ${c.name}`, onclick: () => removeChat(c) }, icon("trash")),
      );
    });
    return h(
      "section",
      { class: "group" },
      h("h3", { class: "group-title" }, `${t.chats.length ? "Your chats" : "2 · Find your chat"} · ${t.chats.length}`),
      waiting,
      chatRows.length || foundRows.length ? h("div", { class: "list" }, chatRows, foundRows) : emptyState("accounts", "No chat yet", "Send your bot a message, then press Find my chat. You confirm which chat gets alerts.", null, { compact: true }),
      h("div", { class: "row-acts tg-acts" }, h("button", { type: "button", class: t.chats.length ? "small tinted" : "primary", onclick: startFinding, disabled: state.finding }, icon("search"), t.chats.length ? "Add another chat" : "Find my chat")),
      t.chats.some((c) => c.commands) ? note("A chat you switched on can type /price NIFTY, /positions, /orders, /funds and /status. These only read. Nobody can place or approve an order from Telegram, or release the kill switch.") : note("Chats that are not on this list are ignored: the Bridge never answers them."),
    );
  }

  async function removeChat(c) {
    const t = target();
    const ok = await modal({ title: `Remove ${c.name}?`, body: h("p", {}, "It stops receiving alerts and can no longer ask for prices."), buttons: [{ label: "Cancel", value: false }, { label: "Remove", cls: "destructive", value: true }] });
    if (!ok) return;
    try {
      await api(`/v1/notify/targets/${encodeURIComponent(t.id)}/chats/${c.key}`, { method: "DELETE" });
      toast("Chat removed");
      await load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }

  // ── 3 · What is sent ──
  async function saveEvents(body, revert) {
    try {
      const r = await api("/v1/notify/events", { method: "PUT", body });
      state.events = r.data?.data ?? state.events;
      toast("Saved");
    } catch (err) {
      revert?.();
      toast(err.message, { tone: "error" });
    }
  }

  function eventRow(e) {
    const sw = h("input", { type: "checkbox", role: "switch", id: `tg-ev-${e.key}`, "aria-labelledby": `tg-evn-${e.key}`, "aria-describedby": `tg-evs-${e.key}` });
    sw.checked = e.enabled;
    sw.addEventListener("change", () => saveEvents({ events: { [e.key]: sw.checked } }, () => (sw.checked = !sw.checked)));
    return h("div", { class: "list-row static" }, h("div", { class: "names" }, h("span", { class: "nm tg-wrap", id: `tg-evn-${e.key}` }, e.label), h("span", { class: "sub tg-wrap", id: `tg-evs-${e.key}` }, e.help)), h("label", { class: "switch", for: `tg-ev-${e.key}` }, sw, h("i")));
  }

  function timeField(id, label, value, onChange) {
    const input = h("input", { id, type: "time", value });
    input.addEventListener("change", () => /^\d\d:\d\d$/.test(input.value) && onChange(input.value));
    return h("label", { class: "field", for: id }, h("span", {}, label), input);
  }

  function eventsSection() {
    const ev = state.events;
    if (!ev) return null;
    const q = ev.quietHours;
    const qSw = h("input", { type: "checkbox", role: "switch", id: "tg-quiet", "aria-labelledby": "tg-quiet-n", "aria-describedby": "tg-quiet-s" });
    qSw.checked = q.enabled;
    qSw.addEventListener("change", () => saveEvents({ quietHours: { enabled: qSw.checked } }, () => (qSw.checked = !qSw.checked)).then(draw));
    return h(
      "section",
      { class: "group" },
      h("h3", { class: "group-title" }, "3 · Choose what you get"),
      groupEvents(ev.events).map((g) => h("div", { class: "stack tg-group" }, h("h4", { class: "group-label" }, g.title), h("div", { class: "list" }, g.events.map(eventRow)))),
      h(
        "div",
        { class: "stack tg-group" },
        h("h4", { class: "group-label" }, "Timing"),
        h(
          "div",
          { class: "list" },
          h("div", { class: "list-row static" }, h("div", { class: "names" }, h("span", { class: "nm", id: "tg-quiet-n" }, "Quiet hours"), h("span", { class: "sub tg-wrap", id: "tg-quiet-s" }, "Hold everyday alerts at night and send them as one message when it ends. The kill switch and unknown order results always come through.")), h("label", { class: "switch", for: "tg-quiet" }, qSw, h("i"))),
        ),
        q.enabled ? h("div", { class: "form-grid" }, timeField("tg-qs", "From (IST)", q.start, (v) => saveEvents({ quietHours: { start: v } })), timeField("tg-qe", "Until (IST)", q.end, (v) => saveEvents({ quietHours: { end: v } }))) : null,
        h("div", { class: "form-grid" }, timeField("tg-mt", "Morning reminder time (IST, trading days)", ev.morning.at, (v) => saveEvents({ morning: { at: v } })), timeField("tg-m2", "Second reminder (IST)", ev.morning.secondAt, (v) => saveEvents({ morning: { secondAt: v } })), timeField("tg-eod", "End-of-day summary (IST)", ev.morning.endOfDay.at, (v) => saveEvents({ morning: { endOfDay: { at: v } } }))),
        note("Reminders are sent only on trading days (weekends and exchange holidays are skipped)."),
      ),
    );
  }

  // ── 4 · Check ──
  async function sendTest() {
    const t = target();
    if (!t) return;
    try {
      const r = await api(`/v1/notify/targets/${encodeURIComponent(t.id)}/test`, { method: "POST", body: {} });
      state.lastTest = r.data?.data ?? null;
    } catch (err) {
      state.lastTest = { ok: false, delivered: 0, results: [], message: err.message };
    }
    await load();
  }

  function checkSection() {
    const t = target();
    if (!t || !t.chats.length) return null;
    const r = state.lastTest;
    const btn = h("button", { type: "button", class: "tinted", onclick: async () => (busy(btn, true), await sendTest()) }, icon("bolt"), "Send a test message");
    let result = null;
    if (r) {
      result = r.ok
        ? alertBox({ title: "Delivered", detail: `The test message reached ${r.results.map((x) => x.chat.name).join(", ")}. Check Telegram.` }, "ok")
        : alertBox({ title: "Not delivered", detail: [r.message, ...r.results.filter((x) => !x.ok).map((x) => `${x.chat.name}: ${x.error?.message ?? ""}${x.error?.retryAfterSeconds ? ` Try again in ${x.error.retryAfterSeconds} seconds.` : ""}`)].filter(Boolean).join(" ") });
    }
    const s = state.status;
    const bits = s ? [`${s.queue.depth} waiting to send`, s.lastDeliveryAt ? `last sent ${istTime(s.lastDeliveryAt)} IST` : "nothing sent yet", s.counters.ignoredMessages ? `${s.counters.ignoredMessages} message(s) from other chats ignored` : null].filter(Boolean) : [];
    return h("section", { class: "group" }, h("h3", { class: "group-title" }, "4 · Check it works"), h("div", { class: "row-acts tg-acts" }, btn), result, bits.length ? h("p", { class: "group-foot", role: "status" }, bits.join(" · ")) : null);
  }

  function draw(extra) {
    root.replaceChildren(...[connectSection(), chatsSection(), target()?.chats.length ? eventsSection() : null, checkSection(), extra ?? null, guideHref ? h("p", { class: "hint" }, "Plain-words guide: ", h("a", { href: guideHref, target: "_blank", rel: "noopener" }, "Telegram setup, safety and troubleshooting"), ".") : null].filter(Boolean));
  }

  root.replaceChildren(h("div", { class: "api-skel", "aria-hidden": "true" }, h("span", { class: "skel-title" }), h("span", { class: "skel-block" }), h("span", { class: "skel-block" })));
  load();
  return root;
}
