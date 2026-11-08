// Sources page: the small DOM pieces every tab shares. Loaded with the dashboard (views.js), because it also adds the
// page's icons to the icon set before the menu draws them. The big page code is in sources-page.js (Overview),
// sources-providers.js (Providers) and quotas-view.js (Quotas), all loaded when the page is opened.
//
// The pieces: a meter that is patched in place (animated width, one spoken value), a counting number, a keyed list that
// keeps a row's DOM node for as long as the row exists (so live updates never rebuild anything), a poller that stops
// when the tab is hidden or the page goes away, and the badges (data class, official, health).

import { ICONS, h, icon, iconTile } from "./app.js";
import { classLabel, officialLabel } from "./sources-core.js";
import { formatInt } from "./format.js";

// Icons for this page: the sources glyph (layers of data), a route (a path that splits) and a skipped step.
Object.assign(ICONS, {
  sources: '<path d="M12 3.6 3.8 8 12 12.4 20.2 8z"/><path d="m3.8 12 8.2 4.4 8.2-4.4"/><path d="m3.8 16 8.2 4.4 8.2-4.4"/>',
  route: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8.2 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.8"/>',
  skip: '<circle cx="12" cy="12" r="8.8"/><path d="M8.5 12h7"/>',
});

// ── Motion, when motion.js has it ──

/** The motion library, once it has loaded (null in tests, or when the file is missing): used only if it has what we ask. */
let motion = null;
if (typeof document !== "undefined") {
  import("./motion.js").then(
    (m) => {
      motion = m;
    },
    () => {},
  );
}
export const prefersReducedMotion = () => (typeof motion?.reducedMotion === "function" ? motion.reducedMotion() : typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

/**
 * Run `mutate` (a DOM change that reorders, inserts or removes keyed children) and animate the children to their new
 * places. Uses motion.js `flip(container, mutate)` when it exists; otherwise a small FLIP of its own. Reduced motion:
 * the change is instant.
 */
export function flipChildren(container, mutate) {
  if (prefersReducedMotion() || typeof container?.animate !== "function") return mutate();
  if (typeof motion?.flip === "function") {
    let ran = false;
    try {
      motion.flip(container, () => {
        ran = true;
        mutate();
      });
    } catch {
      /* fall through to the plain change */
    }
    if (ran) return undefined;
  }
  const first = new Map([...container.children].map((el) => [el, el.getBoundingClientRect()]));
  mutate();
  for (const el of container.children) {
    const a = first.get(el);
    if (!a || typeof el.animate !== "function") continue;
    const b = el.getBoundingClientRect();
    const dy = a.top - b.top;
    if (Math.abs(dy) < 1) continue;
    el.animate({ translate: [`0px ${dy}px`, "0px 0px"] }, { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }
  return undefined;
}

/** The disclosure chevron of a row (class chev: app.css sizes and colours it). */
export function chevron() {
  const c = icon("chevron");
  c.classList.add("chev");
  return c;
}

// ── Setting text and attributes only when they change ──

/** Set an element's text if it differs (a single text node, never a rebuild). */
export function setText(el, text) {
  const t = String(text ?? "");
  if (el.textContent !== t) el.textContent = t;
}
export function setAttr(el, name, value) {
  if (value === null || value === undefined || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== String(value)) el.setAttribute(name, String(value));
}
export function setData(el, name, value) {
  if (value === null || value === undefined) delete el.dataset[name];
  else if (el.dataset[name] !== String(value)) el.dataset[name] = String(value);
}

// ── A number that counts ──

/**
 * A figure that counts to its new value (about 450 ms, ease-out) when it changes by at least one, and shows it at once
 * under reduced motion. It reserves the width of its widest value (tabular figures), so a row never changes width.
 * The counting digits are hidden from screen readers; a sibling holds the final value and changes at most every 5 s.
 * @returns {{ el: HTMLElement, set(value: number | null, opts?: { digits?: number }): void }}
 */
export function countingNumber({ className = "" } = {}) {
  const visible = h("span", { class: "sx-num-v", "aria-hidden": "true" }, "–");
  const spoken = h("span", { class: "sr-only" }, "");
  const el = h("span", { class: `sx-num ${className}`.trim() }, visible, spoken);
  let shown = null;
  let target = null;
  let raf = 0;
  let spokenAt = 0;
  const write = (n) => {
    const t = n === null ? "–" : formatInt(n);
    if (visible.textContent !== t) visible.textContent = t;
  };
  const say = (n, force) => {
    const now = Date.now();
    if (!force && now - spokenAt < 5000) return;
    spokenAt = now;
    setText(spoken, n === null ? "" : formatInt(n));
  };
  return {
    el,
    set(value, { digits } = {}) {
      const n = Number.isFinite(value) ? Math.round(value) : null;
      if (digits) el.style.setProperty("--d", String(digits));
      if (n === target) return;
      const from = shown;
      target = n;
      cancelAnimationFrame(raf);
      say(n, from === null);
      if (n === null || from === null || prefersReducedMotion() || typeof requestAnimationFrame !== "function" || Math.abs(n - from) < 1 || document.hidden) {
        shown = n;
        write(n);
        return;
      }
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 450);
        const eased = 1 - (1 - k) ** 3;
        shown = Math.round(from + (n - from) * eased);
        write(shown);
        if (k < 1) raf = requestAnimationFrame(step);
        else {
          shown = n;
          write(n);
        }
      };
      raf = requestAnimationFrame(step);
    },
  };
}

// ── The meter ──

/**
 * A meter that is built once and patched: `set()` changes the fill width (animated by CSS), the tone and the spoken
 * value. The spoken value (`aria-valuetext`) changes at most every 5 s, or at once when the tone changes, so a screen
 * reader is not flooded.
 * @param {{ label: string, tall?: boolean }} opts  the accessible name
 */
export function createMeter({ label, tall = false }) {
  const fill = h("i");
  const soft = h("b", { class: "sx-soft", "aria-hidden": "true" });
  const track = h("div", { class: "sx-track", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0", "aria-label": label }, fill, soft);
  const el = h("div", { class: `sx-meter${tall ? " tall" : ""}`, "data-tone": "calm" }, track);
  let said = 0;
  let saidTone = "calm";
  return {
    el,
    set({ share, tone, speech, label: newLabel }) {
      const pct = Number.isFinite(share) ? Math.max(0, Math.min(100, share * 100)) : 0;
      // A little sliver shows that something is used, but never a full bar for a nearly empty budget.
      const w = pct > 0 && pct < 1.5 ? 1.5 : pct;
      const text = `${Math.round(w * 10) / 10}%`;
      if (fill.style.width !== text) fill.style.width = text;
      setData(el, "tone", tone);
      if (newLabel) setAttr(track, "aria-label", newLabel);
      const now = Date.now();
      if (speech !== undefined && (tone !== saidTone || now - said > 5000)) {
        setAttr(track, "aria-valuenow", String(Math.round(pct)));
        setAttr(track, "aria-valuetext", speech);
        said = now;
        saidTone = tone;
      }
    },
  };
}

// ── A keyed list: one DOM node per row, kept ──

/**
 * Keep the children of `container` in step with `items`. A row's node is made once (`create`) and changed in place
 * (`update`); it is never rebuilt. New rows are inserted, gone rows removed. Existing rows move only when `reorder` is
 * true (the page decides when: not while a pointer or focus is inside the list), and the move is animated.
 * @param {HTMLElement} container
 * @param {{ key: (item: any) => string, create: (item: any) => HTMLElement, update: (el: HTMLElement, item: any) => void }} spec
 */
export function createKeyedList(container, { key, create, update }) {
  /** @type {Map<string, HTMLElement>} */
  const nodes = new Map();
  return {
    nodes,
    sync(items, { reorder = true } = {}) {
      const want = items.map((it) => key(it));
      const wantSet = new Set(want);
      for (const [k, el] of [...nodes]) {
        if (!wantSet.has(k)) {
          el.remove();
          nodes.delete(k);
        }
      }
      items.forEach((it, i) => {
        const k = want[i];
        let el = nodes.get(k);
        if (!el) {
          el = create(it);
          el.dataset.key = k;
          nodes.set(k, el);
          el.dataset.fresh = "1";
          setTimeout(() => delete el.dataset.fresh, 400);
        }
        update(el, it);
      });
      const order = (list) => {
        let at = 0;
        for (const k of list) {
          const el = nodes.get(k);
          if (container.children[at] !== el) container.insertBefore(el, container.children[at] ?? null);
          at += 1;
        }
      };
      // Rows that are not in the container yet go in; with reorder every row takes its place.
      const placed = want.filter((k) => nodes.get(k).parentNode === container);
      const fresh = want.filter((k) => nodes.get(k).parentNode !== container);
      if (reorder) {
        const current = [...container.children].map((c) => c.dataset.key);
        const same = current.length === want.length && current.every((k, i) => k === want[i]);
        if (!same) {
          if (placed.length && container.isConnected) flipChildren(container, () => order(want));
          else order(want);
        }
      } else {
        for (const k of fresh) container.append(nodes.get(k));
      }
    },
    clear() {
      for (const el of nodes.values()) el.remove();
      nodes.clear();
    },
  };
}

// ── The poller ──

/**
 * Run `run()` now and then every `ms`, while the tab is visible and `root` is on the page. It never overlaps itself, it
 * runs again the moment the tab becomes visible, and it stops for good once `root` has been removed from the page.
 * @param {{ root: HTMLElement, ms?: number, run: () => Promise<void> }} opts
 */
export function createPoller({ root, ms = 2000, run }) {
  let timer = null;
  let busy = false;
  let stopped = false;
  let seenConnected = false;
  let misses = 0;
  const tick = async () => {
    if (stopped) return;
    if (root.isConnected) {
      seenConnected = true;
      misses = 0;
    } else if (seenConnected || ++misses > 3) {
      stop();
      return;
    }
    if (document.hidden || busy) return;
    busy = true;
    try {
      await run();
    } catch {
      /* the page shows its own stale state */
    } finally {
      busy = false;
    }
  };
  const onVisible = () => {
    if (!document.hidden) tick();
  };
  function stop() {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  }
  return {
    start() {
      timer = setInterval(tick, ms);
      document.addEventListener("visibilitychange", onVisible);
    },
    stop,
    tick,
  };
}

// ── Badges ──

/** The data-class pill: Real-time, Delayed 15 min, End of day. Delayed and end of day are never green. */
export function classPill(cls, delaySec) {
  const tone = cls === "realtime" ? "ok" : "info";
  const p = h("span", { class: `pill ${tone} sx-class`, "data-class": cls }, h("span", { class: "pdot", "aria-hidden": "true" }), classLabel(cls, delaySec));
  return p;
}
export function updateClassPill(el, cls, delaySec) {
  setData(el, "class", cls);
  el.className = `pill ${cls === "realtime" ? "ok" : "info"} sx-class`;
  const t = classLabel(cls, delaySec);
  const last = el.lastChild;
  if (last && last.nodeType === 3) {
    if (last.data !== t) last.data = t;
  } else setText(el, t);
}

export const officialBadge = (official) => h("span", { class: `chip sx-official${official ? "" : " unofficial"}`, title: official ? "A documented service from the data's owner or your own broker." : "Not an official service. It can change or stop without notice." }, officialLabel(official));

/** What the labels on a source mean, said once and in place. A real disclosure: the keyboard opens it. */
export function labelsHelp() {
  return h(
    "details",
    { class: "sx-explain" },
    h("summary", {}, "What do these labels mean?"),
    h(
      "dl",
      {},
      h("dt", {}, "Real-time"),
      h("dd", {}, "Straight from the market, with no delay."),
      h("dt", {}, "Delayed"),
      h("dd", {}, "Behind the market by the time shown. Fine for charts and watchlists, never used for orders, risk checks, paper fills or alerts."),
      h("dt", {}, "End of day"),
      h("dd", {}, "Prices from the end of the trading day."),
      h("dt", {}, "Official"),
      h("dd", {}, "A documented service from the data's owner or your own broker."),
      h("dt", {}, "Unofficial"),
      h("dd", {}, "Not an official service. It can change or stop without notice, and its terms may limit what you may do with the data."),
    ),
  );
}

/** The health dot and word: a dot (never the only signal) and the word beside it. */
export function healthTag() {
  const dot = h("span", { class: "sx-dot", "aria-hidden": "true" });
  const word = h("span", { class: "sx-health-word" }, "");
  const el = h("span", { class: "sx-health", "data-tone": "ok" }, dot, word);
  return {
    el,
    set(health) {
      setData(el, "tone", health.tone);
      setText(word, health.word);
    },
  };
}

/** The glyph of a tone: a tile that says calm, busy, heads up or at the limit by shape as well as colour. */
const TONE_ICON = { calm: "check", busy: "activity", headsup: "warn", limit: "stop" };
export function toneGlyph(tone) {
  const tile = h("span", { class: "sx-glyph", "data-tone": tone, "aria-hidden": "true" }, icon(TONE_ICON[tone] ?? "check"));
  return tile;
}
export function setToneGlyph(el, tone) {
  if (el.dataset.tone === tone) return;
  el.dataset.tone = tone;
  el.replaceChildren(icon(TONE_ICON[tone] ?? "check"));
}

/** A broker's logo tile (dashboard/brokers/<id>.png) or its initials. The demo broker has no logo file. */
export function brokerTile(broker, name) {
  if (!/^[a-z0-9]{2,32}$/.test(String(broker)) || broker === "demo") return iconTile("sources", "teal", "md");
  const initials = String(name ?? broker).replace(/\(.*?\)/g, "").trim().split(/[\s-]+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const tile = h("span", { class: "avatar logo", "aria-hidden": "true" });
  tile.append(
    h("img", {
      src: `/dashboard/broker-${broker}.png`,
      alt: "",
      loading: "lazy",
      decoding: "async",
      width: 64,
      height: 64,
      onerror: () => {
        tile.classList.remove("logo");
        tile.replaceChildren(initials);
      },
    }),
  );
  return tile;
}

/** The tile of a source row: the broker's logo for an account, a tinted glyph for a source by its data class. */
export function sourceTile(row) {
  if (row.kind === "account") return brokerTile(String(row.sub).split(",")[0].toLowerCase(), row.name);
  return iconTile("sources", row.cls === "realtime" ? "teal" : row.cls === "delayed" ? "orange" : "gray", "md");
}

// ── Skeletons ──

/** A grey shape of the page while it first loads: a hero and a few rows (same boxes as the real thing). */
export function overviewSkeleton() {
  const row = () => h("div", { class: "sx-skel-row" }, h("span", { class: "skel-circle" }), h("span", { class: "sx-skel-lines" }, h("span", { class: "skel-line mid" }), h("span", { class: "skel-line short" })), h("span", { class: "skel-line sx-skel-meter" }));
  return h(
    "div",
    { class: "sx-tab sx-skel", "aria-hidden": "true" },
    h("div", { class: "card sx-skel-hero" }, h("span", { class: "skel-title" }), h("span", { class: "skel-line" }), h("span", { class: "skel-block sx-skel-bar" }), h("span", { class: "skel-line short" })),
    h("div", { class: "list" }, row(), row(), row()),
  );
}
