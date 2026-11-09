/** The dashboard's link to the Bridge: reconnecting after a restart, recovering by itself, and a revoked key. No DOM, no real timers. */
import { describe, expect, it } from "vitest";
import { BACKOFF_MS, createConnection } from "./connection.js";

/** A connection with a fake clock and a probe the test controls. */
function setup({ answers = [] } = {}) {
  const timers = [];
  const changes = [];
  const probes = [];
  const conn = createConnection({
    probe: async () => {
      probes.push(1);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? false;
    },
    onChange: (state, prev) => changes.push([prev, state]),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
  });
  /** Run the oldest waiting timer and let its probe settle. */
  const tick = async () => {
    const t = timers.shift();
    await t.fn();
    return t.ms;
  };
  return { conn, timers, changes, probes, tick };
}

describe("reconnecting", () => {
  it("does nothing before it is armed (a failed sign-in is not a lost connection)", () => {
    const s = setup();
    s.conn.networkFailed();
    s.conn.unauthorized();
    expect(s.conn.state).toBe("online");
    expect(s.changes).toEqual([]);
    expect(s.timers).toEqual([]);
  });

  it("a failed request puts the page in reconnecting once, however many requests fail", () => {
    const s = setup();
    s.conn.arm();
    s.conn.networkFailed();
    s.conn.networkFailed();
    s.conn.networkFailed();
    expect(s.conn.state).toBe("reconnecting");
    expect(s.changes).toEqual([["online", "reconnecting"]]);
    expect(s.timers).toHaveLength(1);
  });

  it("asks again with a growing pause until the Bridge answers, then recovers by itself", async () => {
    const s = setup({ answers: [false, new Error("refused"), false, true] });
    s.conn.arm();
    s.conn.networkFailed();
    const waits = [];
    while (s.conn.state === "reconnecting") waits.push(await s.tick());
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
    expect(s.conn.state).toBe("online");
    expect(s.changes).toEqual([["online", "reconnecting"], ["reconnecting", "online"]]);
    expect(s.timers).toHaveLength(0);
  });

  it("the pause stops growing at the last step", async () => {
    const s = setup({ answers: Array(10).fill(false) });
    s.conn.arm();
    s.conn.networkFailed();
    const waits = [];
    for (let i = 0; i < 8; i++) waits.push(await s.tick());
    expect(Math.max(...waits)).toBe(BACKOFF_MS.at(-1));
    expect(waits.slice(-2)).toEqual([BACKOFF_MS.at(-1), BACKOFF_MS.at(-1)]);
  });

  it("any answered request also ends it, without waiting for the probe", async () => {
    const s = setup();
    s.conn.arm();
    s.conn.networkFailed();
    s.conn.answered();
    expect(s.conn.state).toBe("online");
    await s.tick(); // the stale timer finds nothing to do
    expect(s.probes).toHaveLength(0);
    expect(s.changes.at(-1)).toEqual(["reconnecting", "online"]);
  });

  it("can drop and recover again later", async () => {
    const s = setup({ answers: [true, true] });
    s.conn.arm();
    for (let i = 0; i < 2; i++) {
      s.conn.networkFailed();
      await s.tick();
      expect(s.conn.state).toBe("online");
    }
    expect(s.changes.filter(([, to]) => to === "reconnecting")).toHaveLength(2);
  });
});

describe("a revoked key", () => {
  it("signs out once, and stops reconnecting", async () => {
    const s = setup();
    s.conn.arm();
    s.conn.networkFailed();
    s.conn.unauthorized();
    s.conn.unauthorized();
    expect(s.conn.state).toBe("signedout");
    expect(s.changes.filter(([, to]) => to === "signedout")).toHaveLength(1);
    s.conn.networkFailed();
    s.conn.answered();
    expect(s.conn.state).toBe("signedout");
  });

  it("a refusal while online signs out at once", () => {
    const s = setup();
    s.conn.arm();
    s.conn.unauthorized();
    expect(s.changes).toEqual([["online", "signedout"]]);
  });
});
