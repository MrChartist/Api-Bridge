import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEMPLATE, heartbeatText, isActive, paramFields, paramLabel, readParams, serverFieldErrors, statusOf, totals, uptimeText } from "./algo-core.js";

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
