/**
 * sheetDrag and swipeDismiss driven with synthetic pointer events on a fake element and a fake frame clock: present never
 * lifts the sheet off its edge, a slow drag past the middle dismisses, a short slow one snaps back, a flick dismisses with
 * its velocity, a refused dismissal springs back, dragging above the top resists, and a finger can catch a moving sheet.
 * Also the static rules the stylesheet and the live regions must keep (no will-change in CSS, no rebuild per poll).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setFrameSource, sheetDrag, swipeActions, swipeDismiss } from "./motion.js";

const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");

/** Just enough of an element: listeners, style, dataset, a height, and a target for `closest`. */
class FakeSheet {
  constructor(height = 400) {
    this.offsetHeight = height;
    this.offsetWidth = 320;
    this.style = { translate: "", opacity: "", willChange: "", props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
    this.dataset = {};
    this.listeners = {};
  }
  addEventListener(t, f) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener(t, f) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f);
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  fire(t, ev) {
    for (const f of this.listeners[t] ?? []) f(ev);
  }
  get y() {
    return parseFloat((this.style.translate || "0px 0px").split(" ")[1]);
  }
  get p() {
    return Number(this.style.props["--sheet-p"]);
  }
}
const onHandle = { closest: (sel) => (sel.includes("sheet-grabber") ? {} : null) };
const onBody = { closest: () => null };

describe("sheetDrag", () => {
  let queue;
  let clock;
  beforeEach(() => {
    queue = [];
    clock = 0;
    _setFrameSource({ raf: (f) => queue.push(f), caf: () => {}, now: () => clock });
  });
  afterEach(() => _setFrameSource());
  const frame = (n = 1) => {
    for (let i = 0; i < n && queue.length; i++) {
      clock += 1000 / 60;
      queue.shift()(clock);
    }
  };
  const settle = () => frame(240);
  /** pointer events with explicit timestamps (ms) */
  const ptr = (type, y, t, extra = {}) => ({ button: 0, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: y, timeStamp: t, target: onHandle, ...extra });
  const setup = (opts = {}) => {
    const el = new FakeSheet();
    const calls = { dismiss: [], detent: [] };
    const ctl = sheetDrag(el, { onDismiss: (v) => (calls.dismiss.push(v), opts.refuse ? false : true), onDetent: (i) => calls.detent.push(i), ...opts.sheet });
    return { el, ctl, calls };
  };
  /** Drag the handle from y0 by `dy` in `steps`, `stepMs` apart, then pause `holdMs` before the finger lifts. */
  const drag = (el, { dy, steps = 10, stepMs = 16, holdMs = 0, y0 = 20, t0 = 1000 }) => {
    el.fire("pointerdown", ptr("pointerdown", y0, t0));
    let t = t0;
    for (let i = 1; i <= steps; i++) {
      t += stepMs;
      el.fire("pointermove", ptr("pointermove", y0 + (dy * i) / steps, t));
    }
    t += holdMs;
    el.fire("pointerup", ptr("pointerup", y0 + dy, t));
  };

  it("present springs up from the bottom edge and never lifts the sheet off it", async () => {
    const { el, ctl } = setup();
    const ys = [];
    const p = ctl.present();
    for (let i = 0; i < 100 && queue.length; i++) {
      frame();
      ys.push(el.y);
    }
    await p;
    expect(ys[0]).toBeGreaterThan(200); // starts below the screen edge
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-9); // monotone: no overshoot
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(el.style.translate).toBe(""); // at rest it carries no transform
    expect(el.p).toBe(1); // the scrim is fully in
    expect(el.style.willChange).toBe("");
  });

  it("a slow drag past the middle dismisses with (almost) no velocity", () => {
    const { el, ctl, calls } = setup();
    ctl.present();
    settle();
    drag(el, { dy: 260, steps: 13, stepMs: 40, holdMs: 200 });
    expect(calls.dismiss).toHaveLength(1);
    expect(Math.abs(calls.dismiss[0].velocity)).toBeLessThan(50);
    expect(el.y).toBeGreaterThan(200);
    expect(el.p).toBeLessThan(0.5); // the scrim followed the sheet down
  });

  it("a short, slow drag snaps back and does not dismiss", () => {
    const { el, ctl, calls } = setup();
    ctl.present();
    settle();
    drag(el, { dy: 30, steps: 6, stepMs: 40, holdMs: 120 });
    expect(el.y).toBeGreaterThan(0);
    settle();
    expect(calls.dismiss).toHaveLength(0);
    expect(el.y).toBe(0);
    expect(el.style.translate).toBe("");
  });

  it("a flick dismisses even over a short distance, handing over its velocity", () => {
    const { el, ctl, calls } = setup();
    ctl.present();
    settle();
    drag(el, { dy: 90, steps: 6, stepMs: 12, holdMs: 0 }); // 90 px in 72 ms: about 1250 px/s
    expect(calls.dismiss).toHaveLength(1);
    expect(calls.dismiss[0].velocity).toBeGreaterThan(800);
    // and the dismiss spring carries on with that velocity (monotone, ends off screen)
    const ys = [];
    const out = ctl.dismiss();
    for (let i = 0; i < 80 && queue.length; i++) {
      frame();
      ys.push(el.y);
    }
    return out.then(() => {
      for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-9);
      expect(el.y).toBeGreaterThanOrEqual(400);
    });
  });

  it("a refused dismissal (canClose false) springs back to the open position", () => {
    const { el, ctl, calls } = setup({ refuse: true });
    ctl.present();
    settle();
    drag(el, { dy: 300, steps: 10, stepMs: 30, holdMs: 200 });
    expect(calls.dismiss).toHaveLength(1);
    settle();
    expect(el.y).toBe(0);
  });

  it("resists above the top detent (rubber band) and settles back", () => {
    const { el, ctl } = setup();
    ctl.present();
    settle();
    el.fire("pointerdown", ptr("pointerdown", 300, 1000));
    for (let i = 1; i <= 12; i++) el.fire("pointermove", ptr("pointermove", 300 - i * 60, 1000 + i * 30)); // 720 px up
    expect(el.y).toBeLessThan(0);
    expect(el.y).toBeGreaterThan(-130); // bounded, far less than the raw 720
    el.fire("pointerup", ptr("pointerup", 300 - 720, 1000 + 12 * 30 + 200));
    settle();
    expect(el.y).toBe(0);
  });

  it("ignores a mouse press that is not on the grabber or head (the body scrolls)", () => {
    const { el, ctl } = setup();
    ctl.present();
    settle();
    el.fire("pointerdown", ptr("pointerdown", 200, 1000, { target: onBody }));
    for (let i = 1; i <= 8; i++) el.fire("pointermove", ptr("pointermove", 200 + i * 30, 1000 + i * 16, { target: onBody }));
    el.fire("pointerup", ptr("pointerup", 440, 1200, { target: onBody }));
    expect(el.y).toBe(0);
  });

  it("a finger can catch the sheet while it is still moving", () => {
    const { el, ctl } = setup();
    ctl.present();
    frame(8);
    const caught = el.y;
    expect(caught).toBeGreaterThan(10); // still on its way up
    el.fire("pointerdown", ptr("pointerdown", 100, 1000));
    el.fire("pointermove", ptr("pointermove", 112, 1020)); // past the 3 px mouse slop
    el.fire("pointermove", ptr("pointermove", 124, 1040));
    expect(Math.abs(el.y - caught - 12)).toBeLessThan(6); // continues from where it was caught, no jump to the end
    expect(ctl.spring.running).toBe(false);
  });

  it("steps between detents and tells which one it rests at", async () => {
    const flush = () => new Promise((r) => setTimeout(r));
    const { el, ctl, calls } = setup({ sheet: { detents: [400, 200] } });
    await Promise.all([ctl.present(), Promise.resolve().then(settle)]);
    expect(el.y).toBe(0);
    drag(el, { dy: 190, steps: 10, stepMs: 30, holdMs: 200 }); // slow: the middle detent, not closed
    settle();
    expect(calls.dismiss).toHaveLength(0);
    expect(el.y).toBeCloseTo(200, 0);
    await flush();
    expect(calls.detent.at(-1)).toBe(1);
  });
});

describe("swipeDismiss", () => {
  let queue;
  let clock;
  beforeEach(() => {
    queue = [];
    clock = 0;
    _setFrameSource({ raf: (f) => queue.push(f), caf: () => {}, now: () => clock });
  });
  afterEach(() => _setFrameSource());
  const settle = () => {
    for (let i = 0; i < 200 && queue.length; i++) {
      clock += 1000 / 60;
      queue.shift()(clock);
    }
  };
  const ev = (y, t) => ({ button: 0, pointerId: 1, pointerType: "touch", clientX: 50, clientY: y, timeStamp: t, target: { closest: () => null } });

  it("throws a toast away past 60 px toward its edge, springs back otherwise, and refuses the other way", async () => {
    for (const [dy, dismissed, dirs] of [[-90, true, [-1]], [-30, false, [-1]], [90, false, [-1]], [90, true, [1]]]) {
      const el = new FakeSheet(60);
      const got = [];
      swipeDismiss(el, { axis: "y", directions: dirs, onDismiss: (v) => got.push(v) });
      el.fire("pointerdown", ev(300, 0));
      for (let i = 1; i <= 6; i++) el.fire("pointermove", ev(300 + (dy * i) / 6, i * 40));
      el.fire("pointerup", ev(300 + dy, 6 * 40 + 150));
      settle();
      await new Promise((r) => setTimeout(r));
      expect(got.length > 0, `${dy} ${dirs}`).toBe(dismissed);
      expect(el.style.translate).toBe(""); // always cleaned up
    }
  });
});

describe("rules the stylesheet and the live regions keep", () => {
  const css = read("app.css");
  const motion = css.slice(css.indexOf("/* === MOTION === */"), css.indexOf("/* === END MOTION === */"));

  it("the MOTION section exists, never sets will-change, and animates only compositor properties, widths and colours", () => {
    expect(motion.length).toBeGreaterThan(1000);
    expect(motion).not.toMatch(/will-change/);
    expect(motion).not.toMatch(/transition:\s*all/);
    for (const m of motion.matchAll(/transition:([^;}]+)[;}]/g)) {
      for (const part of m[1].split(/,(?![^(]*\))/)) {
        const prop = part.trim().split(/\s+/)[0];
        expect(["none", "translate", "scale", "opacity", "width", "background-color", "transform", "rotate"], `transition on ${prop}`).toContain(prop);
      }
    }
  });

  it("honours reduced motion where it adds motion: no ghosts, no popover animation, no pull offset", () => {
    const reduce = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toMatch(/\.toast-ghost \{ display: none; \}/);
    expect(reduce).toMatch(/\.popover\.floating \{ animation: none; \}/);
    expect(reduce).toMatch(/\.ptr svg \{ rotate: none; \}/);
  });

  it("sheets never use an overshooting bezier (the old curve lifted the sheet off the bottom edge)", () => {
    expect(css).not.toMatch(/dialog\.sheet[^{]*\{[^}]*cubic-bezier\(0?\.3, 1\.[0-9]/);
    expect(read("motion.js")).not.toMatch(/cubic-bezier\(0\.3, 1\.2/);
    expect(read("motion.js")).not.toMatch(/SPRING = "cubic-bezier/);
  });

  it("the budget chip and the readiness badge patch in place: nothing is rebuilt per message", () => {
    const budget = read("budget.js");
    expect(budget).toMatch(/countTo\(/);
    expect(budget).toMatch(/patchList\(/);
    expect(budget).not.toMatch(/popBody\.replaceChildren|sec\.replaceChildren\(windowNode|min\.replaceChildren\(windowNode/);
    // host.replaceChildren(btn) happens once at mount; inside draw() only patches
    const draw = budget.slice(budget.indexOf("const draw = () => {"), budget.indexOf("btn.addEventListener"));
    expect(draw).not.toMatch(/replaceChildren/);
    const readiness = read("readiness.js");
    const badge = readiness.slice(readiness.indexOf("function drawBadge()"), readiness.indexOf("export function mountReadinessBadge"));
    expect(badge).toMatch(/setText\(long, m\.text\)/);
    expect(badge.match(/replaceChildren/g)?.length ?? 0).toBeLessThanOrEqual(2); // the slot once, the button once (first draw only)
    expect(badge).toMatch(/if \(!long \|\| !short\)/);
  });

  it("the sidebar, tab bar and tab strip are built once and only move aria-current afterwards", () => {
    const views = read("views.js");
    expect(views).toMatch(/navEl\.dataset\.pages === sig/);
    expect(views).toMatch(/bar\.dataset\.pages === sig/);
    expect(views).toMatch(/bar\.dataset\.tabs === sig/);
    expect(views).toMatch(/await pageLeave\(root, way\)/);
  });
});

describe("swipeActions", () => {
  let queue;
  let clock;
  const had = {};
  beforeEach(() => {
    queue = [];
    clock = 0;
    _setFrameSource({ raf: (f) => queue.push(f), caf: () => {}, now: () => clock });
    had.document = globalThis.document;
    const el = () => ({ style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, dataset: {}, children: [], className: "", attrs: {}, classList: { add() {}, remove() {} }, setAttribute() {}, append(c) { this.children.push(c); }, remove() {}, addEventListener() {} });
    globalThis.document = { createElement: el, addEventListener() {} };
    swipeActions.watching = true; // no document-level listeners in the test
  });
  afterEach(() => {
    _setFrameSource();
    if (had.document === undefined) delete globalThis.document;
    else globalThis.document = had.document;
  });
  const settle = async () => {
    for (let i = 0; i < 240 && queue.length; i++) {
      clock += 1000 / 60;
      queue.shift()(clock);
    }
    await new Promise((r) => setTimeout(r));
  };
  const make = () => {
    const row = new FakeSheet(56);
    row.offsetWidth = 320;
    row.classList = { add() {}, remove() {} };
    row.append = () => {};
    const ran = [];
    const api = swipeActions(row, { actions: [{ label: "Cancel", tone: "destructive", run: () => ran.push("cancel") }] });
    return { row, api, ran };
  };
  const ev = (x, t, extra = {}) => ({ button: 0, pointerId: 1, pointerType: "touch", clientX: x, clientY: 100, timeStamp: t, target: { closest: () => null }, ...extra });
  const swipe = (row, { dx, steps = 8, stepMs = 30, hold = 150 }) => {
    row.fire("pointerdown", ev(300, 0));
    for (let i = 1; i <= steps; i++) row.fire("pointermove", ev(300 + (dx * i) / steps, i * stepMs));
    row.fire("pointerup", ev(300 + dx, steps * stepMs + hold));
  };

  it("opens past half the revealed width and springs shut below it", async () => {
    const a = make();
    swipe(a.row, { dx: -60 }); // 60 of 84 px, less the slop: past half
    await settle();
    expect(a.row.style.translate).toBe("-84px 0px");
    expect(a.api.open).toBe(true);
    const b = make();
    swipe(b.row, { dx: -25 }); // short of half
    await settle();
    expect(b.row.style.translate).toBe("");
    expect(b.api.open).toBe(false);
    expect(a.ran.length + b.ran.length).toBe(0);
  });

  it("a long swipe runs the first action, and a mouse does nothing (touch and pen only)", async () => {
    const a = make();
    swipe(a.row, { dx: -230, steps: 10 });
    await settle();
    expect(a.ran).toEqual(["cancel"]);
    expect(a.row.style.translate).toBe("");
    const b = make();
    b.row.fire("pointerdown", ev(300, 0, { pointerType: "mouse" }));
    for (let i = 1; i <= 8; i++) b.row.fire("pointermove", ev(300 - i * 30, i * 20, { pointerType: "mouse" }));
    b.row.fire("pointerup", ev(60, 400, { pointerType: "mouse" }));
    await settle();
    expect(b.row.style.translate).toBe("");
    expect(b.ran).toEqual([]);
  });

  it("only one row stays open: opening a second closes the first", async () => {
    const a = make();
    const b = make();
    swipe(a.row, { dx: -70 });
    await settle();
    expect(a.api.open).toBe(true);
    swipe(b.row, { dx: -70 });
    await settle();
    expect(b.api.open).toBe(true);
    expect(a.api.open).toBe(false);
    expect(a.row.style.translate).toBe("");
  });
});
