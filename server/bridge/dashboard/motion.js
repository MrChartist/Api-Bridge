// Motion for the dashboard, on the Web Animations API (no library). Small, honest, and out of the way.
//
// Rules every helper follows:
//  - It returns a promise that resolves when the animation is over (or at once when it is skipped).
//  - It is a no-op (resolved promise) without a DOM (Node / tests), without element.animate, and when the visitor prefers
//    reduced motion. Importing this file never touches window or document.
//  - It never leaves an element hidden or moved: enters fill nothing, exits hold their end state only until the caller has
//    closed or hidden the element, and every wait has a safety cap (background tabs pause animation frames).
//  - Movement uses the individual CSS properties `translate` and `scale`, which compose with any `transform` the
//    stylesheet sets (a centred toast, for example).
//
// Curves: ease-out for entrances; a gentle overshoot only on the things that have a thumb or an edge to settle (sheets).
//
// Wired in app.js, nothing to call from page code:
//  - installAutoAnimations(): when #content shows a real page for a new route, animatePage(#content) runs (a short
//    fade and rise, the first panels staggered). Auto-refreshes and in-page redraws stay still.
//  - modal() and sheetPopover(): sheetIn / sheetOut.   toast(): bannerIn / bannerOut.   Sign-in error: shake.
//  - Button presses, the segmented thumb, switches, popovers and the sidebar selection are CSS (app.css).

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
const SPRING = "cubic-bezier(0.3, 1.25, 0.5, 1)";
const isEl = (x) => typeof Element !== "undefined" && x instanceof Element;
const done = () => Promise.resolve();
/** True when animations should run. */
const live = () => typeof document !== "undefined" && typeof Element !== "undefined" && typeof Element.prototype.animate === "function" && !reducedMotion();
/** True when sheets are bottom sheets (phones, below 720px: see app.css dialog.sheet). */
const bottomSheet = () => typeof matchMedia === "function" && matchMedia("(max-width: 719px)").matches;

/** Start an animation; resolve when it finishes, is cancelled, or the cap passes. Never rejects. */
function play(el, frames, options, { cap = 1200 } = {}) {
  let anim;
  try {
    anim = el.animate(frames, options);
  } catch {
    return { anim: null, done: done() };
  }
  let timer;
  const capped = new Promise((r) => (timer = setTimeout(r, cap)));
  const finished = anim.finished.then(
    () => {},
    () => {},
  );
  return { anim, done: Promise.race([finished, capped]).then(() => clearTimeout(timer)) };
}

// ── Pages ──

/** The things worth staggering in a page: descend through single wrappers to the first level with siblings. */
function pageItems(container) {
  let items = [...container.children];
  for (let depth = 0; depth < 3 && items.length === 1 && items[0].children.length > 1; depth++) items = [...items[0].children];
  return items.filter((el) => !el.hidden).slice(0, 10);
}

/** Content fade and a short rise, the first panels staggered (about 0.3 s, no overshoot). */
export function pageEnter(container) {
  if (!live() || !isEl(container)) return done();
  const items = pageItems(container);
  return Promise.all(items.map((el, i) => play(el, { opacity: [0, 1], translate: ["0px 8px", "0px 0px"] }, { duration: 300, delay: i * 30, easing: EASE, fill: "backwards" }).done)).then(() => {});
}

// ── Sheets (modal dialogs) ──

/**
 * Sheet in: on a phone the panel rises from the bottom edge and settles with a small overshoot; from 720px up it scales
 * 0.96 to 1 and settles into place. The backdrop fades either way. `backdrop` is an element, or the <dialog> itself (then
 * its ::backdrop is faded).
 */
export function sheetIn(backdrop, panel) {
  if (!live()) return done();
  const jobs = [fadeBackdrop(backdrop, panel, [0, 1], 220)];
  if (isEl(panel)) {
    if (bottomSheet()) jobs.push(play(panel, { translate: ["0px 100%", "0px 0px"] }, { duration: 420, easing: SPRING }).done);
    else jobs.push(play(panel, { opacity: [0, 1], scale: [0.96, 1], translate: ["0px 8px", "0px 0px"] }, { duration: 300, easing: SPRING }).done);
  }
  return Promise.all(jobs).then(() => {});
}

/**
 * Reverse of sheetIn (about 180 ms; resolves within 240 ms even when frames are slow, at once with reduced motion) so the
 * caller can close or remove the nodes. The panel holds its end state until then; the exit is dropped right after.
 */
export function sheetOut(backdrop, panel) {
  if (!live()) return done();
  const jobs = [fadeBackdrop(backdrop, panel, [1, 0], 180, true)];
  let exit = null;
  if (isEl(panel)) {
    for (const a of panel.getAnimations()) a.cancel(); // an unfinished sheetIn
    const r = bottomSheet()
      ? play(panel, { translate: ["0px 0px", "0px 100%"] }, { duration: 220, easing: EASE_IN, fill: "forwards" }, { cap: 260 })
      : play(panel, { opacity: [1, 0], scale: [1, 0.97], translate: ["0px 0px", "0px 4px"] }, { duration: 170, easing: EASE_IN, fill: "forwards" }, { cap: 220 });
    exit = r.anim;
    jobs.push(r.done);
  }
  let timer;
  const cap = new Promise((r) => (timer = setTimeout(r, 240)));
  return Promise.race([Promise.all(jobs), cap]).then(() => {
    clearTimeout(timer);
    setTimeout(() => exit?.cancel(), 0);
  });
}

function fadeBackdrop(backdrop, panel, opacity, ms, hold = false) {
  if (!isEl(backdrop)) return done();
  const opts = { duration: ms, easing: "ease-out", fill: hold ? "forwards" : "none" };
  // A <dialog> passed as its own backdrop: fade ::backdrop (pseudo-elements need the pseudoElement option).
  if (backdrop === panel || backdrop.tagName === "DIALOG") {
    const r = play(backdrop, { opacity }, { ...opts, pseudoElement: "::backdrop" }, { cap: ms + 100 });
    if (hold) r.done.then(() => setTimeout(() => r.anim?.cancel(), 0));
    return r.done;
  }
  return play(backdrop, { opacity }, opts, { cap: ms + 100 }).done;
}

// ── Banners (toasts) ──

/** Which way a banner slides: in from the right edge when it sits on the right, else down from the top or up from the bottom. */
function bannerFrom(el) {
  const r = el.getBoundingClientRect();
  if (r.width && r.left + r.width / 2 > (window.innerWidth || 0) * 0.6) return "24px 0px";
  return r.top < (window.innerHeight || 0) / 2 ? "0px -12px" : "0px 12px";
}

export function bannerIn(el) {
  if (!live() || !isEl(el)) return done();
  return play(el, { opacity: [0, 1], translate: [bannerFrom(el), "0px 0px"] }, { duration: 320, easing: SPRING }).done;
}

/** Slide back out. Resolves when done; the caller then hides the element. */
export function bannerOut(el) {
  if (!live() || !isEl(el) || el.hidden) return done();
  const r = play(el, { opacity: [1, 0], translate: ["0px 0px", bannerFrom(el)] }, { duration: 200, easing: EASE_IN, fill: "forwards" }, { cap: 260 });
  return r.done.then(() => setTimeout(() => r.anim?.cancel(), 0));
}

// ── Small feedback ──

/** The "wrong password" shake. */
export function shake(el) {
  if (!live() || !isEl(el)) return done();
  return play(el, { translate: ["0px 0px", "-8px 0px", "7px 0px", "-5px 0px", "3px 0px", "0px 0px"] }, { duration: 380, easing: "ease-in-out" }).done;
}

/**
 * A subtle breathing pulse for live indicators. Returns { stop() }; the element stays fully visible after stop.
 * A CSS animation of opacity and transform only (`.dv-breathe`, app.css) on its own compositor layer: no JS frame loop
 * and no repaint of the page under it. Paused while the tab is hidden, none under reduced motion (both in app.css).
 */
export function pulse(el) {
  if (!isEl(el)) return { stop() {}, finished: done() };
  watchHidden();
  el.classList.add("dv-breathe");
  return {
    finished: done(),
    stop() {
      el.classList.remove("dv-breathe");
    },
  };
}
let hiddenWatched = false;
/** `:root.tab-hidden` while the tab is in the background: the endless CSS animations pause on it (app.css). */
function watchHidden() {
  if (hiddenWatched || typeof document === "undefined") return;
  hiddenWatched = true;
  const sync = () => document.documentElement.classList.toggle("tab-hidden", document.hidden);
  document.addEventListener("visibilitychange", sync);
  sync();
}

// ── Page hook (idempotent) ──

const routeOf = () => (typeof location !== "undefined" ? (location.hash.replace(/^#\/?/, "").split("?")[0] || "home").toLowerCase() : "");
const lastRoute = new WeakMap(); // container -> route last animated

/** True while the container shows only the loading skeleton (or nothing). */
const isPlaceholder = (root) => root.children.length === 0 || (root.children.length === 1 && root.firstElementChild.matches(".page-skeleton, p.muted"));

/**
 * Entrance for a freshly rendered page. Runs only when the route differs from the last one animated in this container (first
 * render or navigation); re-renders of the same page (auto-refresh, the Reload button) stay still. `force: true` animates regardless.
 */
export function animatePage(root, { force = false } = {}) {
  if (!isEl(root) || isPlaceholder(root)) return done();
  const route = routeOf();
  if (!force && lastRoute.get(root) === route) return done();
  lastRoute.set(root, route);
  return pageEnter(root);
}

/** Watch #content so pages animate without views.js calling anything. Call once at start-up. */
export function installAutoAnimations({ content = "content" } = {}) {
  if (typeof document === "undefined" || typeof MutationObserver !== "function" || document.__mcbAuto) return;
  document.__mcbAuto = true;
  const c = document.getElementById(content);
  if (c) new MutationObserver(() => animatePage(c)).observe(c, { childList: true });
}
