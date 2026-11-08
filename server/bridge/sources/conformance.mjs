/**
 * Provider conformance harness: one function a source author (built-in or plugin) runs against a provider to prove it
 * follows the contract in ./contract.mjs. It needs no test framework and never touches the network: the provider is
 * built with a scripted fetch and a fake clock from this file, and the harness drives them.
 *
 *   const clock = createFakeClock();
 *   const upstream = createScriptedFetch({ clock, scenarios: { ok: () => ({ json: {...} }), "rate-limited": () => ({ status: 429, headers: { "retry-after": "30" } }), ... } });
 *   const provider = createMyProvider({ fetch: upstream, clock });
 *   const report = await runProviderConformance(provider, { clock, upstream, inputs: {...}, secrets: ["my-test-key"] });
 *   expect(report.failures).toEqual([]);
 *
 * What is checked (each check has a name in `report.checks`):
 *   descriptor            valid descriptor, declared hosts, plain terms note, free sources never claim real-time
 *   capabilities          a method exists for every declared capability; undeclared ones refuse with CAPABILITY_UNSUPPORTED
 *   shape:<capability>    quotes have a finite ltp and an epoch-millisecond `at`; candles are sorted ascending, without
 *                         duplicates and consistent; expiries are sorted ISO dates; delayed data carries the "delayed" flag
 *                         and unofficial sources the "unofficial" flag
 *   abort                 a cancelled call rejects with AbortError and makes no further requests
 *   limits                a burst never sends more requests than the documented per-second, per-minute and per-day limits,
 *                         and the provider recovers afterwards
 *   errors:<scenario>     rate limit, auth, not found, upstream failure, network failure and unreadable answers all become
 *                         BridgeError with the right code and `fields.kind`; a 429 is backed off from
 *   secrets               no secret appears in any result, error, descriptor or log line
 *   network               only declared https hosts, no redirects followed, no cookies, no browser impersonation
 *
 * `fixtures`:
 *   clock       a fake clock from createFakeClock() that the provider was built with (required)
 *   upstream    a scripted fetch from createScriptedFetch() that the provider was built with (required)
 *   inputs      { quotes: string[], history: { symbol, interval, fromMs, toMs }, expiries: string, optionChain: { underlying, expiry? } }
 *               one entry for each capability the descriptor declares
 *   secrets     values that must never leak (API keys the provider was given)
 *   scenarios   error scenarios the scripted fetch implements (default: rate-limited, not-found, upstream, network-error,
 *               garbage, plus auth when the descriptor needsKey). "entitlement" may be added for plan-restricted sources.
 *   hosts       declared hosts (default: provider.hosts)
 *   logs        optional () => string[] of log lines the provider wrote
 */
import { BridgeError } from "../core/errors.mjs";
import { CAPABILITIES, validateDescriptor } from "./contract.mjs";

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ── Test doubles, reusable by plugin authors ──

/**
 * A fake clock. `sleep` returns at once and moves time forward by the requested amount, so limiter waits cost nothing.
 * @param {number} [start] epoch ms (default 2026-11-09 09:30 IST, a Monday)
 */
export function createFakeClock(start = Date.UTC(2026, 10, 9, 4, 0, 0)) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    async sleep(ms, signal) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      sleeps.push(ms);
      t += Math.max(0, ms);
    },
    sleeps,
  };
}

/**
 * A fetch that serves scripted responses and records every call. Built-in scenarios: `hang` (never answers until the
 * signal aborts), `network-error` (a raw TypeError whose message contains the URL, as real fetch errors may) and
 * `garbage` (an HTML body). Every other scenario name must be given in `scenarios` as
 * `(url, init) => { status?, headers?, json?, text? }`. The scenario `ok` is the default.
 * @param {{ clock: { now(): number }, scenarios?: Record<string, (url: string, init: RequestInit) => object | Promise<object>> }} o
 */
export function createScriptedFetch({ clock, scenarios = {} }) {
  let scenario = "ok";
  const calls = [];
  const aborted = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  async function scripted(url, init = {}) {
    calls.push({ url: String(url), init, at: clock.now(), scenario });
    const signal = init.signal;
    if (signal?.aborted) throw aborted();
    if (scenario === "hang") {
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(aborted()), { once: true }));
    }
    if (scenario === "network-error") throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${url}`);
    if (scenario === "garbage") return new Response("<html><body>Service temporarily unavailable</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const make = scenarios[scenario];
    if (!make) throw new Error(`createScriptedFetch: no scenario named "${scenario}"`);
    const r = await make(String(url), init);
    const body = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }
  scripted.setScenario = (name) => {
    scenario = name;
  };
  scripted.calls = calls;
  return scripted;
}

// ── The harness ──

const headerEntries = (headers) => {
  if (!headers) return [];
  if (typeof headers.entries === "function") return [...headers.entries()];
  return Object.entries(headers);
};

/** What is wrong with a thrown value, or null when it is acceptable (a BridgeError, or an AbortError if `allowAbort`). */
function badThrow(e, { allowAbort = false } = {}) {
  if (e instanceof BridgeError) return null;
  if (allowAbort && e?.name === "AbortError") return null;
  if (e instanceof Error) return `a raw ${e.name} was thrown (${String(e.message).slice(0, 80)}); use BridgeError`;
  return `a non-error value was thrown (${typeof e})`;
}

function describeThrown(e) {
  return JSON.stringify({ name: e?.name, message: e?.message, detail: e?.detail, code: e?.code, fields: e?.fields, broker: e?.broker, errors: e?.errors, cause: e?.cause?.message, stack: e?.stack });
}

const finite = (n) => typeof n === "number" && Number.isFinite(n);

function validIsoDate(s) {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Violations of "at most `cap` calls in any window of `span` ms" over call times. */
export function windowViolations(times, limits) {
  const out = [];
  const sorted = [...times].sort((a, b) => a - b);
  for (const [name, span, cap] of [["perSecond", 1000, limits.perSecond], ["perMinute", 60_000, limits.perMinute], ["perDay", DAY_MS, limits.perDay]]) {
    if (!(cap > 0)) continue;
    let lo = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      while (sorted[lo] <= sorted[i] - span) lo += 1;
      if (i - lo + 1 > cap) {
        out.push(`${name}: ${i - lo + 1} requests within ${span} ms (limit ${cap})`);
        break;
      }
    }
  }
  return out;
}

/**
 * Run every conformance check against `provider`.
 * @param {import("./contract.mjs").SourceProvider & { hosts?: string[] }} provider
 * @param {object} fixtures see the header of this file
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail?: string }>, failures: string[] }>}
 */
export async function runProviderConformance(provider, fixtures = {}) {
  const { clock, upstream } = fixtures;
  if (!clock || typeof clock.advance !== "function") throw new TypeError("runProviderConformance needs fixtures.clock from createFakeClock()");
  if (!upstream || typeof upstream.setScenario !== "function") throw new TypeError("runProviderConformance needs fixtures.upstream from createScriptedFetch()");
  const inputs = fixtures.inputs ?? {};
  const secrets = (fixtures.secrets ?? []).filter((s) => typeof s === "string" && s.length >= 4);
  const d = provider?.descriptor ?? {};
  const declared = Array.isArray(d.capabilities) ? d.capabilities : [];
  const hosts = fixtures.hosts ?? provider?.hosts ?? [];
  const checks = [];
  const evidence = [];

  const run = async (name, fn) => {
    try {
      const problems = await fn();
      const list = (Array.isArray(problems) ? problems : problems ? [problems] : []).filter(Boolean);
      checks.push(list.length ? { name, ok: false, detail: list.join("; ") } : { name, ok: true });
    } catch (e) {
      checks.push({ name, ok: false, detail: `the check itself failed: ${e?.message ?? e}` });
    }
  };

  const observe = (v) => evidence.push(typeof v === "string" ? v : JSON.stringify(v ?? null));
  const ctx = (signal) => ({ signal, now: clock.now() });
  const reset = () => {
    clock.advance(DAY_MS + 60_000); // lets every limit window and 429 back-off from earlier checks expire
    upstream.setScenario("ok");
  };

  /** Call a capability with the fixture inputs. Resolves `{ value }` or `{ error }`; observes both for the secret scan. */
  async function invoke(cap, signal) {
    const fn = provider[cap];
    if (typeof fn !== "function") return { error: new TypeError(`provider has no ${cap} method`) };
    try {
      let value;
      if (cap === "quotes") value = await fn.call(provider, inputs.quotes, ctx(signal));
      else if (cap === "history") value = await fn.call(provider, inputs.history, ctx(signal));
      else if (cap === "expiries") value = await fn.call(provider, inputs.expiries ?? "NIFTY", ctx(signal));
      else value = await fn.call(provider, inputs.optionChain?.underlying ?? "NIFTY", inputs.optionChain?.expiry, ctx(signal));
      observe(value);
      return { value };
    } catch (error) {
      observe(describeThrown(error));
      return { error };
    }
  }

  // ── descriptor ──
  await run("descriptor", () => {
    const problems = [];
    const v = validateDescriptor(d);
    problems.push(...v.errors);
    if (!Array.isArray(provider?.hosts) || !provider.hosts.length) problems.push("provider.hosts must list every host the provider contacts");
    if (d.kind !== "broker" && d.class === "realtime") problems.push("a free or plugin source must not claim real-time data");
    const note = d.terms?.note;
    if (typeof note === "string" && (note.length > 420 || note.split(/[.!?]\s+[A-Z]/).length > 1)) problems.push("terms.note must be one plain sentence");
    return problems;
  });

  // ── capabilities ──
  await run("capabilities", async () => {
    const problems = [];
    for (const cap of declared) if (typeof provider[cap] !== "function") problems.push(`declares ${cap} but has no ${cap} method`);
    const before = upstream.calls.length;
    for (const cap of CAPABILITIES.filter((c) => !declared.includes(c) && typeof provider[c] === "function")) {
      const { value, error } = await invoke(cap);
      if (value) problems.push(`${cap} is not declared but returned data`);
      else if (!(error instanceof BridgeError) || error.code !== "CAPABILITY_UNSUPPORTED") problems.push(`${cap} is not declared, so it must reject with CAPABILITY_UNSUPPORTED (got ${error?.code ?? error?.name})`);
    }
    if (upstream.calls.length !== before) problems.push("an undeclared capability made a network request");
    return problems;
  });

  // ── shapes ──
  const shapeChecks = {
    quotes(res) {
      const p = [];
      if (!res || !Array.isArray(res.items)) return ["quotes must resolve to { items: [] }"];
      if (!res.items.length) p.push("quotes returned no items for the fixture symbols");
      const seen = new Set();
      for (const it of res.items) {
        if (typeof it?.symbol !== "string" || !inputs.quotes.includes(it.symbol)) p.push(`item symbol ${JSON.stringify(it?.symbol)} was not asked for`);
        if (seen.has(it?.symbol)) p.push(`duplicate item ${it?.symbol}`);
        seen.add(it?.symbol);
        if (!it?.fields || typeof it.fields !== "object") p.push(`${it?.symbol}: fields missing`);
        else {
          if (!finite(it.fields.ltp) || it.fields.ltp <= 0) p.push(`${it.symbol}: fields.ltp must be a finite positive number`);
          for (const [k, v] of Object.entries(it.fields)) if (v !== null && !finite(v)) p.push(`${it.symbol}: fields.${k} must be a finite number or null`);
        }
        if (!Number.isInteger(it?.at) || it.at < 1e12 || it.at > clock.now() + DAY_MS) p.push(`${it?.symbol}: at must be epoch milliseconds, not in the future`);
        const flags = it?.flags;
        if (!Array.isArray(flags) || flags.some((f) => typeof f !== "string")) p.push(`${it?.symbol}: flags must be an array of strings`);
        else {
          if (d.class === "delayed" && !flags.includes("delayed")) p.push(`${it.symbol}: delayed data must carry the "delayed" flag`);
          if (d.official === false && !flags.includes("unofficial")) p.push(`${it.symbol}: unofficial data must carry the "unofficial" flag`);
        }
      }
      return p;
    },
    history(res) {
      const p = [];
      if (!res || !Array.isArray(res.candles)) return ["history must resolve to { candles: [], at }"];
      if (!res.candles.length) p.push("history returned no candles for the fixture range");
      if (!finite(res.at)) p.push("at must be a finite epoch-millisecond number");
      if (res.partial !== undefined && typeof res.partial !== "boolean") p.push("partial must be a boolean when present");
      const slack = ["1d", "1w", "1M"].includes(inputs.history.interval) ? DAY_MS : 0;
      let prev = -Infinity;
      for (const [i, c] of res.candles.entries()) {
        const bad = (m) => p.push(`candle ${i}: ${m}`);
        if (!Number.isInteger(c?.time) || c.time <= 0 || c.time >= 1e11) bad("time must be integer epoch seconds");
        for (const k of ["open", "high", "low", "close"]) if (!finite(c?.[k]) || c[k] <= 0) bad(`${k} must be a finite positive number`);
        if (!finite(c?.volume) || c.volume < 0) bad("volume must be a finite number, 0 or more");
        if (finite(c?.high) && finite(c?.low) && (c.high < c.low || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close))) bad("high and low do not enclose open and close");
        if (c.time <= prev) bad(c.time === prev ? "duplicate time" : "candles are not sorted ascending");
        prev = c.time;
        if (c.time * 1000 < inputs.history.fromMs - slack || c.time * 1000 > inputs.history.toMs + slack) bad("time is outside the requested range");
      }
      if (res.provisionalFrom !== undefined && res.provisionalFrom !== res.candles[res.candles.length - 1]?.time) p.push("provisionalFrom must be the time of the last candle");
      if (!Array.isArray(res.flags) || (d.class === "delayed" && !res.flags.includes("delayed")) || (d.official === false && !res.flags.includes("unofficial"))) p.push('result flags must be an array carrying "delayed" and "unofficial" where they apply');
      return p;
    },
    expiries(res) {
      const p = [];
      if (!res || !Array.isArray(res.expiries)) return ["expiries must resolve to { expiries: [], at }"];
      if (!finite(res.at)) p.push("at must be a finite epoch-millisecond number");
      res.expiries.forEach((e, i) => {
        if (typeof e !== "string" || !validIsoDate(e)) p.push(`expiry ${i} is not an ISO date (YYYY-MM-DD)`);
        else if (i > 0 && e <= res.expiries[i - 1]) p.push("expiries must be sorted ascending without duplicates");
      });
      return p;
    },
    optionChain(res) {
      const p = [];
      if (!res || !Array.isArray(res.rows)) return ["optionChain must resolve to { underlyingLtp, rows: [], at }"];
      if (res.underlyingLtp !== null && !finite(res.underlyingLtp)) p.push("underlyingLtp must be a finite number or null");
      if (!finite(res.at)) p.push("at must be a finite epoch-millisecond number");
      return p;
    },
  };
  for (const cap of declared) {
    await run(`shape:${cap}`, async () => {
      reset();
      if (cap === "quotes" && !Array.isArray(inputs.quotes)) return "fixtures.inputs.quotes (an array of symbols) is required";
      if (cap === "history" && !inputs.history) return "fixtures.inputs.history is required";
      const { value, error } = await invoke(cap);
      if (error) return `the happy path rejected: ${error.code ?? error.name}: ${String(error.message).slice(0, 100)}`;
      return shapeChecks[cap]?.(value) ?? [];
    });
  }

  const primary = declared.find((c) => c === "quotes" || c === "history");

  // ── abort ──
  await run("abort", async () => {
    const problems = [];
    if (!primary) return problems;
    reset();
    let before = upstream.calls.length;
    const pre = new AbortController();
    pre.abort();
    const a = await invoke(primary, pre.signal);
    if (!a.error) problems.push("a call with an already-aborted signal resolved");
    else if (a.error.name !== "AbortError") problems.push(`an already-aborted signal must reject with AbortError (got ${a.error.name})`);
    if (upstream.calls.length !== before) problems.push("a request was sent although the signal was already aborted");
    upstream.setScenario("hang");
    before = upstream.calls.length;
    const ac = new AbortController();
    const pending = invoke(primary, ac.signal);
    await new Promise((r) => setTimeout(r, 15));
    ac.abort();
    const outcome = await Promise.race([pending, new Promise((r) => setTimeout(() => r({ timeout: true }), 1000))]);
    if (outcome.timeout) problems.push("the call did not stop within a second of the signal aborting");
    else if (!outcome.error || outcome.error.name !== "AbortError") problems.push(`an aborted in-flight call must reject with AbortError (got ${outcome.error?.name ?? "a result"})`);
    const bad = outcome.error ? badThrow(outcome.error, { allowAbort: true }) : null;
    if (bad) problems.push(bad);
    reset();
    return problems;
  });

  // ── limits ──
  await run("limits", async () => {
    const problems = [];
    if (!primary) return problems;
    const lim = d.limits ?? {};
    reset();
    const baseline = upstream.calls.length;
    const rates = [lim.perSecond, lim.perMinute].filter((n) => n > 0);
    const burst = Math.min(80, (rates.length ? Math.max(...rates) : lim.perDay > 0 ? lim.perDay : 20) + 3);
    const settle = async (n) => {
      const results = await Promise.all(Array.from({ length: n }, () => invoke(primary)));
      for (const r of results) {
        const bad = r.error ? badThrow(r.error) : null;
        if (bad) problems.push(`during a burst: ${bad}`);
      }
      return results;
    };
    await settle(burst);
    // Keep going across minutes until the daily limit (if any) has been tested too.
    if (lim.perDay > 0) {
      const perBurst = Math.max(1, Math.min(lim.perMinute > 0 ? lim.perMinute : 10, lim.perSecond > 0 ? lim.perSecond * 30 : 10));
      const cycles = Math.min(500, Math.ceil(lim.perDay / perBurst) + 3);
      for (let i = 0; i < cycles; i += 1) {
        clock.advance(61_000);
        await settle(perBurst + 2);
      }
    }
    const times = upstream.calls.slice(baseline).map((c) => c.at);
    problems.push(...windowViolations(times, lim).map((v) => `burst broke a documented limit: ${v}`));
    if (!times.length) problems.push("no request was sent during the burst, so the limits could not be checked");
    reset();
    const after = await invoke(primary);
    if (after.error) problems.push(`the provider did not recover after the windows passed (${after.error.code ?? after.error.name})`);
    return problems;
  });

  // ── errors ──
  const scenarios = fixtures.scenarios ?? ["rate-limited", "not-found", "upstream", "network-error", "garbage", ...(d.needsKey ? ["auth"] : [])];
  const EXPECT = {
    "rate-limited": { codes: ["UPSTREAM_RATE_LIMITED"], kind: "rate-limited" },
    auth: { codes: ["UPSTREAM_ERROR"], kind: "auth" },
    "not-found": { codes: ["SYMBOL_NOT_FOUND"], kind: "not-found" },
    entitlement: { codes: ["CAPABILITY_UNSUPPORTED"], kind: "entitlement" },
    upstream: { codes: ["UPSTREAM_ERROR", "UPSTREAM_TIMEOUT", "BROKER_UNAVAILABLE"] },
    "network-error": { codes: ["UPSTREAM_ERROR", "UPSTREAM_TIMEOUT", "BROKER_UNAVAILABLE"] },
    garbage: { codes: ["UPSTREAM_ERROR", "UPSTREAM_TIMEOUT", "BROKER_UNAVAILABLE"] },
  };
  for (const name of scenarios) {
    await run(`errors:${name}`, async () => {
      const problems = [];
      if (!primary) return problems;
      const want = EXPECT[name];
      if (!want) return `unknown scenario ${name}`;
      reset();
      upstream.setScenario(name);
      const before = upstream.calls.length;
      const { value, error } = await invoke(primary);
      const sent = upstream.calls.slice(before);
      if (value) return `${name}: the call resolved instead of rejecting`;
      const bad = badThrow(error);
      if (bad) return `${name}: ${bad}`;
      if (!want.codes.includes(error.code)) problems.push(`${name}: expected code ${want.codes.join(" or ")}, got ${error.code}`);
      if (want.kind && error.fields?.kind !== want.kind) problems.push(`${name}: expected fields.kind "${want.kind}", got ${JSON.stringify(error.fields?.kind)}`);
      if (typeof error.detail !== "string" || !error.detail.trim()) problems.push(`${name}: the error needs a plain message`);
      if (name === "rate-limited") {
        if (!finite(error.retryAfterMs) || error.retryAfterMs <= 0) problems.push("a rate-limit error must carry retryAfterMs");
        else if (sent.length) {
          const t429 = sent[sent.length - 1].at;
          const again = await invoke(primary);
          const extra = upstream.calls.slice(before + sent.length);
          if (!again.error && !extra.length) problems.push("a call straight after a 429 resolved without sending a request");
          for (const c of extra) if (c.at < t429 + error.retryAfterMs - 1) problems.push("the provider sent a request before the Retry-After time had passed");
        }
      }
      reset();
      return problems;
    });
  }

  // ── secrets ──
  await run("secrets", () => {
    const text = [...evidence, JSON.stringify(provider.descriptor ?? null), ...Object.entries(provider).filter(([, v]) => typeof v === "string").map(([, v]) => v), ...(typeof fixtures.logs === "function" ? fixtures.logs() : [])].join("\n");
    return secrets.filter((s) => text.includes(s)).map((s) => `a secret (${s.slice(0, 2)}***) appears in a result, error, descriptor or log line`);
  });

  // ── network ──
  await run("network", () => {
    const problems = new Set();
    for (const c of upstream.calls) {
      let u;
      try {
        u = new URL(c.url);
      } catch {
        problems.add(`not a URL: ${c.url.slice(0, 60)}`);
        continue;
      }
      if (u.protocol !== "https:") problems.add(`non-https request to ${u.host}`);
      if (!hosts.includes(u.hostname)) problems.add(`request to undeclared host ${u.hostname}`);
      if (c.init?.redirect === "follow") problems.add("redirects are followed; use redirect: \"error\" so credentials are never forwarded");
      for (const [k, v] of headerEntries(c.init?.headers)) {
        const key = String(k).toLowerCase();
        if (key === "cookie") problems.add("a Cookie header was sent");
        if (key === "user-agent" && /mozilla|chrome\/|safari\/|firefox\//i.test(String(v))) problems.add("the User-Agent impersonates a browser; identify the Bridge honestly");
      }
      if (c.init?.credentials === "include") problems.add("credentials: include sends cookies");
    }
    return [...problems];
  });

  const failures = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  return { ok: failures.length === 0, checks, failures };
}
