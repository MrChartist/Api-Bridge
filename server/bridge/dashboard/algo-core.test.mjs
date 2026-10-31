import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIST_MS, LOG_IDLE_MS, LOG_MS, TEMPLATE, heartbeatText, isActive, liveStartBlock, logGap, paramFields, paramLabel, readParams, serverFieldErrors, statusOf, totals, uptimeText } from "./algo-core.js";

describe("Algo page model (algo-core.js)", () => {
  it("names every status and its tone", () => {
    expect(statusOf("running")).toEqual({ text: "Running", tone: "ok" });
    expect(statusOf("failed").tone).toBe("bad");
    expect(statusOf("restarting").tone).toBe("warn");
    expect(["starting", "running", "stopping", "restarting"].every(isActive)).toBe(true);
    expect(["stopped", "finished", "failed"].some(isActive)).toBe(false);
  });

  it("writes uptime and heartbeat in words", () => {
    expect(uptimeText(45_000)).toBe("45 s");
    expect(uptimeText(12 * 60_000)).toBe("12 min");
    expect(uptimeText(2 * 3600_000 + 5 * 60_000)).toBe("2 h 05 min");
    expect(uptimeText(27 * 3600_000)).toBe("1 d 3 h");
    expect(uptimeText(null)).toBe("–");
    expect(heartbeatText(2400)).toEqual({ text: "2 s ago", late: false });
    expect(heartbeatText(null).text).toBe("Waiting");
    expect(heartbeatText(20_000).late).toBe(true);
  });

  it("draws a typed form from the declared params and reads it back with the SDK's rules", () => {
    const params = [
      { name: "lots", kind: "int", default: 1, min: 1, max: 10 },
      { name: "stop_loss_pct", kind: "float", default: 30, min: 5, step: 5, help: "Stop" },
      { name: "exit_on_stop", kind: "bool", default: true },
      { name: "underlying", kind: "choice", default: "NIFTY", choices: ["NIFTY", "BANKNIFTY"] },
      { name: "square_off", kind: "str", default: "15:15", label: "Square-off time" },
    ];
    const f = paramFields(params, { lots: 3 });
    expect(f.map((x) => [x.name, x.input, x.value, x.changed])).toEqual([
      ["lots", "number", 3, true],
      ["stop_loss_pct", "number", 30, false],
      ["exit_on_stop", "checkbox", true, false],
      ["underlying", "select", "NIFTY", false],
      ["square_off", "text", "15:15", false],
    ]);
    expect(f[0].step).toBe(1);
    expect(f[1].step).toBe(5);
    expect(paramLabel(params[1])).toBe("Stop loss %");
    expect(paramLabel(params[4])).toBe("Square-off time");
    expect(readParams(f, { lots: "4", stop_loss_pct: "12.5", exit_on_stop: false, underlying: "BANKNIFTY", square_off: "15:00" })).toEqual({ values: { lots: 4, stop_loss_pct: 12.5, exit_on_stop: false, underlying: "BANKNIFTY", square_off: "15:00" }, errors: {} });
    expect(readParams(f, { lots: "11", stop_loss_pct: "1", exit_on_stop: true, underlying: "X", square_off: "" }).errors).toEqual({ lots: "At most 10", stop_loss_pct: "At least 5", underlying: "Choose one of NIFTY, BANKNIFTY" });
    expect(readParams(f, { lots: "1.5", stop_loss_pct: "", exit_on_stop: true, underlying: "NIFTY", square_off: "" }).errors).toEqual({ lots: "Enter a whole number", stop_loss_pct: "Enter a number" });
  });

  it("adds up the summary strip and maps server field errors", () => {
    expect(totals([{ status: "running", pnl: { total: 100.5 }, orderCount: 2 }, { status: "stopped", pnl: null, orderCount: 0 }, { status: "failed", pnl: { total: -50 }, orderCount: 3 }])).toEqual({ running: 1, count: 3, pnl: 50.5, orders: 5 });
    expect(totals([]).pnl).toBe(null);
    expect(serverFieldErrors({ body: { errors: [{ path: "params.lots", message: "must be at most 10" }, { path: "account", message: "x" }] } })).toEqual({ lots: "must be at most 10" });
  });

  it("the template is a strategy the SDK can describe: one Strategy class, literal params, no em dash", () => {
    expect(TEMPLATE).toMatch(/class MyStrategy\(Strategy\):/);
    expect(TEMPLATE).toMatch(/"lots": Param\(1, min=1, max=10/);
    expect(TEMPLATE).not.toMatch(/—/);
  });

  it("the page never builds numbers into text by hand and never places an order itself", () => {
    const src = readFileSync(new URL("./algo.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/\/v1\/orders["`]/);
    expect(src).not.toMatch(/toFixed\(|toLocaleString\(|Intl\.NumberFormat/);
  });
});

describe("Algo polling (perf round 5)", () => {
  it("tails the log every second while the strategy runs, every 5 s otherwise", () => {
    expect(logGap("running")).toBe(LOG_MS);
    expect(logGap("starting")).toBe(LOG_MS);
    expect(logGap("stopped")).toBe(LOG_IDLE_MS);
    expect(logGap(undefined)).toBe(LOG_IDLE_MS);
    expect([LOG_MS, LIST_MS, LOG_IDLE_MS]).toEqual([1000, 2000, 5000]);
  });

  it("reads nothing while the tab is hidden", () => {
    const src = readFileSync(new URL("./algo.js", import.meta.url), "utf8");
    for (const fn of ["pollLog", "pollAll"]) {
      const body = src.slice(src.indexOf(`function ${fn}()`), src.indexOf(`function ${fn}()`) + 200);
      expect(body, fn).toMatch(/if \(document\.hidden\) \w+Timer = setTimeout\(\w+, LOG_MS\);\s+else load\w+\(\);/);
    }
    expect(src).not.toMatch(/setTimeout\(\(\) => grid\.isConnected && load/);
  });
});

describe("Algo › Start live", () => {
  const zerodha = (o) => ({ id: "z", broker: "zerodha", enabled: true, liveAllowedByConfig: true, liveSources: ["rest"], ...o });
  const paper = { id: "p", broker: "paper", enabled: true, liveAllowedByConfig: false, liveSources: [] };

  it("is possible when some account allows live orders from REST", () => {
    expect(liveStartBlock([paper, zerodha()])).toBeNull();
    expect(liveStartBlock([zerodha({ liveSources: ["webhook"] }), zerodha({ id: "y" })])).toBeNull();
    // An older Bridge sends no liveSources: its refusal on start says why.
    expect(liveStartBlock([zerodha({ liveSources: undefined })])).toBeNull();
  });

  it("says in one line why no account can take a live strategy", () => {
    expect(liveStartBlock([paper, zerodha({ liveSources: ["webhook", "mcp"] })])).toBe('No account allows live strategies: add "rest" to live.allowedSources for the account in bridge.config.json (strategies send orders through the REST API).');
    expect(liveStartBlock([paper, zerodha({ liveAllowedByConfig: false })])).toMatch(/^No account allows live strategies: live trading is off .*safety\.liveTrading/);
    expect(liveStartBlock([paper])).toMatch(/^No broker account to trade live/);
    expect(liveStartBlock([zerodha({ enabled: false })])).toMatch(/^No broker account/);
  });

  it("disables the button with that line, and leaves the Bridge's refusal on start as it was", () => {
    const src = readFileSync(new URL("./algo.js", import.meta.url), "utf8");
    expect(src).toContain("if (liveWhy) liveBtn.disabled = true;");
    expect(src).toContain('"aria-describedby": "algo-live-why"');
    expect(src).toMatch(/Object\.assign\(body, \{ mode: "live", confirmLive: s\.id \}\)/);
  });
});
