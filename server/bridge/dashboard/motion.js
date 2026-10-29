// Animation helpers for the dashboard, built on Motion (window.Motion, vendored motion.min.js v14.1.0).
//
// Rules every helper follows:
//  - It returns a promise that resolves when the animation is over (or at once when it is skipped).
//  - It is a no-op (resolved promise) when Motion is missing, there is no DOM (Node / tests) or the visitor
//    prefers reduced motion. Importing this file never touches window/document.
//  - It never leaves an element hidden or moved: the inline styles it animates are put back as they were when the
//    animation ends, fails or is cut short by a safety timeout (background tabs pause requestAnimationFrame).
//  - Movement uses the CSS `translate` property, which composes with any `transform` the stylesheet sets
//    (e.g. a centred toast), instead of overwriting it.
//
// How the dashboard uses it (wired in app.js, nothing to call from views.js):
//  - app.js start-up calls installAutoAnimations(), which watches #content and #nav with MutationObservers:
//      * when #content's children are replaced by a real page (not the "Loading…" placeholder) AND the hash route
//        differs from the last one animated, animatePage(#content) runs (fade + rise, staggered cards, table rows,
//        stat numbers counting up). Auto-refreshes (every(), Refresh button, inner replaceChildren) stay still.
//      * when #nav is rebuilt, animateNav(#nav) slides the selection highlight to the active item.
//  - app.js: modal() → sheetIn/sheetOut, toast() → bannerIn/bannerOut, login error → shake, global pressFeedback.
//  - views.js MAY still call animatePage(document.getElementById("content")) after a page render and
//    animateNav(document.getElementById("nav")) after nav(): both are idempotent (a second call for the same
//    route / same active item does nothing), so calling them on top of the observers is harmless.

import { formatInt } from "./format.js";

export const Motion = typeof window !== "undefined" ? (window.Motion ?? null) : null;
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const M = () => (typeof window !== "undefined" && typeof document !== "undefined" ? (window.Motion ?? null) : null);
/** The Motion API when animations should run, else null. */
const live = () => {
  const m = M();
  return m && typeof m.animate === "function" && !reducedMotion() ? m : null;
};
const done = () => Promise.resolve();
const isEl = (x) => typeof Element !== "undefined" && x instanceof Element;

/** macOS-like curves: a critically damped spring and the "ease out" Apple uses for sheets. */
const SPRING = (visualDuration = 0.3, bounce = 0) => {
  const m = M();
  return m?.spring ? { type: m.spring, visualDuration, bounce } : { duration: visualDuration, ease: [0.32, 0.72, 0, 1] };
};
const EASE_OUT = [0.32, 0.72, 0, 1];

/** Turn an element, NodeList, array or selector into an array of elements. */
function els(target, root = typeof document !== "undefined" ? document : null) {
  if (!target) return [];
  if (typeof target === "string") return root ? [...root.querySelectorAll(target)] : [];
  if (isEl(target)) return [target];
  if (typeof target[Symbol.iterator] === "function") return [...target].filter(isEl);
  return [];
}

/**
 * Run a Motion animation on elements and restore the listed inline style properties afterwards (whatever
 * happens). `ms` is a safety cap: past it the animation is completed and styles restored anyway.
 */
function run(targets, keyframes, options, { restore = Object.keys(keyframes), ms = 1200, keep = false, defer = false } = {}) {
  const m = live();
  const list = els(targets);
  if (!m || !list.length) return done();
  const saved = list.map((el) => restore.map((p) => [p, el.style.getPropertyValue(cssName(p)), el.style.getPropertyPriority(cssName(p))]));
  const put = () => {
    if (keep) return;
    // Exit animations: keep the end state until the caller has hidden / closed / removed the element.
    if (defer) {
      defer = false;
      setTimeout(put, 0);
      return;
    }
    list.forEach((el, i) => {
      for (const [p, v, prio] of saved[i]) {
        if (v) el.style.setProperty(cssName(p), v, prio);
        else el.style.removeProperty(cssName(p));
      }
    });
  };
  let anim;
  try {
    anim = m.animate(list.length === 1 ? list[0] : list, keyframes, options);
  } catch {
    put();
    return done();
  }
  let timer;
  const cap = new Promise((r) => (timer = setTimeout(() => r("timeout"), ms)));
  const finished = Promise.resolve(anim?.finished ?? anim).then(
    () => "ok",
    () => "fail",
  );
  return Promise.race([finished, cap])
    .then((how) => {
      clearTimeout(timer);
      if (how === "timeout") {
        try {
          anim.complete?.();
        } catch {
          /* already gone */
        }
      }
      // Motion writes the final values inline from the native "finish" event, which comes after `finished`
      // resolves: wait one task so the restore below wins.
      return new Promise((r) => setTimeout(r, 0));
    })
    .then(put);
}
// Motion's transform shortcuts all land on the `transform` property.
const TRANSFORM_KEYS = new Set(["x", "y", "z", "scale", "scaleX", "scaleY", "rotate", "rotateX", "rotateY", "skew", "skewX", "skewY"]);
const cssName = (p) => (TRANSFORM_KEYS.has(p) ? "transform" : p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

// ── Pages ──

/** The things worth staggering in a page: descend through single wrappers to the first level with siblings. */
function pageItems(container) {
  let items = [...container.children];
  for (let depth = 0; depth < 3 && items.length === 1 && items[0].children.length > 1; depth++) items = [...items[0].children];
  return items.filter((el) => !el.hidden).slice(0, 14);
}

/** Content fade + rise, children (cards / sections) staggered. ~0.3 s, spring without overshoot. */
export function pageEnter(container) {
  const m = live();
  if (!m || !isEl(container)) return done();
  const items = pageItems(container);
  if (!items.length) return done();
  const delay = m.stagger ? m.stagger(0.035, { startDelay: 0 }) : 0;
  return run(items, { opacity: [0, 1], translate: ["0px 8px", "0px 0px"] }, { ...SPRING(0.32), delay }, { ms: 1500 });
}

/** Table rows / list items appearing. Only the first 20 are staggered; the whole thing is capped at ~300 ms. */
export function listStagger(target, root) {
  const m = live();
  if (!m) return done();
  let list = els(target, root);
  // A table, tbody or list container: animate its rows / items.
  if (list.length === 1 && list[0].matches("table, tbody, ul, ol, .table-wrap")) list = [...list[0].querySelectorAll("tbody > tr, :scope > li")];
  list = list.filter((el) => !el.hidden).slice(0, 20);
  if (!list.length) return done();
  const each = Math.min(0.015, 0.12 / list.length);
  return run(list, { opacity: [0, 1], translate: ["0px 4px", "0px 0px"] }, { duration: 0.18, ease: EASE_OUT, delay: m.stagger ? m.stagger(each) : 0 }, { ms: 1000 });
}

// ── Sheets (modal dialogs) ──

/** True when sheets are bottom sheets (phones, below 720px: see app.css dialog.sheet). */
const bottomSheet = () => typeof matchMedia === "function" && matchMedia("(max-width: 719px)").matches;

/**
 * Sheet in (IPO Decode's Sheet): on a phone the panel rises from the bottom edge on a soft spring; from 720px up it
 * scales 0.96 → 1 and settles into place. The backdrop fades either way.
 * `backdrop` is an element, or the <dialog> itself (then its ::backdrop is faded with the Web Animations API).
 */
export function sheetIn(backdrop, panel) {
  const m = live();
  if (!m) return done();
  const jobs = [fadeBackdrop(backdrop, panel, [0, 1], 200)];
  if (isEl(panel)) {
    if (bottomSheet()) jobs.push(run(panel, { translate: ["0px 100%", "0px 0px"] }, SPRING(0.42, 0.06), { ms: 1200 }));
    else jobs.push(run(panel, { opacity: [0, 1], scale: [0.96, 1], translate: ["0px 8px", "0px 0px"] }, SPRING(0.3, 0.08), { ms: 1000 }));
  }
  return Promise.all(jobs).then(() => {});
}

/**
 * Reverse of sheetIn (~160 ms; resolves within ~220 ms even when frames are slow, at once with reduced motion) so
 * the caller can close / remove the nodes. The panel stays invisible until then; its inline styles come back after.
 */
export function sheetOut(backdrop, panel) {
  const m = live();
  if (!m) return done();
  const jobs = [fadeBackdrop(backdrop, panel, [1, 0], 160, true)];
  let exit = null;
  if (isEl(panel)) {
    // Native Web Animations with individual properties: exact timing, nothing written inline, and it composes
    // with whatever transform the stylesheet gives the panel.
    try {
      for (const a of panel.getAnimations()) a.cancel(); // an unfinished sheetIn
      for (const p of ["opacity", "transform", "translate"]) panel.style.removeProperty(p);
      exit = bottomSheet()
        ? panel.animate({ translate: ["0px 0px", "0px 100%"] }, { duration: 200, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" })
        : panel.animate({ opacity: [1, 0], scale: ["1", "0.97"], translate: ["0px 0px", "0px 4px"] }, { duration: 160, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
      jobs.push(exit.finished.catch(() => {}));
    } catch {
      exit = null;
    }
  }
  // Hard cap so closing never feels sluggish, even when frames arrive late.
  let timer;
  const cap = new Promise((r) => (timer = setTimeout(r, 220)));
  return Promise.race([Promise.all(jobs), cap]).then(() => {
    clearTimeout(timer);
    // The panel holds its end state until the caller has closed / removed it (same task), then the exit is dropped.
    setTimeout(() => exit?.cancel(), 0);
  });
}

function fadeBackdrop(backdrop, panel, opacity, ms, hold = false) {
  if (!isEl(backdrop)) return done();
  // A <dialog> passed as its own backdrop: fade ::backdrop (pseudo-elements need the native API).
  if (backdrop === panel || backdrop.tagName === "DIALOG") {
    try {
      const a = backdrop.animate({ opacity }, { duration: ms, easing: "ease-out", pseudoElement: "::backdrop", fill: hold ? "forwards" : "none" });
      // A held (exit) fade is dropped once the caller had a chance to close the dialog.
      return a.finished.then(
        () => (hold ? setTimeout(() => a.cancel(), 0) : a.cancel()),
        () => {},
      );
    } catch {
      return done();
    }
  }
  return run(backdrop, { opacity }, { duration: ms / 1000, ease: "easeOut" }, { ms: ms + 600 });
}

// ── Banners (toasts) ──

/** Which way a banner slides: in from the right edge when it sits on the right (macOS notifications), else down. */
function bannerFrom(el) {
  const r = el.getBoundingClientRect();
  if (r.width && r.left + r.width / 2 > (window.innerWidth || 0) * 0.6) return ["24px 0px", "0px 0px"];
  return r.top < (window.innerHeight || 0) / 2 ? ["0px -12px", "0px 0px"] : ["0px 12px", "0px 0px"];
}

export function bannerIn(el) {
  if (!live() || !isEl(el)) return done();
  return run(el, { opacity: [0, 1], translate: bannerFrom(el) }, SPRING(0.35, 0.12), { ms: 1200 });
}

/** Slide back out. Resolves when done; the caller then hides the element. */
export function bannerOut(el) {
  if (!live() || !isEl(el) || el.hidden) return done();
  const [from] = bannerFrom(el);
  return run(el, { opacity: [1, 0], translate: ["0px 0px", from] }, { duration: 0.2, ease: [0.4, 0, 1, 1] }, { ms: 260, defer: true });
}

// ── Sidebar selection ──

const navState = new WeakMap(); // nav element → { hl, active, ro }

/** Copy the active item's look onto the highlight; the item itself is made transparent so the highlight shows through. */
function paintHighlight(hl, link) {
  link.style.removeProperty("background");
  const cs = getComputedStyle(link);
  hl.style.backgroundColor = cs.backgroundColor;
  hl.style.backgroundImage = cs.backgroundImage;
  hl.style.borderRadius = cs.borderRadius;
  hl.style.boxShadow = cs.boxShadow;
  link.style.background = "transparent";
}
const box = (link) => ({ x: link.offsetLeft, y: link.offsetTop, width: link.offsetWidth, height: link.offsetHeight });

/**
 * Smoothly move a selection highlight between sidebar items. A highlight element is created inside the nav
 * (absolutely positioned, behind the links) and re-used across nav rebuilds; resizes re-place it instantly.
 */
export function navHighlight(navEl, activeLink) {
  const m = live();
  if (!isEl(navEl)) return done();
  let st = navState.get(navEl);
  if (!m || !isEl(activeLink) || typeof getComputedStyle !== "function") {
    // Animations off (e.g. reduced motion switched on): drop the highlight and let the stylesheet paint the item.
    if (st) {
      st.ro?.disconnect();
      st.hl.remove();
      for (const a of navEl.querySelectorAll("a")) a.style.removeProperty("background");
      navState.delete(navEl);
    }
    return done();
  }
  if (!st) {
    const hl = document.createElement("div");
    hl.className = "nav-highlight";
    hl.setAttribute("aria-hidden", "true");
    Object.assign(hl.style, { position: "absolute", left: "0px", top: "0px", zIndex: "0", pointerEvents: "none", willChange: "transform, width, height" });
    st = { hl, active: null, ro: null, first: true };
    navState.set(navEl, st);
    if (typeof ResizeObserver === "function") {
      st.ro = new ResizeObserver(() => {
        if (st.active?.isConnected) place(st, st.active);
      });
      st.ro.observe(navEl);
    }
  }
  if (getComputedStyle(navEl).position === "static") navEl.style.position = "relative";
  for (const a of navEl.querySelectorAll("a")) {
    a.style.position = "relative";
    a.style.zIndex = "1";
    if (a !== activeLink) a.style.removeProperty("background");
  }
  if (st.hl.parentNode !== navEl) navEl.prepend(st.hl);
  const moved = st.active && st.active.dataset?.page !== activeLink.dataset?.page;
  const prevBox = st.lastBox;
  st.active = activeLink;
  if (st.ro) {
    st.ro.disconnect();
    st.ro.observe(navEl);
    st.ro.observe(activeLink);
  }
  paintHighlight(st.hl, activeLink);
  const to = box(activeLink);
  st.lastBox = to;
  if (!moved || !prevBox) {
    place(st, activeLink);
    return done();
  }
  setBox(st.hl, prevBox);
  return run(st.hl, { x: [prevBox.x, to.x], y: [prevBox.y, to.y], width: [`${prevBox.width}px`, `${to.width}px`], height: [`${prevBox.height}px`, `${to.height}px`] }, SPRING(0.3), { keep: true, ms: 1000 }).then(() => {
    if (st.active === activeLink) place(st, activeLink);
  });
}
function setBox(hl, b) {
  hl.style.transform = `translate(${b.x}px, ${b.y}px)`;
  hl.style.width = `${b.width}px`;
  hl.style.height = `${b.height}px`;
}
function place(st, link) {
  st.lastBox = box(link);
  setBox(st.hl, st.lastBox);
}

// ── Small feedback ──

/** Press a button down to 0.97; returns a function that springs it back (and restores its inline transform). */
export function pressFeedback(button) {
  const m = live();
  if (!m || !isEl(button)) return () => done();
  const before = button.style.transform;
  let anim;
  try {
    anim = m.animate(button, { scale: 0.97 }, { duration: 0.08, ease: "easeOut" });
  } catch {
    return () => done();
  }
  return () => {
    try {
      anim.stop?.();
    } catch {
      /* ignore */
    }
    return run(button, { scale: 1 }, SPRING(0.2), { ms: 600 }).then(() => {
      if (before) button.style.transform = before;
      else button.style.removeProperty("transform");
    });
  };
}

/** Attach pressFeedback once, by delegation, to button, .btn and [role=button] across the document. */
export function installPressFeedback(doc = typeof document !== "undefined" ? document : null) {
  if (!doc || doc.__mcbPress) return;
  doc.__mcbPress = true;
  doc.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const b = e.target?.closest?.("button, .btn, [role=button]");
      if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return;
      const release = pressFeedback(b);
      const up = () => {
        doc.removeEventListener("pointerup", up, true);
        doc.removeEventListener("pointercancel", up, true);
        b.removeEventListener("pointerleave", up);
        release();
      };
      doc.addEventListener("pointerup", up, true);
      doc.addEventListener("pointercancel", up, true);
      b.addEventListener("pointerleave", up);
    },
    { passive: true },
  );
}

// Counted figures follow the house rule (format.js): no grouping commas.
const fmtDefault = { format: (v) => formatInt(v) };

/**
 * Count a number up from `from` to `to`, writing format(value) into el. The final text is exactly format(to)
 * (or `finalText` when given), even if the animation is skipped or cut short.
 */
const COUNTS = new WeakMap();
/** Cancel a running countUp on `el` so a later textContent write is not overwritten by it. */
export function stopCount(el) {
  if (isEl(el)) COUNTS.delete(el);
}
export function countUp(el, from, to, format = (v) => fmtDefault.format(Math.round(v)), finalText) {
  if (!isEl(el)) return done();
  const tok = {};
  COUNTS.set(el, tok);
  const mine = () => COUNTS.get(el) === tok;
  const end = finalText ?? format(to);
  const m = live();
  if (!m || !Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    el.textContent = end;
    return done();
  }
  let anim;
  try {
    anim = m.animate(from, to, { duration: Math.min(0.9, 0.4 + Math.log10(Math.abs(to - from) + 1) * 0.12), ease: [0.16, 1, 0.3, 1], onUpdate: (v) => mine() && (el.textContent = format(v)) });
  } catch {
    el.textContent = end;
    return done();
  }
  let timer;
  const cap = new Promise((r) => (timer = setTimeout(r, 1500)));
  return Promise.race([Promise.resolve(anim?.finished ?? anim).catch(() => {}), cap]).then(() => {
    clearTimeout(timer);
    try {
      anim.stop?.();
    } catch {
      /* ignore */
    }
    if (mine()) {
      COUNTS.delete(el);
      el.textContent = end;
    }
  });
}

/** The macOS "wrong password" shake. */
export function shake(el) {
  if (!live() || !isEl(el)) return done();
  return run(el, { translate: ["0px 0px", "-10px 0px", "9px 0px", "-7px 0px", "5px 0px", "-3px 0px", "0px 0px"] }, { duration: 0.42, ease: "easeInOut" }, { ms: 1000 });
}

/** A subtle breathing pulse for live indicators. Returns { stop() }; the element stays fully visible after stop. */
export function pulse(el) {
  const m = live();
  if (!m || !isEl(el)) return { stop() {}, finished: done() };
  let anim;
  try {
    anim = m.animate(el, { opacity: [1, 0.45, 1], scale: [1, 0.85, 1] }, { duration: 2.4, ease: "easeInOut", repeat: Infinity });
  } catch {
    return { stop() {}, finished: done() };
  }
  return {
    finished: done(),
    stop() {
      try {
        anim.stop?.();
      } catch {
        /* ignore */
      }
      el.style.removeProperty("opacity");
      el.style.removeProperty("transform");
    },
  };
}

// ── Page hooks (idempotent; see the top of this file) ──

const routeOf = () => (typeof location !== "undefined" ? (location.hash.replace(/^#\/?/, "").split("?")[0] || "home").toLowerCase() : "");
const lastRoute = new WeakMap(); // container → route last animated

/** True while the container shows only the "Loading…" placeholder (or nothing). */
const isPlaceholder = (root) => root.children.length === 0 || (root.children.length === 1 && root.firstElementChild.matches("p.muted"));

/**
 * Entrance for a freshly rendered page: pageEnter + table rows + stat numbers counting up. Runs only when the
 * route differs from the last one animated in this container (first render or navigation); re-renders of the
 * same page (auto-refresh, Refresh button) are left still. Pass { force: true } to animate regardless.
 */
export function animatePage(root, { force = false } = {}) {
  if (!isEl(root) || isPlaceholder(root)) return done();
  const route = routeOf();
  if (!force && lastRoute.get(root) === route) return done();
  lastRoute.set(root, route);
  if (!live()) return done();
  const jobs = [pageEnter(root)];
  const tables = [...root.querySelectorAll("table")].slice(0, 4);
  for (const t of tables) jobs.push(listStagger(t));
  for (const v of [...root.querySelectorAll(".stat .value")].slice(0, 8)) {
    const text = v.textContent.trim();
    if (!/^\d[\d,]*$/.test(text)) continue; // plain integers only ("1/2", "₹…", "--" stay as they are)
    const to = Number(text.replace(/,/g, ""));
    if (!Number.isSafeInteger(to) || to === 0) continue;
    jobs.push(countUp(v, 0, to, (x) => fmtDefault.format(Math.round(x)), text));
  }
  return Promise.all(jobs).then(() => {});
}

/** Slide the sidebar highlight to the active item (a[aria-current=page]). Safe to call after every nav rebuild. */
export function animateNav(navEl) {
  if (!isEl(navEl)) return done();
  const active = navEl.querySelector('a[aria-current="page"]');
  if (!active) return done();
  return navHighlight(navEl, active);
}

/**
 * Watch #content and #nav so pages and the sidebar animate without views.js calling anything. Call once at start-up.
 * MutationObserver callbacks run before the next paint, so the first frame already starts at opacity 0.
 */
export function installAutoAnimations({ content = "content", nav = "nav" } = {}) {
  if (typeof document === "undefined" || typeof MutationObserver !== "function" || document.__mcbAuto) return;
  document.__mcbAuto = true;
  const c = document.getElementById(content);
  const n = document.getElementById(nav);
  if (c) new MutationObserver(() => animatePage(c)).observe(c, { childList: true });
  if (n) new MutationObserver(() => animateNav(n)).observe(n, { childList: true });
}

// ── Data-viz primitives (docs/design/foundation.md §6.2). CSS does the drawing (app.css 3c); these only flip classes.
// All are no-ops without a DOM and fall back to a static cue (or nothing) under reduced motion. ──

const raf2 = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => requestAnimationFrame(fn)) : fn());

/**
 * Flash a value's background green (up) or red (down) once; the text colour never changes. Restarts on every call
 * without a reflow (two identical keyframe names alternate through data-flash a / b). Reduced motion: a 2 px
 * leading-edge marker for 3 s instead.
 * @param {Element} el @param {"up"|"down"|boolean} dir
 */
export function flashValue(el, dir) {
  if (!isEl(el)) return;
  const up = dir === "up" || dir === true;
  if (reducedMotion()) {
    el.classList.remove("dv-mark-up", "dv-mark-down");
    el.classList.add(up ? "dv-mark-up" : "dv-mark-down");
    clearTimeout(el.__dvMark);
    el.__dvMark = setTimeout(() => el.classList.remove("dv-mark-up", "dv-mark-down"), 3000);
    return;
  }
  el.classList.remove(up ? "dv-flash-down" : "dv-flash-up");
  el.classList.add(up ? "dv-flash-up" : "dv-flash-down");
  el.dataset.flash = el.dataset.flash === "a" ? "b" : "a";
}

/**
 * First draw of a set of bars: they grow from the baseline (scaleX / scaleY from 0), staggered 12 ms each and capped at
 * 240 ms. Later refreshes resize from the old value (a CSS transition on transform), they never regrow.
 * Works on .dv-bar, the chain's .vbar and SVG .dv-col / rect.dv-grow inside `root`.
 */
export function barsEnter(root) {
  if (!isEl(root) || reducedMotion() || typeof requestAnimationFrame !== "function") return done();
  const bars = [...root.querySelectorAll(".dv-bar, .vbar > span, .dv-col, rect.dv-grow")];
  if (!bars.length) return done();
  bars.forEach((b, i) => b.style.setProperty("--i", String(Math.min(i, 20))));
  root.classList.add("dv-enter");
  return new Promise((resolve) => {
    raf2(() => {
      root.classList.add("dv-entering");
      root.classList.remove("dv-enter");
      setTimeout(() => {
        root.classList.remove("dv-entering");
        resolve();
      }, 620);
    });
  });
}

/**
 * First draw of a line chart: the stroke draws itself (dash offset L → 0 over 600 ms) and the areas fade in after
 * 120 ms. On a refresh the caller simply replaces the path's d (no reveal).
 * @param {SVGPathElement|SVGPathElement[]} lines @param {Element[]} [areas]
 */
export function lineReveal(lines, areas = []) {
  if (typeof document === "undefined" || reducedMotion()) return done();
  const list = (Array.isArray(lines) ? lines : [lines]).filter((p) => isEl(p) && typeof p.getTotalLength === "function");
  const jobs = [];
  for (const p of list) {
    let L = 0;
    try {
      L = p.getTotalLength();
    } catch {
      L = 0;
    }
    // Dashed series keep their dashes: they fade in with the areas instead.
    const dashed = typeof getComputedStyle === "function" && getComputedStyle(p).strokeDasharray !== "none";
    if (!L || dashed || typeof p.animate !== "function") {
      p.classList.add("dv-area-in");
      continue;
    }
    p.style.strokeDasharray = `${L}`;
    const a = p.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 600, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    jobs.push(
      a.finished
        .catch(() => {})
        .then(() => p.style.removeProperty("stroke-dasharray")),
    );
  }
  for (const a of areas) if (isEl(a)) a.classList.add("dv-area-in");
  return Promise.all(jobs).then(() => {});
}
