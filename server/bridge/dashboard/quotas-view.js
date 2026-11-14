// Sources > Quotas: how much each API key and tool may ask for. Every key has its own quota so one busy tool cannot
// starve the others. The list shows each key's label, kind, weight, per-second and per-day limits, its use and how often
// it was held back today; a sheet edits one key with presets (Light, Normal, Heavy) and plain explanations.

import { alertBox, api, currentKey, emptyState, h, icon, iconTile, istTime, modal, optional, toast } from "./app.js";
import { dayShare, fairShare, kindLabel, matchPreset, quotaLine, quotaPresets, quotaSourceText, sortKeys, validateQuota, toneForShare, TONE_WORD } from "./sources-core.js";
import { chevron, createKeyedList, createMeter, createPoller, setData, setText } from "./sources-ui.js";
import { formatInt, plural } from "./format.js";

let segmented = null;
/** views.js hands over its segmented control (it owns the sliding thumb). */
export function configureQuotas(deps) {
  segmented = deps.segmented ?? segmented;
}

const isMissing = (err) => err && (err.status === 404 || err.status === 405 || err.status === 501);
const KIND_ICON = { ui: ["accounts", "teal"], mcp: ["plug", "purple"], excel: ["chart", "orange"], script: ["console", "blue"], other: ["keys", "gray"] };

/** How the key's use reads: the day against its cap when it has one, else this minute against what a minute allows. */
function useOf(k) {
  const day = dayShare(k);
  if (day !== null) return { share: day, left: Math.max(0, k.perDay - (k.usage?.today ?? 0)), text: `${formatInt(k.usage?.today ?? 0)} of ${formatInt(k.perDay)} today`, label: "Daily use" };
  const cap = k.perSecond * 60;
  const used = k.usage?.lastMinute ?? 0;
  return { share: cap > 0 ? Math.min(1, used / cap) : 0, left: Math.max(0, cap - used), text: `${formatInt(used)} of ${formatInt(Math.round(cap))} this minute`, label: "Use this minute" };
}

// ── The edit sheet ──

/**
 * Edit one key's quota. Resolves true when it was saved or reset.
 * @param {object} key  a row of GET /v1/quotas keys
 * @param {{ default: { perSecond: number, burst: number }, kinds: Record<string, number> }} defs
 */
export function openQuotaSheet(key, defs) {
  const presets = quotaPresets(defs.default, defs.kinds?.[key.clientKind] ?? key.weight ?? 1);
  const num = (id, value, attrs = {}) => h("input", { id, type: "number", inputmode: attrs.step && attrs.step < 1 ? "decimal" : "numeric", value: value === null || value === undefined ? "" : String(value), min: "0", ...attrs });
  const fields = {
    perSecond: num("q-ps", key.perSecond, { step: "0.5" }),
    burst: num("q-bu", key.burst, { step: "1" }),
    weight: num("q-wt", key.weight, { step: "1" }),
    perDay: num("q-pd", key.perDay, { step: "100", placeholder: "No daily cap" }),
  };
  const msgs = Object.fromEntries(Object.keys(fields).map((k) => [k, h("span", { class: "field-msg", id: `q-msg-${k}`, role: "alert", hidden: true })]));
  const slot = h("div", { class: "sx-slot", role: "alert" });
  const preview = h("p", { class: "sx-q-preview", "aria-live": "polite" });
  const current = () => ({ perSecond: fields.perSecond.value, burst: fields.burst.value, weight: fields.weight.value, perDay: fields.perDay.value });
  const asValues = () => {
    const v = validateQuota(current());
    return v.ok ? v.body : { perSecond: Number(fields.perSecond.value), burst: Number(fields.burst.value), weight: Number(fields.weight.value), perDay: fields.perDay.value === "" ? null : Number(fields.perDay.value) };
  };
  const presetOptions = [...presets.map((p) => [p.id, p.label]), ["custom", "Custom"]];
  const seg = segmented ? segmented("Preset", presetOptions, matchPreset(asValues(), presets)) : h("span");
  const presetNote = h("p", { class: "hint", id: "q-preset-note", "aria-live": "polite" });
  let guard = false;

  const showErrors = (errors) => {
    for (const [k, input] of Object.entries(fields)) {
      const m = msgs[k];
      const e = errors?.[k];
      m.hidden = !e;
      setText(m, e ?? "");
      if (e) {
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", `q-msg-${k}`);
      } else {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      }
    }
  };
  const refresh = ({ fromPreset = false, quiet = false } = {}) => {
    const v = validateQuota(current());
    if (!quiet) showErrors(v.ok ? {} : v.errors);
    if (v.ok) {
      const b = v.body;
      setText(preview, `This key could make up to ${plural(b.perSecond, "call")} a second, up to ${formatInt(b.burst)} at once${b.perDay ? `, and ${formatInt(b.perDay)} a day` : ", with no daily cap"}.`);
    } else setText(preview, "Fix the highlighted fields to see what this key could do.");
    if (!fromPreset && seg.value !== undefined) {
      guard = true;
      seg.value = v.ok ? matchPreset(v.body, presets) : "custom";
      guard = false;
    }
    const p = presets.find((x) => x.id === seg.value);
    setText(presetNote, p ? p.note : "Your own numbers.");
  };
  for (const input of Object.values(fields)) {
    input.addEventListener("input", () => refresh({ quiet: true }));
    input.addEventListener("blur", () => refresh());
  }
  seg.addEventListener?.("change", () => {
    if (guard) return;
    const p = presets.find((x) => x.id === seg.value);
    if (p) {
      fields.perSecond.value = String(p.values.perSecond);
      fields.burst.value = String(p.values.burst);
      fields.weight.value = String(p.values.weight);
      fields.perDay.value = "";
    }
    refresh({ fromPreset: true });
  });

  const field = (label, input, hint, id) => h("label", { class: "field", for: id }, h("span", {}, label), input, hint ? h("span", { class: "hint" }, hint) : null, msgs[Object.keys(fields).find((k) => fields[k] === input)]);
  refresh({ quiet: true });
  const buttons = [{ label: "Cancel", value: false }];
  if (key.source === "override") {
    buttons.push({
      label: "Use the default",
      cls: "tinted",
      onClick: async () => {
        slot.replaceChildren();
        try {
          await api(`/v1/quotas/${encodeURIComponent(key.keyId)}`, { method: "DELETE" });
          toast(`${key.label} is back on the default quota`);
          return true;
        } catch (err) {
          slot.replaceChildren(alertBox(err));
          return false;
        }
      },
    });
  }
  buttons.push({
    label: "Save quota",
    cls: "primary",
    onClick: async () => {
      const v = validateQuota(current());
      if (!v.ok) {
        showErrors(v.errors);
        Object.keys(v.errors).map((k) => fields[k]).find(Boolean)?.focus();
        return false;
      }
      slot.replaceChildren();
      const body = { perSecond: v.body.perSecond, burst: v.body.burst, weight: v.body.weight };
      // A daily cap is sent when set, and cleared (null) only when the key had one.
      if (v.body.perDay !== null) body.perDay = v.body.perDay;
      else if (key.perDay) body.perDay = null;
      try {
        await api(`/v1/quotas/${encodeURIComponent(key.keyId)}`, { method: "PUT", body });
        toast(`Quota set for ${key.label}: ${formatInt(v.body.perSecond)} a second`);
        return true;
      } catch (err) {
        // The Bridge's own words about what it rejected sit beside the form, not in a toast.
        slot.replaceChildren(alertBox(err));
        return false;
      }
    },
  });

  const first = current();
  return modal({
    dirty: () => Object.keys(first).some((k) => String(first[k]) !== String(current()[k])),
    title: `Quota for ${key.label}`,
    body: h(
      "div",
      { class: "sx-sheet sx-q-sheet" },
      h("p", { class: "sx-q-who" }, h("span", { class: "chip" }, kindLabel(key.clientKind)), " ", h("span", { class: "sx-q-src" }, quotaSourceText(key.source))),
      h("div", { class: "field seg-field" }, h("span", { id: "q-preset-l" }, "How much may it use"), seg, presetNote),
      h("div", { class: "form-grid sx-q-grid" }, field("Calls per second", fields.perSecond, "How fast it may go, on average.", "q-ps"), field("Most at once", fields.burst, "How many it may send in one go.", "q-bu"), field("Fair share", fields.weight, "A bigger number waits less when things are busy.", "q-wt"), field("Calls per day", fields.perDay, "Leave empty for no daily cap.", "q-pd")),
      preview,
      h(
        "div",
        { class: "sx-q-explain" },
        h("h3", { class: "group-title sx-sheet-h" }, "What happens at the limit"),
        h("ul", {}, h("li", {}, "The Bridge answers 429 Too Many Requests, with a Retry-After header that says how long to wait. Tools that follow it wait and try again by themselves."), h("li", {}, "Only this key waits. Other keys and the dashboard keep their own room."), h("li", {}, "Orders are never queued behind price reads, and a held-back call is counted here, under held back today.")),
      ),
      slot,
    ),
    buttons,
  });
}

// ── The page ──

/** @returns {Promise<HTMLElement>} the Quotas tab */
export async function renderQuotas() {
  const root = h("div", { class: "sx-tab" });
  let data = null;
  let err = null;
  let lastOk = 0;
  let polls = 0;
  const rowsBox = h("div", { class: "list sx-q-rows", role: "group", "aria-label": "API keys and tools, most used first" });
  let totalWeight = 0;
  const ownKeyId = String(currentKey() ?? "").split("_")[1] ?? null;
  const list = createKeyedList(rowsBox, { key: (k) => k.keyId, create: createRow, update: updateRow });
  const intro = h("section", { class: "card" }, h("div", { class: "card-body stack" }, h("p", { class: "sx-q-lead" }, "Every API key has its own quota, so one busy tool cannot use up everyone's room. The numbers below are what each key may ask for, and how much it used."), h("p", { class: "sx-q-default" })));
  const defaultLine = intro.querySelector(".sx-q-default");
  const emptyBox = h("div", { class: "list", hidden: true }, emptyState("keys", "No API keys yet", "Make a key for a tool and its quota appears here.", h("button", { type: "button", class: "primary", onclick: () => (location.hash = "#/api/keys") }, "Create a key")));
  // Only this dashboard's own key so far: say what will appear and the one thing to do.
  const toolHint = h("p", { class: "group-foot sx-q-tools", hidden: true }, "Keys you make for tools, such as Excel, a script or an AI assistant, will appear here with their own quota. ", h("a", { href: "#/api/keys" }, "Create a key"), ".");
  const errBox = h("div", { hidden: true });
  const foot = h("p", { class: "group-foot" }, "Select a key to change its quota. Usage updates by itself; a key that is held back often may need a bigger quota or a gentler tool. The key this browser uses also counts this dashboard's own refreshes.");
  const group = h("section", { class: "group sx-group", "aria-labelledby": "sx-q-h" }, h("h2", { class: "group-title", id: "sx-q-h" }, "Keys and tools"), rowsBox, toolHint, emptyBox, errBox, foot);

  function createRow(k) {
    const [glyph, tint] = KIND_ICON[k.clientKind] ?? KIND_ICON.other;
    const title = h("span", { class: "sx-title" }, k.label);
    const kind = h("span", { class: "chip" }, kindLabel(k.clientKind));
    const custom = h("span", { class: "pill info tiny" }, "Custom");
    const own = h("span", { class: "chip own-key", hidden: true, title: "This browser is signed in with this key, so its use includes this dashboard's own refreshes." }, "This browser");
    const line = h("span", { class: "sx-subtext" });
    const meter = createMeter({ label: k.label });
    meter.el.setAttribute("aria-hidden", "true");
    meter.el.firstChild.removeAttribute("role");
    const use = h("span", { class: "sx-q-use" });
    const word = h("span", { class: "sx-toneword" });
    const held = h("span", { class: "sx-q-held" });
    const gauge = h("span", { class: "sx-gauge" }, meter.el, h("span", { class: "sx-figs" }, h("span", { class: "sx-figs-l" }, use), h("span", { class: "sx-figs-r" }, word)));
    const el = h("button", { type: "button", class: "list-row sx-row sx-qrow", "aria-haspopup": "dialog" }, iconTile(glyph, tint, "md"), h("span", { class: "sx-main" }, h("span", { class: "sx-line1" }, title, kind, custom, own), h("span", { class: "sx-line2" }, line)), gauge, h("span", { class: "sx-q-end" }, held), chevron());
    el._parts = { title, kind, custom, own, line, meter, use, word, held };
    return el;
  }

  function updateRow(el, k) {
    const p = el._parts;
    el._key = k;
    el.onclick = () => edit(el._key);
    const u = useOf(k);
    const tone = toneForShare(u.share);
    setText(p.title, k.label);
    setText(p.kind, kindLabel(k.clientKind));
    p.custom.hidden = k.source !== "override";
    p.own.hidden = !ownKeyId || k.keyId !== ownKeyId;
    setText(p.line, `${quotaLine(k)}. ${fairShare(k.weight, totalWeight)}.`);
    p.meter.set({ share: u.share, tone, speech: `${u.label}: ${u.text}, ${TONE_WORD[tone].toLowerCase()}` });
    setText(p.use, u.text);
    setText(p.word, TONE_WORD[tone]);
    const t = k.usage?.throttledToday ?? 0;
    setText(p.held, t ? `${formatInt(t)} held back today` : "Never held back today");
    setData(p.held, "hot", t > 0 ? "1" : null);
    setData(el, "tone", tone);
    el.setAttribute("aria-label", `${k.label}, ${kindLabel(k.clientKind)}. ${quotaLine(k)}. ${u.text}. ${TONE_WORD[tone]}. ${t ? `${plural(t, "call")} held back today` : "Never held back today"}. Select to change the quota.`);
  }

  async function edit(k) {
    if (await openQuotaSheet(k, { default: data.default, kinds: data.kinds })) await poller.tick();
  }

  function paint() {
    errBox.hidden = !err;
    if (err) {
      const box = isMissing(err) ? alertBox({ title: "This Bridge has no per-key quotas yet", detail: "Quotas need a newer Bridge. Rate limits still apply to every key." }, "info") : alertBox(err);
      if (!isMissing(err)) box.lastElementChild.append(h("div", { class: "alert-actions" }, h("span", { class: "hint" }, lastOk ? `Showing the reading from ${istTime(new Date(lastOk).toISOString())}. ` : ""), h("button", { type: "button", class: "small", onclick: () => poller.tick() }, icon("refresh"), "Try again")));
      errBox.replaceChildren(box);
    }
    if (!data) {
      intro.hidden = Boolean(err);
      return;
    }
    const keys = sortKeys(data.keys ?? []);
    totalWeight = keys.reduce((n, k) => n + (Number(k.weight) || 0), 0);
    const d = data.default ?? {};
    setText(defaultLine, `Default for a new key: ${plural(d.perSecond, "call")} a second, up to ${formatInt(d.burst)} at once.`);
    emptyBox.hidden = keys.length > 0;
    rowsBox.hidden = keys.length === 0;
    foot.hidden = keys.length === 0;
    toolHint.hidden = !(keys.length > 0 && keys.every((k) => k.keyId === ownKeyId || k.clientKind === "ui"));
    const busy = rowsBox.matches(":hover") || rowsBox.contains(document.activeElement);
    list.sync(keys, { reorder: !busy });
  }

  async function poll() {
    polls += 1;
    const r = err && isMissing(err) && polls % 15 !== 0 ? { error: err } : await optional(api("/v1/quotas", { fresh: true }));
    if (!root.isConnected && lastOk) return;
    if (r.data) {
      data = r.data.data ?? r.data;
      err = null;
      lastOk = Date.now();
    } else err = r.error;
    paint();
  }

  const poller = createPoller({ root, ms: 4000, run: poll });
  root.append(intro, group);
  await poll();
  poller.start();
  return root;
}
