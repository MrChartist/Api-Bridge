/**
 * motion.js: the spring against its closed-form solutions, the generated `linear()` tokens (and that app.css carries the very
 * same strings), the gesture decisions as pure functions, keyed list patching on a minimal fake DOM, and counters. Nothing
 * here needs a browser: motion.js never touches window or document on import.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SPRINGS,
  Spring,
  _setFrameSource,
  countTo,
  fitVelocity,
  lockAxis,
  overshootOf,
  patchList,
  planPatch,
  project,
  rubber,
  runningSprings,
  setAttr,
  setClass,
  setText,
  settleTarget,
  settleTime,
  shouldDismiss,
  spring,
  springAt,
  springParams,
  springToLinear,
  viewTransition,
} from "./motion.js";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const near = (a, b, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("spring maths", () => {
  it("maps response and bounce to stiffness and damping (mass 1); bounce 0 is critical damping", () => {
    const p = springParams(0.5, 0);
    near(p.w0, (2 * Math.PI) / 0.5);
    near(p.stiffness, p.w0 ** 2);
    near(p.zeta, 1);
    near(p.damping, 2 * Math.sqrt(p.stiffness)); // c = 2 sqrt(k m)
    near(springParams(0.35, 0.15).zeta, 0.85);
    near(springParams(0.35, -0.5).zeta, 2); // negative bounce: over-damped
  });

  it("starts at 0 with the given velocity, ends at 1, in every damping regime", () => {
    for (const [r, b] of [[0.35, 0.15], [0.5, 0], [0.4, -0.5]]) {
      const p = springParams(r, b);
      near(springAt(0, p), 0);
      near(springAt(5, p), 1, 1e-9);
      // slope at 0 equals the initial velocity v0 (finite difference)
      const v0 = 3;
      near((springAt(1e-6, p, v0) - springAt(0, p, v0)) / 1e-6, v0, 1e-3);
    }
  });

  it("overshoots by exp(-pi zeta / sqrt(1 - zeta^2)), and critical or over-damped springs do not overshoot", () => {
    for (const [name, { response, bounce }] of Object.entries(SPRINGS)) {
      const p = springParams(response, bounce);
      let peak = 0;
      for (let ms = 0; ms < 3000; ms++) peak = Math.max(peak, springAt(ms / 1000, p));
      const expected = overshootOf(p.zeta);
      expect(Math.abs(peak - 1 - expected), name).toBeLessThan(2e-3);
      if (p.zeta >= 1) expect(peak, name).toBeLessThanOrEqual(1 + 1e-9);
    }
    near(overshootOf(0.7), 0.046, 1e-3); // the 4.6 % of the bouncy token
    near(overshootOf(0.8), 0.015, 1e-3);
  });

  it("settleTime is the last instant outside the tolerance band", () => {
    for (const { response, bounce } of Object.values(SPRINGS)) {
      const p = springParams(response, bounce);
      const T = settleTime(p, 0.002);
      for (let ms = Math.round(T * 1000); ms < Math.round(T * 1000) + 3000; ms += 7) expect(Math.abs(springAt(ms / 1000, p) - 1)).toBeLessThanOrEqual(0.002);
      expect(Math.abs(springAt(T - 0.001, p) - 1)).toBeGreaterThan(0.002);
    }
  });
});

describe("Spring class", () => {
  it("matches the closed-form step response at any frame rate", () => {
    for (const [name, s] of Object.entries(SPRINGS)) {
      const p = springParams(s.response, s.bounce);
      for (const fps of [30, 60, 120, 240]) {
        const sp = new Spring(0, name);
        sp.retarget(1, 0);
        let t = 0;
        for (let i = 0; i < Math.round(0.3 * fps); i++) {
          sp.step(1 / fps);
          t += 1 / fps;
        }
        near(sp.value, springAt(t, p), 1e-9);
      }
    }
  });

  it("scales to any range and start: value = target + (x0 - target) response", () => {
    const sp = new Spring(100, "smooth");
    sp.retarget(300, 0);
    sp.step(0.05);
    sp.step(0.05);
    const p = springParams(SPRINGS.smooth.response, 0);
    near(sp.value, 100 + 200 * springAt(0.1, p), 1e-9);
  });

  it("keeps position and velocity when the target changes mid-flight", () => {
    for (const name of ["smooth", "snappy", "bouncy", "sheet"]) {
      const sp = new Spring(0, name);
      sp.retarget(400, 0);
      for (let i = 0; i < 9; i++) sp.step(1 / 60);
      const [x, v] = [sp.value, sp.velocity];
      expect(Math.abs(v)).toBeGreaterThan(50);
      sp.retarget(-120); // reverse: velocity inherited
      near(sp.value, x, 1e-9);
      sp.step(0); // evaluates at t = 0 of the new motion
      near(sp.value, x, 1e-9);
      near(sp.velocity, v, 1e-6);
      for (let i = 0; i < 600; i++) sp.step(1 / 60);
      near(sp.value, -120, 1e-3);
    }
  });

  it("takes a gesture's release velocity, and grab() stops it where it is", () => {
    const sp = new Spring(0, "sheet");
    sp.retarget(0, 1500); // thrown at 1500 px/s toward the target it already has
    sp.step(1 / 60);
    expect(sp.value).toBeGreaterThan(10);
    sp.grab();
    const x = sp.value;
    sp.step(0.05);
    near(sp.value, x, 1e-9);
    near(sp.velocity, 0, 1e-9);
    expect(sp.atRest()).toBe(true);
  });

  it("over-damped and critical springs never cross their target", () => {
    for (const bounce of [0, -0.5, -0.9]) {
      const sp = new Spring(0, { response: 0.4, bounce });
      sp.retarget(1, 0);
      for (let i = 0; i < 300; i++) {
        sp.step(1 / 60);
        expect(sp.value).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

describe("the shared frame loop", () => {
  let queue;
  let clock;
  beforeEach(() => {
    queue = [];
    clock = 0;
    _setFrameSource({
      raf: (f) => queue.push(f),
      caf: () => {},
      now: () => clock,
    });
  });
  afterEach(() => _setFrameSource());
  const run = (frames, dt = 1000 / 60) => {
    for (let i = 0; i < frames && queue.length; i++) {
      clock += dt;
      const f = queue.shift();
      f(clock);
    }
  };

  it("runs every spring on one rAF, stops when all settle, and resolves each promise", async () => {
    const seen = [];
    const a = new Spring(0, "snappy");
    const b = new Spring(10, "brisk");
    const pa = a.to(100, { onUpdate: (v) => seen.push(v) });
    const pb = b.to(0);
    expect(runningSprings()).toBe(2);
    expect(queue.length).toBe(1); // one frame request for both
    run(120);
    await Promise.all([pa, pb]);
    expect(runningSprings()).toBe(0);
    expect(queue.length).toBe(0); // loop stopped
    near(a.value, 100, 1e-9);
    near(b.value, 0, 1e-9);
    expect(seen.at(-1)).toBe(100); // the final update is exact
    expect(seen.length).toBeGreaterThan(10);
  });

  it("cancel() stops a spring where it is and resolves its promise", async () => {
    const a = new Spring(0, "smooth");
    const p = a.to(100);
    run(10);
    const x = a.value;
    expect(x).toBeGreaterThan(0);
    a.cancel();
    await p;
    expect(runningSprings()).toBe(0);
    run(5);
    expect(a.value).toBe(x);
  });

  it("retargeting while it runs keeps the velocity and settles on the new target", async () => {
    const a = new Spring(0, "smooth");
    const p1 = a.to(100);
    run(15);
    const v = a.velocity;
    expect(v).toBeGreaterThan(0);
    const p2 = a.to(20);
    // at the instant of the retarget the motion continues with the same position and velocity
    const x = a.value;
    a.step(0);
    near(a.value, x, 1e-9);
    near(a.velocity, v, 1e-6);
    run(1);
    expect(a.velocity).toBeLessThan(v); // then the new target pulls it back
    run(300);
    await Promise.all([p1, p2]);
    near(a.value, 20, 1e-9);
  });

  it("clamps a stalled frame to 50 ms (a background tab must not fling anything)", () => {
    const a = new Spring(0, "smooth");
    a.to(100);
    clock += 5000;
    queue.shift()(clock);
    const p = springParams(0.5, 0);
    near(a.value, 100 * springAt(0.05, p), 1e-9);
  });
});

describe("spring tokens (linear() strings)", () => {
  const known = { brisk: 297, smooth: 674, sheet: 423, snappy: 450, thumb: 384, bouncy: 729 };

  it("gives { duration, easing } for each of the six tokens, matching the generator", () => {
    for (const [name, ms] of Object.entries(known)) {
      const s = spring(name);
      expect(s.duration, name).toBe(ms);
      expect(s.easing, name).toMatch(/^(linear\(|cubic-bezier\()/);
    }
    expect(spring("nope").duration).toBe(674); // unknown names fall back to smooth
    expect(spring().duration).toBe(674);
  });

  it("is deterministic and stays within 0.0025 of the true curve", () => {
    for (const [name, { response, bounce }] of Object.entries(SPRINGS)) {
      const a = springToLinear(response, bounce);
      const b = springToLinear(response, bounce);
      expect(a.css, name).toBe(b.css);
      expect(a.maxErr, name).toBeLessThan(0.0025);
      expect(a.stops, name).toBeLessThan(40);
      expect(a.css.length, name).toBeLessThan(420);
    }
  });

  it("prints a valid linear(): starts at 0, ends at 1, percentages ascend, overshoot only where the spring has it", () => {
    for (const [name, { response, bounce }] of Object.entries(SPRINGS)) {
      const g = springToLinear(response, bounce);
      expect(g.css.startsWith("linear(0, ")).toBe(true);
      expect(g.css.endsWith(", 1)")).toBe(true);
      const stops = [...g.css.matchAll(/(-?[\d.]+) ([\d.]+)%/g)].map((m) => [Number(m[2]), Number(m[1])]);
      for (let i = 1; i < stops.length; i++) expect(stops[i][0], name).toBeGreaterThan(stops[i - 1][0]);
      const peak = Math.max(...stops.map(([, y]) => y));
      if (springParams(response, bounce).zeta >= 0.9) expect(peak, `${name} must not overshoot`).toBeLessThanOrEqual(1);
    }
    // bottom sheets never overshoot: that was the defect (a sheet lifting off the bottom edge)
    expect(springToLinear(SPRINGS.sheet.response, SPRINGS.sheet.bounce).overshootPct).toBeLessThan(0.01);
    // thumbs may: 1.5 %
    expect(springToLinear(SPRINGS.thumb.response, SPRINGS.thumb.bounce).overshootPct).toBeGreaterThan(1);
  });

  it("app.css carries exactly the generated strings and durations", () => {
    for (const [name, { response, bounce }] of Object.entries(SPRINGS)) {
      const g = springToLinear(response, bounce);
      expect(css, `--spring-${name} in app.css is stale: regenerate it from motion.js springToLinear`).toContain(`--spring-${name}: ${g.css};`);
      expect(css).toContain(`--spring-${name}-dur: ${g.durationMs}ms;`);
    }
  });
});

describe("gesture decisions", () => {
  it("projects a release velocity to where it would coast", () => {
    near(project(800, 0.99), 79.2, 1e-9);
    near(project(1500, 0.99), 148.5, 1e-9);
    near(project(800, 0.998), 399.2, 1e-6);
    expect(project(-800)).toBeLessThan(0);
    expect(project(0)).toBe(0);
  });

  it("rubber-bands: the first pixels follow, resistance grows, the asymptote is the bound", () => {
    for (const [x, y] of [[20, 10.7], [50, 25.7], [100, 48.4], [200, 86.3], [400, 141.9], [800, 209.5]]) expect(rubber(x, 400)).toBeCloseTo(y, 1);
    expect(rubber(0, 400)).toBe(0);
    expect(rubber(-5, 400)).toBe(0);
    expect(rubber(1e9, 400)).toBeLessThan(400);
    expect(rubber(10, 400)).toBeGreaterThan(5); // about 55 % of the movement at the start
  });

  it("fits velocity over the last 100 ms by least squares; a paused finger is at rest", () => {
    const line = (v, n = 8, dt = 8) => Array.from({ length: n }, (_, i) => ({ t: i * dt, x: 0, y: 100 + (v * i * dt) / 1000 }));
    const s = line(1200);
    near(fitVelocity(s, 56).y, 1200, 1e-6);
    near(fitVelocity(line(-900), 56).y, -900, 1e-6);
    expect(fitVelocity(s, 56 + 80)).toEqual({ x: 0, y: 0 }); // the last sample is older than 60 ms
    expect(fitVelocity(s.slice(0, 1), 8)).toEqual({ x: 0, y: 0 });
    // samples older than 100 ms are ignored
    const old = [{ t: 0, x: 0, y: 0 }, { t: 10, x: 0, y: 500 }, ...line(100, 6, 8).map((p) => ({ ...p, t: p.t + 200 }))];
    near(fitVelocity(old, 240).y, 100, 1e-6);
    // noise: a jittery 800 px/s drag stays close
    const noisy = Array.from({ length: 12 }, (_, i) => ({ t: i * 8, x: 0, y: (800 * i * 8) / 1000 + (i % 2 ? 1.5 : -1.5) }));
    expect(Math.abs(fitVelocity(noisy, 88).y - 800)).toBeLessThan(120);
  });

  it("locks the axis after the slop, on the dominant direction, else gives the gesture back", () => {
    expect(lockAxis(3, 4)).toBe("wait"); // 5 px < 8
    expect(lockAxis(2, 12)).toBe("y");
    expect(lockAxis(14, 3)).toBe("x");
    expect(lockAxis(10, 9)).toBe("none");
    expect(lockAxis(0, 4, 3)).toBe("y"); // mouse slop
  });

  it("settles a sheet by projection, with the 600 px/s flick rule and a snap-back for small slow drags", () => {
    const rests = [0, 400]; // open, closed
    // slow, past the middle: dismiss; before it: stay
    expect(settleTarget(250, 0, rests)).toEqual({ index: 1, dismiss: true });
    expect(settleTarget(150, 0, rests)).toEqual({ index: 0, dismiss: false });
    // projection: a short drag thrown hard lands past the middle even though the finger is above it
    expect(settleTarget(90, 450, rests).dismiss).toBe(false); // 90 + 445 = 535 > 200 but |v| < 600... see below
    // a flick wins: down dismisses, up from a lower spot reopens
    expect(settleTarget(30, 900, rests)).toEqual({ index: 1, dismiss: true });
    expect(settleTarget(300, -900, rests)).toEqual({ index: 0, dismiss: false });
    // a tiny slow drag snaps back to where it started
    expect(settleTarget(30, 100, rests)).toEqual({ index: 0, dismiss: false });
    // above the top (rubber band) with a downward flick still moves on
    expect(settleTarget(-20, 800, rests)).toEqual({ index: 0, dismiss: false });
  });

  it("steps through detents: a flick moves one detent, not two", () => {
    const rests = [0, 300, 600]; // large, medium, closed
    expect(settleTarget(0.2, 900, rests, { from: 0 })).toEqual({ index: 1, dismiss: false });
    expect(settleTarget(305, 900, rests, { from: 1 })).toEqual({ index: 2, dismiss: true });
    expect(settleTarget(290, -900, rests, { from: 1 })).toEqual({ index: 0, dismiss: false });
    expect(settleTarget(310, 0, rests, { from: 1 })).toEqual({ index: 1, dismiss: false }); // nearest detent
    expect(settleTarget(480, 0, rests, { from: 1 }).dismiss).toBe(true);
  });

  it("dismisses a swipe past 60 px or faster than 500 px/s in the direction of travel", () => {
    expect(shouldDismiss(70, 0)).toBe(true);
    expect(shouldDismiss(-70, 0)).toBe(true);
    expect(shouldDismiss(30, 600)).toBe(true);
    expect(shouldDismiss(30, -600)).toBe(false); // thrown back the other way
    expect(shouldDismiss(30, 200)).toBe(false);
    expect(shouldDismiss(0, 800)).toBe(true);
  });
});

// ── A minimal DOM: enough for patchList ──

class FakeEl {
  constructor(tag = "div", text = "") {
    this.tag = tag;
    this.text = text;
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.ops = 0;
    this.attrs = {};
  }
  get nextSibling() {
    const sibs = this.parentNode?.children ?? [];
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  get firstChild() {
    return null;
  }
  get textContent() {
    return this.text;
  }
  set textContent(v) {
    this.text = v;
    this.ops++;
  }
  append(...els) {
    for (const el of els) this.insertBefore(el, null);
  }
  insertBefore(el, ref) {
    el.parentNode?.children.splice(el.parentNode.children.indexOf(el), 1);
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i < 0 ? this.children.length : i, 0, el);
    el.parentNode = this;
    el.ops++;
  }
  remove() {
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(el) {
    const p = this.parentNode;
    p.children.splice(p.children.indexOf(this), 1, el);
    el.parentNode = p;
    this.parentNode = null;
  }
  contains() {
    return false;
  }
  hasAttribute(n) {
    return n in this.attrs;
  }
  getAttribute(n) {
    return this.attrs[n] ?? null;
  }
  setAttribute(n, v) {
    this.attrs[n] = String(v);
    this.ops++;
  }
  removeAttribute(n) {
    delete this.attrs[n];
    this.ops++;
  }
  classList = {
    s: new Set(),
    contains(c) {
      return this.s.has(c);
    },
    add(c) {
      this.s.add(c);
    },
    toggle(c, on) {
      if (on) this.s.add(c);
      else this.s.delete(c);
    },
  };
}

describe("planPatch", () => {
  it("lists removals, additions and the fewest moves", () => {
    expect(planPatch(["a", "b", "c"], ["a", "b", "c"])).toMatchObject({ remove: [], add: [], move: [], changed: false });
    expect(planPatch(["a", "b", "c"], ["a", "x", "b", "c"])).toMatchObject({ remove: [], add: ["x"], move: [], changed: true });
    expect(planPatch(["a", "b", "c"], ["a", "c"])).toMatchObject({ remove: ["b"], add: [], move: [] });
    // the last item moves to the front: only that one moves
    expect(planPatch(["a", "b", "c", "d"], ["d", "a", "b", "c"]).move).toEqual(["d"]);
    // reversing 3 items moves 2 (a longest increasing run of 1 stays)
    expect(planPatch(["a", "b", "c"], ["c", "b", "a"]).move).toHaveLength(2);
    expect(planPatch([], ["a", "b"])).toMatchObject({ add: ["a", "b"], changed: true });
    expect(planPatch(["a"], [])).toMatchObject({ remove: ["a"], changed: true });
  });
});

describe("patchList", () => {
  const render = (it, el) => {
    const e = el ?? new FakeEl("li");
    e.text = `${it.id}:${it.v}`;
    return e;
  };
  const texts = (c) => c.children.map((e) => e.text);
  const fill = (items) => {
    const c = new FakeEl("ul");
    patchList(c, items, (x) => x.id, render);
    return c;
  };

  it("fills an empty container in order and tags each child with its key", () => {
    const c = fill([{ id: "a", v: 1 }, { id: "b", v: 2 }]);
    expect(texts(c)).toEqual(["a:1", "b:2"]);
    expect(c.children.map((e) => e.dataset.key)).toEqual(["a", "b"]);
  });

  it("updates in place: the same elements, touched only through render, and no DOM moves", () => {
    const c = fill([{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }]);
    const before = [...c.children];
    const opsBefore = before.map((e) => e.ops);
    const r = patchList(c, [{ id: "a", v: 10 }, { id: "b", v: 2 }, { id: "c", v: 30 }], (x) => x.id, render);
    expect(r).toEqual({ added: 0, removed: 0, moved: 0, kept: 3 });
    expect(c.children).toEqual(before);
    c.children.forEach((e, i) => expect(e).toBe(before[i]));
    expect(texts(c)).toEqual(["a:10", "b:2", "c:30"]);
    expect(c.children.map((e) => e.ops)).toEqual(opsBefore); // nothing was re-inserted
  });

  it("inserts and removes without disturbing the neighbours", () => {
    const c = fill([{ id: "a", v: 1 }, { id: "c", v: 3 }]);
    const [a, cc] = c.children;
    patchList(c, [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }], (x) => x.id, render);
    expect(texts(c)).toEqual(["a:1", "b:2", "c:3"]);
    expect(c.children[0]).toBe(a);
    expect(c.children[2]).toBe(cc);
    const r = patchList(c, [{ id: "c", v: 3 }], (x) => x.id, render);
    expect(r).toMatchObject({ removed: 2, kept: 1 });
    expect(texts(c)).toEqual(["c:3"]);
    expect(c.children[0]).toBe(cc);
  });

  it("reorders by moving as few elements as possible, keeping every element", () => {
    const c = fill(["a", "b", "c", "d"].map((id, i) => ({ id, v: i })));
    const byKey = Object.fromEntries(c.children.map((e) => [e.dataset.key, e]));
    const opsB = Object.fromEntries(c.children.map((e) => [e.dataset.key, e.ops]));
    const r = patchList(c, ["d", "a", "b", "c"].map((id) => ({ id, v: 0 })), (x) => x.id, render);
    expect(r.moved).toBe(1);
    expect(c.children.map((e) => e.dataset.key)).toEqual(["d", "a", "b", "c"]);
    for (const k of ["a", "b", "c"]) expect(c.children.find((e) => e.dataset.key === k)).toBe(byKey[k]);
    for (const k of ["a", "b", "c"]) expect(byKey[k].ops).toBe(opsB[k]); // the three that stayed were not touched
  });

  it("lets render replace an element, and leaves children without a key where they are", () => {
    const c = new FakeEl("ul");
    const head = new FakeEl("li", "heading");
    c.append(head);
    patchList(c, [{ id: "a", v: 1 }], (x) => x.id, render, { before: null });
    expect(texts(c)).toEqual(["heading", "a:1"]);
    const old = c.children[1];
    patchList(c, [{ id: "a", v: 2 }], (x) => x.id, (it) => Object.assign(new FakeEl("li"), { text: `new ${it.id}` }));
    expect(c.children[1]).not.toBe(old);
    expect(c.children[1].dataset.key).toBe("a");
    expect(c.children[0]).toBe(head);
    expect(texts(c)).toEqual(["heading", "new a"]);
  });

  it("copes with an empty list and with numeric keys", () => {
    const c = fill([{ id: 1, v: 1 }, { id: 2, v: 2 }]);
    expect(c.children.map((e) => e.dataset.key)).toEqual(["1", "2"]);
    patchList(c, [], (x) => x.id, render);
    expect(c.children).toEqual([]);
    patchList(c, [{ id: 2, v: 5 }], (x) => x.id, render);
    expect(texts(c)).toEqual(["2:5"]);
  });

  it("setText, setAttr and setClass write only when the value changed", () => {
    const e = new FakeEl();
    e.text = "a";
    expect(setText(e, "a")).toBe(false);
    expect(e.ops).toBe(0);
    expect(setText(e, "b")).toBe(true);
    expect(setAttr(e, "aria-valuenow", 3)).toBe(true);
    expect(setAttr(e, "aria-valuenow", 3)).toBe(false);
    expect(setAttr(e, "aria-valuenow", null)).toBe(true);
    expect(setAttr(e, "aria-valuenow", false)).toBe(false);
    expect(setClass(e, "warn", true)).toBe(true);
    expect(setClass(e, "warn", true)).toBe(false);
    expect(setClass(e, "warn", false)).toBe(true);
  });
});

describe("countTo", () => {
  const el = () => new FakeEl("span");

  it("writes at once without a DOM (Node), formatted with the house number format (no grouping) and the tabular class", () => {
    const e = el();
    countTo(e, 1234567);
    expect(e.text).toBe("1234567");
    expect(e.classList.s.has("mc-count")).toBe(true);
    countTo(e, 1234999);
    expect(e.text).toBe("1234999");
  });

  it("honours decimals, a custom formatter and non-finite values", () => {
    const e = el();
    countTo(e, 12.345, { decimals: 2 });
    expect(e.text).toBe("12.35");
    countTo(e, 7, { format: (n) => `${n}/10` });
    expect(e.text).toBe("7/10");
    countTo(e, Number.NaN);
    expect(e.text).toBe("NaN");
    countTo(e, 3);
    expect(e.text).toBe("3");
  });

  describe("with animation frames", () => {
    let queue;
    let clock;
    const had = {};
    beforeEach(() => {
      queue = [];
      clock = 0;
      _setFrameSource({ raf: (f) => queue.push(f), caf: () => {}, now: () => clock });
      for (const k of ["document", "Element", "matchMedia"]) had[k] = globalThis[k];
      globalThis.Element = class {};
      globalThis.Element.prototype.animate = () => {};
      globalThis.document = {};
      globalThis.matchMedia = () => ({ matches: false });
    });
    afterEach(() => {
      _setFrameSource();
      for (const k of Object.keys(had)) {
        if (had[k] === undefined) delete globalThis[k];
        else globalThis[k] = had[k];
      }
    });
    const run = (n) => {
      for (let i = 0; i < n && queue.length; i++) {
        clock += 1000 / 60;
        queue.shift()(clock);
      }
    };

    it("counts up monotonically to the exact value, then stops the loop", async () => {
      const e = el();
      countTo(e, 100);
      const p = countTo(e, 400, { format: String });
      const shown = [];
      for (let i = 0; i < 90 && queue.length; i++) {
        run(1);
        shown.push(Number(e.text));
      }
      await p;
      expect(shown.some((n) => n > 100 && n < 400)).toBe(true);
      for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]);
      expect(e.text).toBe("400");
      expect(runningSprings()).toBe(0);
    });

    it("retargets from the number on screen instead of restarting, and snaps tiny changes", async () => {
      const e = el();
      countTo(e, 0, { format: String });
      countTo(e, 1000, { format: String });
      run(12);
      const mid = Number(e.text);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1000);
      const p = countTo(e, 500, { format: String });
      run(1);
      expect(Math.abs(Number(e.text) - mid)).toBeLessThan(120); // continues from where it was
      run(200);
      await p;
      expect(e.text).toBe("500");
      // 0.1 % of the number: written at once, no spring
      countTo(e, 501, { format: String });
      expect(e.text).toBe("501");
      expect(runningSprings()).toBe(0);
    });

    it("snaps with reduced motion and with animate: false", () => {
      const e = el();
      countTo(e, 10, { format: String });
      globalThis.matchMedia = (q) => ({ matches: q.includes("reduce") });
      countTo(e, 900, { format: String });
      expect(e.text).toBe("900");
      globalThis.matchMedia = () => ({ matches: false });
      countTo(e, 100, { format: String, animate: false });
      expect(e.text).toBe("100");
      expect(runningSprings()).toBe(0);
    });

    it("a reveal animates from `from`; a poll-sized change does not", () => {
      const e = el();
      countTo(e, 800, { format: String, from: 0 });
      run(6);
      expect(Number(e.text)).toBeGreaterThan(0);
      expect(Number(e.text)).toBeLessThan(800);
    });

    it("Spring.to glides 120 ms with reduced motion instead of springing (no overshoot, no bounce)", async () => {
      globalThis.matchMedia = (q) => ({ matches: q.includes("reduce") });
      const s = new Spring(0, "bouncy");
      const p = s.to(100);
      let peak = 0;
      for (let i = 0; i < 30 && queue.length; i++) {
        run(1);
        peak = Math.max(peak, s.value);
      }
      await p;
      expect(peak).toBeLessThanOrEqual(100);
      expect(s.value).toBe(100);
    });
  });
});

describe("viewTransition", () => {
  it("runs the update and resolves when there is no document (the plain fallback)", async () => {
    let ran = 0;
    await viewTransition(() => ran++);
    expect(ran).toBe(1);
    await expect(viewTransition(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
  });

  it("does not start a view transition with reduced motion, and clears names afterwards", async () => {
    const had = { document: globalThis.document, matchMedia: globalThis.matchMedia };
    let started = 0;
    globalThis.matchMedia = (q) => ({ matches: q.includes("reduce") });
    globalThis.document = { visibilityState: "visible", startViewTransition: () => (started++, { finished: Promise.resolve() }) };
    let ran = 0;
    await viewTransition(() => ran++);
    expect(ran).toBe(1);
    expect(started).toBe(0);

    globalThis.matchMedia = () => ({ matches: false });
    const el = { style: {} };
    let updated = 0;
    globalThis.document.startViewTransition = (fn) => {
      started++;
      expect(el.style.viewTransitionName).toBe("row");
      return { finished: Promise.resolve(fn()).then(() => {}) };
    };
    await viewTransition(() => updated++, { names: [[el, "row"]] });
    expect(started).toBe(1);
    expect(updated).toBe(1);
    expect(el.style.viewTransitionName).toBe("");
    for (const [k, v] of Object.entries(had)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });
});
