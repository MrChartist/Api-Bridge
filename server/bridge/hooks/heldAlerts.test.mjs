/**
 * Held webhook alerts. Over its per-minute limit an alert is held and handled when a slot frees up (TradingView does not
 * resend). The rule for LIVE hooks: only an alert that can be age-checked is held (the hook has maxAgeSec and every order of
 * the alert carries its time; the worker checks the age again when the hold ends). A live alert without that is refused over
 * the limit (429 with Retry-After), never held, because it would run up to rateWaitSec late as a real order. Paper hooks hold.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestBridge } from "./__fixtures__/testBridge.mjs";

let b;
const json = { "content-type": "application/json" };
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const liveCfg = { hooks: { maxSignalsPerMinute: 1, rateWaitSec: 60 }, safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["webhook"] } }, { id: "paper", broker: "paper" }] };

beforeEach(async () => {
  b = await startTestBridge({ config: liveCfg, liveAccounts: ["dhan-main"] });
});
afterEach(async () => b.close());

const create = async (def) => {
  const r = await b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(b.keys.adminLive), ...json }, body: { source: "gocharting", label: "held", account: "dhan-main", mode: "live", product: "CNC", acknowledgeUnsignedLive: true, ...def } });
  expect(r.status, r.raw).toBe(201);
  return r.json.data;
};
const post = (h, body) => b.request({ method: "POST", path: h.path, headers: json, body });
const alert = (id, o = {}) => ({ symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, id, ...o });
const signalsOf = async (h) => (await b.request({ path: `/v1/hooks/${h.id}/signals`, headers: b.auth(b.keys.admin) })).json.data;

describe("a live hook over its minute limit", () => {
  it("does not hold an alert that carries no time: 429 with Retry-After, nothing queued late", async () => {
    const h = await create({});
    expect((await post(h, alert("a1"))).status).toBe(202);
    const second = await post(h, alert("a2"));
    expect(second.status).toBe(429);
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    const s = await signalsOf(h);
    expect(s.signals.filter((e) => e.code === "HOOK_RATE_HELD")).toHaveLength(0);
  });

  it("does not hold an alert when the hook has no age limit, even if the alert has a time", async () => {
    const h = await create({ maxAgeSec: null });
    expect((await post(h, alert("b1", { time: nowIso() }))).status).toBe(202);
    expect((await post(h, alert("b2", { time: nowIso() }))).status).toBe(429);
  });

  it("holds an alert it can age-check: the hook has maxAgeSec and the alert carries its time", async () => {
    const h = await create({ maxAgeSec: 300 });
    expect((await post(h, alert("c1", { time: nowIso() }))).status).toBe(202);
    const second = await post(h, alert("c2", { time: nowIso() }));
    expect(second.status).toBe(202);
    expect(second.json.heldSeconds).toBeGreaterThan(50);
    expect((await signalsOf(h)).signals.some((e) => e.code === "HOOK_RATE_HELD")).toBe(true);
  });
});

describe("a paper hook over its minute limit", () => {
  it("still holds an alert without a time (a late paper order does no harm)", async () => {
    const h = await create({ mode: "paper", account: "paper", acknowledgeUnsignedLive: undefined });
    expect((await post(h, alert("p1"))).status).toBe(202);
    const second = await post(h, alert("p2"));
    expect(second.status).toBe(202);
    expect(second.json.heldSeconds).toBeGreaterThan(50);
  });
});
