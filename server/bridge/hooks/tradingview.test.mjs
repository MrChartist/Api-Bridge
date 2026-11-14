/**
 * TradingView hooks end to end: a real Bridge app over loopback HTTP with the hooks module and fake services.
 * Covers the receiver's credential, content types, size cap, passphrase, stale and replayed alerts, duplicates,
 * symbol mapping, rejected orders after the 202, the address preset behind a tunnel, live-hook guards, the signals
 * route, the test route and the burst queue. Nothing here touches the network.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { sign } from "../auth/hmac.mjs";
import { startTestBridge } from "./__fixtures__/testBridge.mjs";
import { hooksRuntimeFor } from "./module.mjs";

let b;
const json = { "content-type": "application/json" };
const text = { "content-type": "text/plain" };
const nowIso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const idle = () => hooksRuntimeFor(b.app.deps).worker.idle();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = () => b.auth(b.keys.admin);

async function createHook(def = {}, key = b.keys.admin) {
  const r = await b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(key), ...json }, body: { source: "tradingview", label: "TV", account: "paper", orderType: "MARKET", product: "INTRADAY", maxLotsPerSignal: 5, ...def } });
  expect(r.status, r.raw).toBe(201);
  return r.json.data;
}
/** A hook plus the alert builder that already carries its passphrase. */
async function tvHook(def = {}) {
  const h = await createHook(def);
  const alert = (o = {}) => ({ symbol: "NSE:RELIANCE", side: "buy", lots: 1, orderType: "market", id: "Long", time: nowIso(), passphrase: h.passphrase, ...o });
  const send = (body, headers = json) => b.request({ method: "POST", path: h.path, headers, body });
  return { h, alert, send };
}
const signalsOf = async (h, q = "") => (await b.request({ path: `/v1/hooks/${h.id}/signals${q}`, headers: admin() })).json.data;
const events = (topic) => {
  const got = [];
  b.app.deps.bus.on(topic, (p) => got.push(p));
  return got;
};

describe("creating a TradingView hook", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600 } } });
  });
  afterEach(async () => b.close());

  it("shows the URL and the passphrase once, with ready-to-paste messages that carry it", async () => {
    const h = await createHook();
    expect(h.path).toMatch(/^\/hooks\/tradingview\/[A-Za-z0-9_-]{43}$/);
    expect(h.passphrase).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(h).toMatchObject({ source: "tradingview", maxAgeSec: 120, hasPassphrase: true, mode: "paper", sourceIpPreset: null });
    expect(h.templates.map((t) => t.name)).toEqual(["Plain alert (indicator or Pine alert())", "Strategy alert (every order fill)", "Plain text alert"]);
    for (const t of h.templates) expect(t.message).toContain(h.passphrase);
    expect(h.templates[1].message).toContain("{{strategy.order.action}}");
    expect(h.templates[1].message).toContain('"time": "{{timenow}}"');
    const list = await b.request({ path: "/v1/hooks", headers: admin() });
    expect(list.raw).not.toContain(h.passphrase);
    expect(list.json.data[0]).toMatchObject({ hasPassphrase: true, maxAgeSec: 120 });
    expect(list.json.data[0].templates[0].message).toContain("YOUR_PASSPHRASE");
  });

  it("keeps only a hash of the passphrase: not on disk, not in the audit log, not in the logs", async () => {
    const h = await createHook();
    const file = readFileSync(join(hooksRuntimeFor(b.app.deps).store.file), "utf8");
    expect(file).not.toContain(h.passphrase);
    expect(file).toContain("passphraseHash");
    expect(JSON.stringify(b.audit.records)).not.toContain(h.passphrase);
    expect(b.logLines.join("\n")).not.toContain(h.passphrase);
  });

  it("explains the address list and the tunnel header in warnings and in the presets route", async () => {
    const h = await createHook({ sourceIpPreset: "tradingview" });
    expect(h.warnings.join(" ")).toMatch(/hooks\.clientIpHeader/);
    expect(h.ipPreset).toMatchObject({ name: "tradingview", verifiedAt: "2026-11-09", edited: false });
    expect(h.ipPreset.ips).toEqual(["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"]);
    const p = await b.request({ path: "/v1/hooks/presets", headers: admin() });
    expect(p.status).toBe(200);
    expect(p.json.data).toMatchObject({ clientIpHeader: null, tradingview: { defaultMaxAgeSec: 120 }, limits: { bodyLimitBytes: 16384 } });
    expect(p.json.data.ipPresets[0].source).toMatch(/^https:\/\/www\.tradingview\.com\/support\//);
    expect((await b.request({ path: "/v1/hooks/presets", headers: b.auth(b.keys.read) })).status).toBe(403);
  });

  it("rejects a bad maxAgeSec and an unknown preset", async () => {
    for (const body of [{ maxAgeSec: 1 }, { maxAgeSec: 99999 }, { sourceIpPreset: "nothing" }]) {
      const r = await b.request({ method: "POST", path: "/v1/hooks", headers: { ...admin(), ...json }, body: { source: "tradingview", label: "x", account: "paper", ...body } });
      expect(r.status).toBe(400);
    }
  });
});

describe("the receiver: credential, content types and size", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600 } } });
  });
  afterEach(async () => b.close());

  it("answers 202 with a signal id and places a paper order for a good alert", async () => {
    const { h, alert, send } = await tvHook();
    const r = await send(alert());
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ accepted: true, signalId: expect.stringMatching(/^sig_/) });
    await idle();
    expect(b.orders.all()).toHaveLength(1);
    expect(b.orders.all()[0]).toMatchObject({ symbol: "NSE:RELIANCE", side: "BUY", mode: "paper", source: "webhook" });
    const s = await signalsOf(h);
    expect(s.signals[0]).toMatchObject({ outcome: "placed", symbol: "NSE:RELIANCE", mode: "paper", orderId: expect.any(String), id: "Long" });
    expect(s.signals[0].summary).toMatch(/Placed a paper order/);
  });

  it("answers fast: the 202 does not wait for the order", async () => {
    const { alert, send } = await tvHook();
    let release;
    const gate = new Promise((r) => (release = r));
    const place = b.orders.place;
    b.orders.place = async (...a) => {
      await gate;
      return place.apply(b.orders, a);
    };
    const r = await send(alert());
    expect(r.status).toBe(202);
    expect(b.orders.all()).toHaveLength(0);
    release();
    await idle();
    expect(b.orders.all()).toHaveLength(1);
  });

  it("takes a text/plain alert, with the passphrase in the text", async () => {
    const { h, send } = await tvHook();
    const r = await send(`BUY NSE:RELIANCE 2 MKT MIS id=t1 time=${nowIso()} passphrase=${h.passphrase}`, text);
    expect(r.status).toBe(202);
    await idle();
    expect(b.orders.all()[0]).toMatchObject({ quantity: 2, side: "BUY" });
  });

  it("refuses a wrong, missing or look-alike passphrase with 401 and places nothing", async () => {
    const { h, alert, send } = await tvHook();
    const bad = [alert({ passphrase: "nope" }), alert({ passphrase: "" }), alert({ passphrase: h.passphrase.slice(0, -1) }), alert({ passphrase: `${h.passphrase}x` }), alert({ passphrase: undefined }), alert({ passphrase: 12345 })];
    for (const body of bad) {
      const r = await send(body);
      expect(r.status).toBe(401);
      expect(r.json.code).toBe("UNAUTHENTICATED");
      expect(r.raw).not.toContain(h.passphrase);
    }
    expect((await send("BUY NSE:RELIANCE 1 passphrase=wrong", text)).status).toBe(401);
    await idle();
    expect(b.orders.all()).toHaveLength(0);
    const s = await signalsOf(h);
    expect(s.counts.authFailed).toBe(7);
    expect(s.lastAuthFailureAt).toBeTruthy();
    expect(s.signals).toHaveLength(0);
  });

  it("compares the passphrase in constant time (hashed, equal length, timingSafeEqual) and never throws on odd input", async () => {
    const src = readFileSync(new URL("./hookStore.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/timingSafeEqual\(a, b\)/);
    const { h } = await tvHook();
    const store = hooksRuntimeFor(b.app.deps).store;
    expect(store.checkPassphrase(h.id, h.passphrase)).toBe(true);
    for (const x of ["", "a", h.passphrase.slice(0, 10), `${h.passphrase}${h.passphrase}`, "é".repeat(5000), null, undefined, 7, {}, [h.passphrase]]) expect(store.checkPassphrase(h.id, x)).toBe(false);
    expect(store.checkPassphrase("hk_aaaaaaaaaaaa", h.passphrase)).toBe(false);
    // A hook without a passphrase (any other source) never matches, even the empty string.
    const gc = await createHook({ source: "gocharting" });
    expect(store.checkPassphrase(gc.id, "")).toBe(false);
  });

  it("limits wrong passphrases per address (30 a minute), then answers 429 even for the right one", async () => {
    const { alert, send } = await tvHook();
    let last;
    for (let i = 0; i < 31; i += 1) last = await send(alert({ passphrase: "wrong" }));
    expect(last.status).toBe(429);
    expect((await send(alert())).status).toBe(429);
  });

  it("refuses the wrong content type (415), an oversize body (413) and invalid JSON (400), and counts each", async () => {
    const { h, alert } = await tvHook();
    const form = await b.request({ method: "POST", path: h.path, headers: { "content-type": "application/x-www-form-urlencoded" }, raw: "a=b" });
    expect(form.status).toBe(415);
    const big = await b.request({ method: "POST", path: h.path, headers: json, raw: JSON.stringify(alert({ id: "x".repeat(20000) })) });
    expect(big.status).toBe(413);
    const broken = await b.request({ method: "POST", path: h.path, headers: json, raw: '{"symbol": "NSE:RELIANCE",' });
    expect(broken.status).toBe(400);
    expect(broken.json.code).toBe("INVALID_JSON");
    const empty = await b.request({ method: "POST", path: h.path, headers: json, raw: "" });
    expect(empty.status).toBe(400);
    await idle();
    expect(b.orders.all()).toHaveLength(0);
    const s = await signalsOf(h);
    expect(s.counts.badRequest).toBe(4);
    expect(s.signals.map((x) => x.outcome)).toEqual(["refused", "refused", "refused", "refused"]);
    // A wrong URL token is not counted anywhere.
    const wrong = await b.request({ method: "POST", path: `/hooks/tradingview/${"y".repeat(43)}`, headers: { "content-type": "application/x-www-form-urlencoded" }, raw: "a=b" });
    expect(wrong.status).toBe(415);
    expect((await signalsOf(h)).counts.badRequest).toBe(4);
  });

  it("says what is wrong with an alert in a 400 that is recorded without the body", async () => {
    const { h, alert, send } = await tvHook();
    const r = await send(alert({ quantiy: 3 }));
    expect(r.status).toBe(400);
    expect(r.json.detail).toMatch(/does not know: "quantiy"/);
    const r2 = await send(alert({ side: "{{strategy.order.action}}" }));
    expect(r2.json.detail).toMatch(/placeholder/);
    const r3 = await send(alert({ symbol: "RELIANCE" }));
    expect(r3.json.detail).toMatch(/no exchange/);
    const s = await signalsOf(h);
    expect(s.counts.badRequest).toBe(3);
    expect(s.signals[0]).toMatchObject({ outcome: "refused", code: "VALIDATION_FAILED" });
    expect(JSON.stringify(s)).not.toContain(h.passphrase);
    expect(b.audit.ofType("hook.refused").length).toBeGreaterThan(0);
    expect(JSON.stringify(b.audit.records)).not.toContain(h.passphrase);
  });

  it("is rate limited per hook when holding is switched off (rateWaitSec 0)", async () => {
    await b.close();
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 2, rateWaitSec: 0 } } });
    const { alert, send } = await tvHook();
    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await send(alert({ id: `x${i}` }))).status);
    expect(codes).toEqual([202, 202, 429]);
  });

  it("INT-09: alerts over the per-minute limit are held and handled, not lost: TradingView does not resend a 429", async () => {
    await b.close();
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 2 } } });
    const { h, alert, send } = await tvHook();
    const replies = [];
    for (let i = 0; i < 4; i += 1) replies.push(await send(alert({ id: `x${i}` })));
    expect(replies.map((r) => r.status)).toEqual([202, 202, 202, 202]);
    expect(replies[0].json.heldSeconds).toBeUndefined();
    expect(replies[2].json.heldSeconds).toBeGreaterThan(50); // waits for a slot of the minute window
    const s = await signalsOf(h);
    const held = s.signals.filter((e) => e.code === "HOOK_RATE_HELD");
    expect(held).toHaveLength(2);
    expect(held[0]).toMatchObject({ outcome: "queued" });
    expect(held[0].reason).toMatch(/over its limit of 2 alerts a minute.*held for about \d+ seconds/);
    expect(s.counts.rateLimited).toBeUndefined();
  });

  it("INT-09: a wait longer than rateWaitSec is still refused with 429 and a Retry-After", async () => {
    await b.close();
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 1, rateWaitSec: 5 } } });
    const { alert, send } = await tvHook();
    expect((await send(alert({ id: "a" }))).status).toBe(202);
    const r = await send(alert({ id: "b" }));
    expect(r.status).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(5);
  });

  it("INT-09: malformed, refused and repeated alerts do not use up the minute's budget", async () => {
    await b.close();
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 2, rateWaitSec: 0 } } });
    const { alert, send } = await tvHook();
    for (let i = 0; i < 6; i += 1) expect((await send(alert({ side: "long", id: `bad${i}` }))).status).toBe(400); // unreadable side
    for (let i = 0; i < 3; i += 1) expect((await send(alert({ time: nowIso(-600), id: `old${i}` }))).status).toBe(400); // too old
    expect((await send(alert({ id: "good1" }))).status).toBe(202);
    expect((await send(alert({ id: "good1" }))).json.duplicate).toBe(true); // a repeat is free too
    expect((await send(alert({ id: "good2" }))).status).toBe(202);
    expect((await send(alert({ id: "good3" }))).status).toBe(429); // the third GOOD one is over the limit
  });

  it("never logs the URL token", async () => {
    const { h, alert, send } = await tvHook();
    await send(alert());
    await idle();
    expect(b.logLines.join("\n")).not.toContain(h.path.split("/").at(-1));
  });
});

describe("stale alerts, replays and duplicates", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600 } } });
  });
  afterEach(async () => b.close());

  it("refuses an alert older than maxAgeSec and one from the future, and says why", async () => {
    const { h, alert, send } = await tvHook();
    const rejected = events("hook.rejected");
    const old = await send(alert({ time: nowIso(-300) }));
    expect(old.status).toBe(400);
    expect(old.json.detail).toMatch(/\d+ seconds old.*up to 120 seconds/);
    const future = await send(alert({ time: nowIso(600), id: "f" }));
    expect(future.status).toBe(400);
    expect(future.json.detail).toMatch(/ahead of this computer's clock/);
    expect((await send(alert({ time: nowIso(-60), id: "ok" }))).status).toBe(202);
    await idle();
    expect(b.orders.all()).toHaveLength(1);
    const s = await signalsOf(h);
    // INT-11: only the old alert is "stale"; one from the future is a clock problem, not "too old"
    expect(s.counts.stale).toBe(1);
    expect(s.signals.filter((x) => x.outcome === "stale")).toHaveLength(1);
    const futureEntry = s.signals.find((x) => x.cause === "future");
    expect(futureEntry).toMatchObject({ outcome: "refused" });
    expect(futureEntry.summary).toMatch(/^Its time is ahead of this computer's clock/);
    expect(futureEntry.summary).not.toMatch(/Too old|could not be read/);
    expect(s.signals.find((x) => x.outcome === "stale").summary).toMatch(/^Too old/);
    expect(rejected[0]).toMatchObject({ hookId: h.id, stage: "receive", outcome: "stale", source: "tradingview" });
    expect(rejected[1]).toMatchObject({ outcome: "refused" });
    expect(JSON.stringify(rejected)).not.toContain(h.passphrase);
  });

  it("INT-11: a refusal by the hook's rules says so, and a placed alert says how much and at what price", async () => {
    const { h, alert, send } = await tvHook();
    const policy = await send(alert({ mode: "live", id: "p1" }));
    expect(policy.status).toBe(400);
    const ok = await send(alert({ lots: 2, price: 2900, id: "ok1" }));
    expect(ok.status).toBe(202);
    await idle();
    const s = await signalsOf(h);
    const refused = s.signals.find((x) => x.outcome === "refused");
    expect(refused).toMatchObject({ cause: "policy" });
    expect(refused.summary).toMatch(/^Against this hook's rules, so nothing was placed\. This hook places paper orders only/);
    expect(refused.summary).not.toMatch(/could not be read/);
    const placed = s.signals.find((x) => x.outcome === "placed");
    expect(placed.summary).toMatch(/^Placed a paper order: buy 2 lots NSE:RELIANCE at 2900\.$/i);
    expect(placed).toMatchObject({ lots: 2, price: 2900 });
  });

  it("honours a hook's own maxAgeSec", async () => {
    const { alert, send } = await tvHook({ maxAgeSec: 5 });
    expect((await send(alert({ time: nowIso(-10) }))).status).toBe(400);
    expect((await send(alert({ time: nowIso(-1), id: "n" }))).status).toBe(202);
  });

  it("an alert without a time cannot be aged: accepted on a paper hook, with no stable identity", async () => {
    const { alert, send } = await tvHook();
    expect((await send(alert({ time: undefined }))).status).toBe(202);
  });

  it("a replay of the same alert is a duplicate: one order, 202 duplicate:true, and it is listed", async () => {
    const { h, alert, send } = await tvHook();
    const a = alert();
    const first = await send(a);
    const second = await send(a);
    const third = await send({ ...a, price: 99 });
    expect([first.status, second.status, third.status]).toEqual([202, 202, 202]);
    expect(second.json).toMatchObject({ duplicate: true, signalId: first.json.signalId });
    expect(third.json.duplicate).toBe(true);
    await idle();
    expect(b.orders.all()).toHaveLength(1);
    const s = await signalsOf(h);
    expect(s.counts).toMatchObject({ accepted: 1, duplicate: 2 });
    expect(s.signals.map((x) => x.outcome).sort()).toEqual(["duplicate", "duplicate", "placed"]);
  });

  it("the same id on a LATER time is a new alert (TradingView's default order id 'Long' repeats every day)", async () => {
    const { alert, send } = await tvHook();
    expect((await send(alert({ id: "Long", time: nowIso(-30) }))).json.duplicate).toBeUndefined();
    expect((await send(alert({ id: "Long", time: nowIso(-5) }))).json.duplicate).toBeUndefined();
    await idle();
    expect(b.orders.all()).toHaveLength(2);
  });

  it("two tickers firing at the same second with the same id are two alerts", async () => {
    const { alert, send } = await tvHook();
    const t = nowIso(-2);
    await send(alert({ id: "Long", time: t, symbol: "NSE:RELIANCE" }));
    await send(alert({ id: "Long", time: t, symbol: "NSE:INFY" }));
    await idle();
    expect(b.orders.all().map((o) => o.symbol).sort()).toEqual(["NSE:INFY", "NSE:RELIANCE"]);
  });

  it("remembers alerts across a restart (a small file in the data folder), so a replay after a restart is still a duplicate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-tv-seen-"));
    try {
      await b.close();
      b = await startTestBridge({ config: { dataDir: dir, hooks: { maxSignalsPerMinute: 600 } } });
      const { h, alert, send } = await tvHook();
      const a = alert();
      expect((await send(a)).json.duplicate).toBeUndefined();
      await idle();
      await b.app.close();
      expect(readdirSync(dir)).toContain("hooks-seen.json");
      const seenFile = readFileSync(join(dir, "hooks-seen.json"), "utf8");
      expect(seenFile).not.toContain(h.passphrase);
      expect(seenFile).not.toContain("RELIANCE");
      b = await startTestBridge({ config: { dataDir: dir, hooks: { maxSignalsPerMinute: 600 } } });
      const again = await b.request({ method: "POST", path: h.path, headers: json, body: a });
      expect(again.status).toBe(202);
      expect(again.json.duplicate).toBe(true);
      await idle();
      expect(b.orders.all()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the dedupe file is bounded and a damaged one does not stop the hooks", async () => {
    const { createDedupeMap } = await import("./dedupe.mjs");
    const dir = mkdtempSync(join(tmpdir(), "mcb-seen-"));
    try {
      let t = 1000;
      const file = join(dir, "seen.json");
      const m = createDedupeMap({ max: 3, now: () => t, file });
      for (const k of ["a", "b", "c"]) m.set(k, `sig_${k}`, 5000);
      expect(m.full()).toBe(true);
      m.flush();
      const again = createDedupeMap({ max: 3, now: () => t, file });
      expect(again.get("b")).toMatchObject({ signalId: "sig_b" });
      t += 6000;
      expect(again.get("b")).toBeNull();
      expect(createDedupeMap({ max: 3, now: () => t, file }).size()).toBe(0);
      const bad = join(dir, "bad.json");
      await import("node:fs").then((fs) => fs.writeFileSync(bad, "{not json"));
      expect(createDedupeMap({ max: 3, now: () => t, file: bad }).size()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses new alerts (never forgets old ones) when the seen-map is full", async () => {
    const rt = hooksRuntimeFor(b.app.deps);
    const { alert, send } = await tvHook();
    const real = rt.handlers._dedupe;
    real.full = () => true;
    const r = await send(alert());
    expect(r.status).toBe(429);
    expect(r.json.detail).toMatch(/nothing was placed/);
  });

  it("a generic hook no longer swallows a later alert that reuses an id (id + time are the identity)", async () => {
    const h = await createHook({ source: "generic", product: "CNC", orderType: "LIMIT" });
    const post = (body) => {
      const raw = JSON.stringify(body);
      return b.request({ method: "POST", path: h.path, headers: { ...json, "x-mcb-signature": sign(h.signingSecret, Math.floor(Date.now() / 1000), raw) }, raw });
    };
    const base = { symbol: "NSE:INFY", side: "BUY", quantity: 1, price: 1500, id: "Long" };
    expect((await post({ ...base, time: "2026-11-09T04:00:00Z" })).json.duplicate).toBeUndefined();
    expect((await post({ ...base, time: "2026-11-10T04:00:00Z" })).json.duplicate).toBeUndefined();
    await idle();
    expect(b.orders.all()).toHaveLength(2);
  });
});

describe("a derived clientOrderId makes a retry the same order", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600 } } });
  });
  afterEach(async () => b.close());

  it("is stable for one alert identity and different for another", async () => {
    const { h, alert, send } = await tvHook();
    const t = nowIso(-3);
    await send(alert({ time: t }));
    await send(alert({ time: nowIso(-2), id: "other" }));
    await idle();
    const placed = b.orders.calls.filter((c) => c[0] === "place");
    const ids = placed.map((c) => c[1].clientOrderId);
    expect(ids[0]).toMatch(new RegExp(`^mcb-${h.id.slice(3)}-[0-9a-f]{28}$`));
    expect(new Set(ids).size).toBe(2);
    // Same hook, same identity, later in a fresh bridge process: the same id (derived, not random).
    const rt = hooksRuntimeFor(b.app.deps);
    rt.handlers._dedupe.get = () => null; // pretend the dedupe memory was lost
    await send(alert({ time: t }));
    await idle();
    const again = b.orders.calls.filter((c) => c[0] === "place").at(-1);
    expect(again[1].clientOrderId).toBe(ids[0]);
    expect(again[2].idempotencyKey).toBe(placed[0][2].idempotencyKey);
    // The order service refused the second one as a replay: still one order for that identity.
    expect(b.orders.all()).toHaveLength(2);
  });

  it("is only added for TradingView hooks (other sources keep their order body)", async () => {
    const gc = await createHook({ source: "gocharting" });
    await b.request({ method: "POST", path: gc.path, headers: text, raw: "BUY NSE:RELIANCE 1 MKT" });
    await idle();
    expect(b.orders.calls.find((c) => c[0] === "place")[1].clientOrderId).toBeUndefined();
  });
});

describe("symbols and products", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600 } } });
  });
  afterEach(async () => b.close());

  it("maps chart tickers: NSE:M_M, NSE:BAJAJ_AUTO and the continuous future NSE:NIFTY1!", async () => {
    const { alert, send } = await tvHook({ maxLotsPerSignal: 5 });
    await send(alert({ symbol: "NSE:M_M", id: "a" }));
    await send(alert({ symbol: "NSE:BAJAJ_AUTO", id: "b" }));
    await send(alert({ symbol: "NSE:NIFTY1!", id: "c", lots: 2 }));
    await idle();
    expect(b.orders.all().map((o) => o.symbol).sort()).toEqual(["NFO:NIFTY-2026-10-27-FUT", "NSE:BAJAJ-AUTO", "NSE:M&M"]);
    expect(b.symbols.calls.filter((c) => c[0] === "resolve").every((c) => c[2]?.from === "chart")).toBe(true);
  });

  it("a dated canonical contract keeps its own form", async () => {
    const { alert, send } = await tvHook({ orderType: "LIMIT", maxLotsPerSignal: 2 });
    await send(alert({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", orderType: "limit", price: 120.5 }));
    await idle();
    expect(b.orders.all()[0].symbol).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(b.symbols.calls.find((c) => c[0] === "resolve" && c[1].includes("25000"))[2]).toEqual({});
  });

  it("an unknown symbol is rejected after the 202, listed with the reason and announced", async () => {
    const { h, alert, send } = await tvHook();
    const rejected = events("hook.rejected");
    const r = await send(alert({ symbol: "NSE:NOSUCHSTOCK" }));
    expect(r.status).toBe(202);
    await idle();
    expect(b.orders.all()).toHaveLength(0);
    const s = await signalsOf(h);
    expect(s.signals[0]).toMatchObject({ outcome: "rejected", code: "SYMBOL_NOT_FOUND" });
    expect(s.signals[0].reason).toMatch(/NOSUCHSTOCK/);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ hookId: h.id, stage: "order", outcome: "rejected", code: "SYMBOL_NOT_FOUND", accountId: "paper", mode: "paper", symbol: "NSE:NOSUCHSTOCK" });
    expect(b.audit.ofType("hook.signal").at(-1).data).toMatchObject({ status: "rejected", code: "SYMBOL_NOT_FOUND" });
  });

  it("an ambiguous symbol is refused, never guessed (bare ticker: 400; resolver with several candidates: rejected)", async () => {
    const { h, alert, send } = await tvHook();
    expect((await send(alert({ symbol: "RELIANCE" }))).status).toBe(400);
    // A resolver that can explain itself (feature-tested: it is only used when it exists).
    b.symbols.explain = async () => ({ canonical: null, candidates: [{ canonical: "NSE:RELIANCE" }, { canonical: "BSE:RELIANCE" }] });
    expect((await send(alert({ symbol: "NSE:RELIANCE", id: "amb" }))).status).toBe(202);
    await idle();
    expect(b.orders.all()).toHaveLength(0);
    const s = await signalsOf(h);
    expect(s.signals[0]).toMatchObject({ outcome: "rejected", code: "SYMBOL_AMBIGUOUS" });
    expect(s.signals[0].reason).toMatch(/Nothing was guessed/);
  });

  it("a rejected order after the 202 (lots cap) is listed, audited and announced, and the 202 was already sent", async () => {
    const { h, alert, send } = await tvHook({ maxLotsPerSignal: 1 });
    const rejected = events("hook.rejected");
    expect((await send(alert({ lots: 3 }))).status).toBe(202);
    await idle();
    const s = await signalsOf(h);
    expect(s.signals[0]).toMatchObject({ outcome: "rejected", code: "LOTS_CAP_EXCEEDED" });
    expect(s.counts.rejected).toBe(1);
    expect(rejected[0]).toMatchObject({ code: "LOTS_CAP_EXCEEDED", stage: "order" });
  });

  it("product aliases and a conflicting product", async () => {
    const free = await createHook({ product: undefined, label: "free" });
    const post = (body) => b.request({ method: "POST", path: free.path, headers: json, body: { symbol: "NSE:RELIANCE", side: "buy", lots: 1, orderType: "market", passphrase: free.passphrase, time: nowIso(), ...body } });
    await post({ product: "MIS", id: "1" });
    await post({ product: "NRML", id: "2" });
    await post({ product: "CNC", id: "3" });
    await idle();
    expect(b.orders.all().map((o) => o.product).sort()).toEqual(["CNC", "INTRADAY", "MARGIN"]);
    const fixed = await tvHook({ product: "CNC" });
    await fixed.send(fixed.alert({ product: "MIS" }));
    await idle();
    expect((await signalsOf(fixed.h)).signals[0]).toMatchObject({ outcome: "rejected", code: "PRODUCT_NOT_ALLOWED" });
  });

  it("a hook's account and mode rules: another account or mode live on a paper hook is refused", async () => {
    const { h, alert, send } = await tvHook();
    expect((await send(alert({ account: "dhan-main" }))).json.detail).toMatch(/belongs to paper/);
    expect((await send(alert({ mode: "live" }))).json.detail).toMatch(/paper orders only/);
    expect((await send(alert({ mode: "paper", account: "paper", id: "fine" }))).status).toBe(202);
    await idle();
    expect(b.orders.all()).toHaveLength(1);
    expect((await signalsOf(h)).counts.badRequest).toBe(2);
  });
});

describe("source addresses and the tunnel header", () => {
  afterEach(async () => b.close());

  it("the TradingView address preset refuses a direct local request, and counts it", async () => {
    b = await startTestBridge();
    const { h, alert, send } = await tvHook({ sourceIpPreset: "tradingview" });
    const r = await send(alert());
    expect(r.status).toBe(401);
    expect(r.json.detail).toMatch(/does not accept alerts from this address/);
    expect((await signalsOf(h)).counts.addressRefused).toBe(1);
    expect(b.orders.all()).toHaveLength(0);
  });

  it("behind a local tunnel, hooks.clientIpHeader decides: TradingView's address passes, another does not", async () => {
    b = await startTestBridge({ config: { hooks: { clientIpHeader: "cf-connecting-ip", maxSignalsPerMinute: 600 } } });
    const { h, alert, send } = await tvHook({ sourceIpPreset: "tradingview" });
    expect(h.warnings.join(" ")).not.toMatch(/refuses every alert/);
    expect((await send(alert({ id: "1" }), { ...json, "cf-connecting-ip": "52.89.214.238" })).status).toBe(202);
    expect((await send(alert({ id: "2" }), { ...json, "cf-connecting-ip": "34.212.75.30" })).status).toBe(202);
    expect((await send(alert({ id: "3" }), { ...json, "cf-connecting-ip": "203.0.113.9" })).status).toBe(401);
    // A spoofed header means nothing when no trusted header is configured (see the next test); here it is configured.
    expect((await signalsOf(h)).counts.addressRefused).toBe(1);
  });

  it("without hooks.clientIpHeader a forwarded header is ignored", async () => {
    b = await startTestBridge();
    const { alert, send } = await tvHook({ sourceIpPreset: "tradingview" });
    expect((await send(alert(), { ...json, "x-forwarded-for": "52.89.214.238", "cf-connecting-ip": "52.89.214.238" })).status).toBe(401);
  });

  it("the preset list is editable in the config, with its own date", async () => {
    b = await startTestBridge({ config: { hooks: { presets: { tradingview: { ips: ["198.51.100.7"], verifiedAt: "2027-01-02", source: "https://example.invalid/list" } } } } });
    const p = await b.request({ path: "/v1/hooks/presets", headers: admin() });
    expect(p.json.data.ipPresets[0]).toEqual({ name: "tradingview", ips: ["198.51.100.7"], verifiedAt: "2027-01-02", source: "https://example.invalid/list", edited: true });
    const { alert, send } = await tvHook({ sourceIpPreset: "tradingview" });
    expect((await send(alert())).status).toBe(401);
  });

  it("a hook's own allowSourceIps and the preset add up", async () => {
    b = await startTestBridge();
    const { alert, send } = await tvHook({ sourceIpPreset: "tradingview", allowSourceIps: ["127.0.0.1"] });
    expect((await send(alert())).status).toBe(202);
  });
});

describe("live TradingView hooks keep every guard", () => {
  const liveCfg = { hooks: { maxSignalsPerMinute: 600 }, safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["webhook"] } }, { id: "paper", broker: "paper" }] };
  beforeEach(async () => {
    b = await startTestBridge({ config: liveCfg, liveAccounts: ["dhan-main"] });
  });
  afterEach(async () => b.close());
  const post = (key, def) => b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(key), ...json }, body: { source: "tradingview", label: "TVL", account: "dhan-main", mode: "live", product: "INTRADAY", orderType: "MARKET", ...def } });

  it("needs the live scope, an address list, confirmation or an explicit acknowledgement, and maxAgeSec", async () => {
    expect((await post(b.keys.admin, { sourceIpPreset: "tradingview" })).json.code).toBe("SCOPE_REQUIRED");
    const bare = await post(b.keys.adminLive, {});
    expect(bare.status).toBe(400);
    expect(bare.json.detail).toMatch(/sourceIpPreset/);
    expect((await post(b.keys.adminLive, { sourceIpPreset: "tradingview" })).status).toBe(201);
    expect((await post(b.keys.adminLive, { requireConfirmation: true })).status).toBe(201);
    expect((await post(b.keys.adminLive, { acknowledgeUnsignedLive: true })).status).toBe(201);
    const noAge = await post(b.keys.adminLive, { requireConfirmation: true, maxAgeSec: null });
    expect(noAge.status).toBe(400);
    expect(noAge.json.detail).toMatch(/needs maxAgeSec/);
  });

  it("every alert must say mode live and carry its time; paper wording is refused; the passphrase is still required", async () => {
    const r = await post(b.keys.adminLive, { acknowledgeUnsignedLive: true });
    const h = r.json.data;
    const send = (body) => b.request({ method: "POST", path: h.path, headers: json, body });
    const alert = (o = {}) => ({ symbol: "NSE:RELIANCE", side: "buy", lots: 1, orderType: "market", id: "L", time: nowIso(), mode: "live", passphrase: h.passphrase, ...o });
    expect((await send(alert({ mode: undefined }))).json.detail).toMatch(/must say "mode": "live"/);
    expect((await send(alert({ mode: "paper" }))).json.detail).toMatch(/LIVE orders/);
    expect((await send(alert({ time: undefined }))).json.detail).toMatch(/must carry its time/);
    expect((await send(alert({ time: nowIso(-500) }))).json.detail).toMatch(/seconds old/);
    expect((await send(alert({ passphrase: "guess" }))).status).toBe(401);
    expect((await send({ ...alert(), passphrase: undefined })).status).toBe(401);
    await idle();
    expect(b.orders.all()).toHaveLength(0);
    expect(b.orders.calls.filter((c) => c[0] === "place")).toHaveLength(0);
    expect(h.templates[0].message).toContain('"mode": "live"');
  });

  it("a live hook with requireConfirmation only opens a ticket: nothing is placed without a person", async () => {
    const r = await post(b.keys.adminLive, { requireConfirmation: true });
    const h = r.json.data;
    const res = await b.request({ method: "POST", path: h.path, headers: json, body: { symbol: "NSE:RELIANCE", side: "buy", lots: 1, orderType: "market", id: "L", time: nowIso(), mode: "live", passphrase: h.passphrase } });
    expect(res.status).toBe(202);
    await idle();
    expect(b.orders.all()).toHaveLength(0);
    const tickets = await b.orders.tickets({ principal: { kind: "local", id: "cli" }, scopes: new Set(["admin"]) });
    expect(tickets).toHaveLength(1);
    expect((await signalsOf(h)).signals[0]).toMatchObject({ outcome: "awaiting_confirmation", mode: "live" });
  });

  it("stops accepting alerts once the key that created the hook is revoked", async () => {
    const h = (await post(b.keys.adminLive, { acknowledgeUnsignedLive: true })).json.data;
    await b.app.deps.keyStore.revoke(h.createdByKeyId);
    const res = await b.request({ method: "POST", path: h.path, headers: json, body: { symbol: "NSE:RELIANCE", side: "buy", lots: 1, id: "L", time: nowIso(), mode: "live", passphrase: h.passphrase } });
    expect(res.status).toBe(401);
    expect((await signalsOf(h)).counts.keyRevoked).toBe(1);
  });

  it("a live hook's test alert is a paper order, never live, and needs no confirmation", async () => {
    const h = (await post(b.keys.adminLive, { requireConfirmation: true })).json.data;
    const t = await b.request({ method: "POST", path: `/v1/hooks/${h.id}/test`, headers: { ...b.auth(b.keys.adminLive), ...json }, body: {} });
    expect(t.status).toBe(200);
    expect(t.json.data).toMatchObject({ test: true, mode: "paper", outcome: "placed" });
    expect(b.orders.all()).toHaveLength(1);
    expect(b.orders.all()[0].mode).toBe("paper");
    expect(await b.orders.tickets({ principal: { kind: "local", id: "cli" }, scopes: new Set(["admin"]) })).toHaveLength(0);
  });
});

describe("GET /v1/hooks/{id}/signals", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600, signalsKept: 10 } } });
  });
  afterEach(async () => b.close());

  it("needs an admin key on this computer, hides other accounts' hooks and validates its query", async () => {
    const { h } = await tvHook();
    expect((await b.request({ path: `/v1/hooks/${h.id}/signals` })).status).toBe(401);
    expect((await b.request({ path: `/v1/hooks/${h.id}/signals`, headers: b.auth(b.keys.read) })).status).toBe(403);
    expect((await b.request({ path: `/v1/hooks/hk_aaaaaaaaaaaa/signals`, headers: admin() })).status).toBe(404);
    expect((await b.request({ path: `/v1/hooks/nope/signals`, headers: admin() })).status).toBe(404);
    expect((await b.request({ path: `/v1/hooks/${h.id}/signals?outcome=weird`, headers: admin() })).status).toBe(400);
    const { key: limited } = b.app.deps.keyStore.addKey({ label: "dhan admin", scopes: ["admin"], accounts: ["dhan-main"] });
    expect((await b.request({ path: `/v1/hooks/${h.id}/signals`, headers: b.auth(limited) })).status).toBe(404);
    expect((await b.request({ method: "POST", path: `/v1/hooks/${h.id}/test`, headers: { ...b.auth(limited), ...json }, body: {} })).status).toBe(404);
  });

  it("lists newest first, bounded to signalsKept, filters by outcome and never holds a body or secret", async () => {
    const { h, alert, send } = await tvHook();
    for (let i = 0; i < 12; i += 1) await send(alert({ id: `n${i}`, time: nowIso(-i - 1) }));
    await send(alert({ symbol: "NSE:NOSUCH", id: "bad" }));
    await idle();
    const s = await signalsOf(h, "?limit=200");
    expect(s.signals).toHaveLength(10);
    expect(s.signals[0].symbol).toBe("NSE:NOSUCH");
    expect(s.counts.accepted).toBe(13);
    expect(s.queue).toMatchObject({ queued: 0, capacity: 200 });
    expect((await signalsOf(h, "?outcome=rejected")).signals).toHaveLength(1);
    expect((await signalsOf(h, "?limit=2")).signals).toHaveLength(2);
    const raw = JSON.stringify(s);
    expect(raw).not.toContain(h.passphrase);
    expect(raw).not.toContain(h.path.split("/").at(-1));
    expect(s.signals[0]).toHaveProperty("receivedAt");
    expect(s.signals[0].receivedAt).toMatch(/\+05:30$/);
  });

  it("deleting a hook forgets its list", async () => {
    const { h, alert, send } = await tvHook();
    await send(alert());
    await b.request({ method: "DELETE", path: `/v1/hooks/${h.id}`, headers: admin() });
    expect((await b.request({ path: `/v1/hooks/${h.id}/signals`, headers: admin() })).status).toBe(404);
    expect(hooksRuntimeFor(b.app.deps).signals.list(h.id).signals).toHaveLength(0);
  });
});

describe("POST /v1/hooks/{id}/test", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600 } } });
  });
  afterEach(async () => b.close());
  const test = (h, body = {}, key = b.keys.admin) => b.request({ method: "POST", path: `/v1/hooks/${h.id}/test`, headers: { ...b.auth(key), ...json }, body });

  it("runs the real pipeline in paper mode and returns the outcome in plain words", async () => {
    const { h } = await tvHook();
    const t = await test(h);
    expect(t.status).toBe(200);
    expect(t.json.data).toMatchObject({ test: true, mode: "paper", accepted: true, outcome: "placed", orderId: expect.any(String) });
    expect(t.json.data.summary).toMatch(/Placed a paper order/);
    expect(t.json.data.note).toMatch(/does not prove that TradingView can reach this hook/);
    expect(JSON.stringify(t.json.data.message)).not.toContain(h.passphrase);
    expect(b.orders.all()).toHaveLength(1);
    expect(b.audit.ofType("hook.test")).toHaveLength(1);
    // Two tests in a row are two orders (a test is never a duplicate) and do not count as a real alert.
    expect((await test(h)).json.data.outcome).toBe("placed");
    expect(b.orders.all()).toHaveLength(2);
    const list = await b.request({ path: "/v1/hooks", headers: admin() });
    expect(list.json.data[0].lastSignalAt).toBeNull();
    expect((await signalsOf(h)).signals.every((x) => x.test === true)).toBe(true);
  });

  it("builds a LIMIT test from the current price, and says what to send when there is none", async () => {
    const { h } = await tvHook({ orderType: "LIMIT" });
    const t = await test(h);
    expect(t.json.data.outcome).toBe("placed");
    expect(b.orders.all()[0].price).toBe(1402.5);
    expect((await test(h, { symbol: "NSE:INFY" })).json.data.outcome).toBe("placed");
    const ex = await test(h, { symbol: "NSE:NOSUCH" });
    expect(ex.status).toBe(400);
    expect(ex.json.detail).toMatch(/Send "price"/);
    expect((await test(h, { symbol: "NSE:NOSUCH", price: 10 })).json.data).toMatchObject({ accepted: true, outcome: "rejected", code: "SYMBOL_NOT_FOUND" });
  });

  it("runs a pasted alert and reports why it would be refused: an unfilled template, a stale time, an unknown symbol", async () => {
    const { h } = await tvHook();
    const tpl = h.templates[0].message;
    const unfilled = await test(h, { alert: tpl });
    expect(unfilled.json.data).toMatchObject({ accepted: false, outcome: "refused" });
    expect(unfilled.json.data.reason).toMatch(/placeholder/);
    expect(unfilled.json.data.message.passphrase).toBeUndefined();
    const stale = await test(h, { alert: { symbol: "NSE:RELIANCE", side: "buy", lots: 1, orderType: "market", id: "x", time: nowIso(-900) } });
    expect(stale.json.data).toMatchObject({ accepted: false, outcome: "stale" });
    const textAlert = await test(h, { alert: `SELL NSE:RELIANCE 1 MKT MIS id=p1 time=${nowIso()} passphrase=${h.passphrase}` });
    expect(textAlert.json.data.outcome).toBe("placed");
    expect(JSON.stringify(textAlert.json.data.message)).not.toContain(h.passphrase);
    expect((await test(h, { alert: "" })).status).toBe(400);
    expect((await test(h, { colour: "red" })).status).toBe(400);
    expect(b.orders.all()).toHaveLength(1);
  });

  it("works for the other sources too (text and ChartInk shapes)", async () => {
    const gc = await createHook({ source: "gocharting", orderType: "LIMIT" });
    expect((await test(gc)).json.data.outcome).toBe("placed");
    const ci = await createHook({ source: "chartink", side: "BUY", orderType: "LIMIT" });
    expect((await test(ci)).json.data.outcome).toBe("placed");
  });

  it("is rate limited with the hook", async () => {
    await b.close();
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 1 } } });
    const { h } = await tvHook();
    expect((await test(h)).status).toBe(200);
    expect((await test(h)).status).toBe(429);
  });
});

describe("bursts: queued, not dropped, with a clear refusal when the queue is full", () => {
  afterEach(async () => b.close());

  it("an alert that meets the order-rate cap waits and is placed on the next try", async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600, burstWaitSec: 10 } } });
    const { h, alert, send } = await tvHook();
    b.orders.failNext(new BridgeError("ORDER_RATE_LIMITED", "cap"));
    expect((await send(alert())).status).toBe(202);
    await sleep(60);
    const mid = await signalsOf(h);
    expect(mid.signals[0]).toMatchObject({ outcome: "queued", code: "ORDER_RATE_LIMITED" });
    expect(mid.signals[0].reason).toMatch(/Waiting for a free order slot/);
    expect(mid.queue.waitingForSlot).toBe(1);
    await idle();
    expect(b.orders.all()).toHaveLength(1);
    expect((await signalsOf(h)).signals[0]).toMatchObject({ outcome: "placed", code: null });
  });

  it("with burstWaitSec 0 the old behaviour stays: rejected, and announced", async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600, burstWaitSec: 0 } } });
    const { h, alert, send } = await tvHook();
    const rejected = events("hook.rejected");
    b.orders.failNext(new BridgeError("ORDER_RATE_LIMITED", "cap"));
    await send(alert());
    await idle();
    expect((await signalsOf(h)).signals[0]).toMatchObject({ outcome: "rejected", code: "ORDER_RATE_LIMITED" });
    expect(rejected).toHaveLength(1);
  });

  it("gives up after the wait and then reports the rejection", async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600, burstWaitSec: 1 } } });
    const { h, alert, send } = await tvHook();
    const place = b.orders.place;
    b.orders.place = async () => {
      throw new BridgeError("ORDER_RATE_LIMITED", "cap");
    };
    await send(alert());
    await idle();
    expect((await signalsOf(h)).signals[0]).toMatchObject({ outcome: "rejected", code: "ORDER_RATE_LIMITED" });
    b.orders.place = place;
  });

  it("a retried alert is refused if it became stale while it waited", async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600, burstWaitSec: 10 } } });
    const { h, alert, send } = await tvHook({ maxAgeSec: 6 });
    b.orders.place = async () => {
      throw new BridgeError("ORDER_RATE_LIMITED", "cap");
    };
    expect((await send(alert({ time: nowIso(-4) }))).status).toBe(202);
    await idle();
    const s = await signalsOf(h);
    expect(s.signals[0]).toMatchObject({ outcome: "stale", code: "ALERT_STALE" });
    expect(b.orders.all()).toHaveLength(0);
  });

  it("a full queue refuses the alert with a clear 429, records it and announces it", async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600, queueSize: 2, concurrency: 1 } } });
    const { h, alert, send } = await tvHook();
    const rejected = events("hook.rejected");
    let release;
    const gate = new Promise((r) => (release = r));
    const place = b.orders.place;
    b.orders.place = async (...a) => {
      await gate;
      return place.apply(b.orders, a);
    };
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await send(alert({ id: `q${i}`, time: nowIso(-i - 1) }))).status);
    const refused = codes.filter((c) => c === 429).length;
    expect(refused).toBeGreaterThanOrEqual(2);
    const full = await send(alert({ id: "last", time: nowIso(-9) }));
    expect(full.status).toBe(429);
    expect(full.json.detail).toMatch(/queue is full \(2 alerts are waiting.*nothing was placed/);
    const s = await signalsOf(h);
    expect(s.counts.queueFull).toBeGreaterThanOrEqual(3);
    expect(s.signals[0]).toMatchObject({ outcome: "rejected" });
    expect(rejected.some((e) => e.stage === "receive" && e.outcome === "rejected")).toBe(true);
    release();
    await idle();
  });
});

describe("existing sources are unchanged", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600 } } });
  });
  afterEach(async () => b.close());

  it("a GoCharting hook now has a signals list too, and a stale alert is refused when the hook has maxAgeSec", async () => {
    const gc = await createHook({ source: "gocharting", maxAgeSec: 30 });
    const send = (raw) => b.request({ method: "POST", path: gc.path, headers: text, raw });
    expect((await send(`BUY NSE:RELIANCE 1 MKT id=a time=${nowIso(-120)}`)).status).toBe(400);
    expect((await send(`BUY NSE:RELIANCE 1 MKT id=b time=${nowIso(-1)}`)).status).toBe(202);
    await idle();
    const s = await signalsOf(gc);
    expect(s.counts).toMatchObject({ stale: 1, accepted: 1, placed: 1 });
  });

  it("the OPTIONS of a hook without maxAgeSec stay null and a TradingView passphrase is never in other hooks", async () => {
    const gc = await createHook({ source: "gocharting" });
    expect(gc).toMatchObject({ maxAgeSec: null, hasPassphrase: false });
    expect(gc.passphrase).toBeUndefined();
  });
});
