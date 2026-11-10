// Regression tests for the front-end review: a one-time key must leave the page when its sheet closes (F4), and a dashboard
// order must carry an Idempotency-Key so a repeat can never place a second order (F7).
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scrubOnClose } from "./app.js";
import { createDataClient, downloadBody, recordingBody, scrubNames, stripBidi } from "./data-core.js";
import { receiverProblem } from "./developers-core.js";
import { createOrderKeys } from "./orders-core.js";

const dir = new URL("./", import.meta.url);
const sources = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(new URL(f, dir), "utf8")]);

/** The least of a <dialog> the scrub needs: listeners, `open`, and replaceChildren. */
function fakeDialog() {
  const listeners = new Map();
  const d = {
    open: true,
    children: ["the key mcb_live_secret"],
    addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    replaceChildren(...c) {
      this.children = c;
    },
    fire(t) {
      for (const fn of listeners.get(t) ?? []) fn();
    },
    count: (t) => (listeners.get(t) ?? []).length,
  };
  return d;
}

describe("F4: the shared dialog is emptied when it closes", () => {
  it("removes what the sheet showed (a one-time key) once the dialog is closed", () => {
    const d = fakeDialog();
    scrubOnClose(d);
    d.open = false;
    d.fire("close");
    expect(d.children).toEqual([]);
  });
  it("leaves a sheet alone that opened again before the close event arrived", () => {
    const d = fakeDialog();
    scrubOnClose(d);
    d.open = true;
    d.fire("close");
    expect(d.children).toEqual(["the key mcb_live_secret"]);
  });
  it("installs one listener however many sheets open", () => {
    const d = fakeDialog();
    scrubOnClose(d);
    scrubOnClose(d);
    scrubOnClose(null);
    expect(d.count("close")).toBe(1);
  });
  it("both ways of showing the dialog (a modal and the phone popover) install it", () => {
    const app = sources.find(([f]) => f === "app.js")[1];
    expect(app.match(/scrubOnClose\(d\);/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("F7: every order the dashboard places carries an Idempotency-Key", () => {
  it("gives the same body the same key and a different body a new one", () => {
    let n = 0;
    const keys = createOrderKeys(() => `u${++n}`);
    const a = { symbol: "NSE:INFY", quantity: 1 };
    const k1 = keys.keyFor(a);
    expect(keys.keyFor({ ...a })).toBe(k1); // a double click, a retry, Undo twice
    expect(keys.keyFor({ ...a, quantity: 2 })).not.toBe(k1);
    expect(k1).toMatch(/^dash-/);
  });
  it("uses a real random key by default", () => {
    const a = createOrderKeys().keyFor({ x: 1 });
    const b = createOrderKeys().keyFor({ x: 1 });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^dash-[0-9a-f-]{36}$/);
  });
  it("api() sends it as the header, and every POST /v1/orders call site passes one", () => {
    const app = sources.find(([f]) => f === "app.js")[1];
    expect(app).toContain('headers["Idempotency-Key"] = idempotencyKey');
    let sites = 0;
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/api\(\s*"\/v1\/orders"\s*,\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\s*\)/g)) {
        if (!/method:\s*"POST"/.test(m[1])) continue;
        sites++;
        expect(m[1], `${file}: a POST /v1/orders without idempotencyKey`).toContain("idempotencyKey");
      }
    }
    expect(sites).toBeGreaterThanOrEqual(2); // Undo after Cancel, Send a practice order
  });
  it("Undo is switched off while its order goes out", () => {
    const views = sources.find(([f]) => f === "views.js")[1];
    expect(views).toMatch(/if \(button\?\.disabled\) return;\s*if \(button\) button\.disabled = true;/);
  });
});

describe("F12: a control's accessible name starts with its visible words (WCAG 2.5.3)", () => {
  const src = (f) => sources.find(([n]) => n === f)[1];
  it("the Sources rows carry their spoken extras as text, not as an aria-label", () => {
    expect(src("sources-page.js")).not.toMatch(/el\.setAttribute\("aria-label", `\$\{r\.name\}/);
    expect(src("sources-page.js")).toMatch(/setText\(p\.saidEl, `\. /);
  });
  it("the Sheets script button and the tunnel guide link start with the words on them", () => {
    const panel = src("sheets-panel.js");
    expect(panel).toContain('label: "Copy the Apps Script", done: "Copied", toastLabel: "Apps Script copied", cls: "small tinted", ariaLabel: "Copy the Apps Script for Google Sheets"');
    expect(panel).toContain('"aria-label": "Tunnel guide: making the Bridge reachable (opens in a new tab)" }, "Tunnel guide"');
  });
  it("two landmarks on the Events view do not share a name", () => {
    const dev = src("developers.js");
    expect(dev).not.toContain('role: "region", "aria-label": "Recent events"');
    expect(dev).toContain('h("h2", { id: "dev-ev3" }, "Recent events")');
  });
});

describe("F14: hardening", () => {
  const src = (f) => sources.find(([n]) => n === f)[1];
  it("text direction controls are removed from names shown and names sent", async () => {
    const evil = "report \u202Evsc.exe \u2066x\u2069";
    expect(stripBidi(evil)).toBe("report vsc.exe x");
    expect(scrubNames({ name: evil, other: evil, items: [{ label: evil, n: 1 }] })).toEqual({ name: "report vsc.exe x", other: evil, items: [{ label: "report vsc.exe x", n: 1 }] });
    const client = createDataClient(async () => ({ data: [{ id: "a", name: evil }] }));
    expect((await client.downloads.list()).data[0].name).toBe("report vsc.exe x");
    expect(downloadBody({ symbols: ["NSE:INFY"], intervals: ["5m"], range: "1m", format: "csv", layout: "per-symbol", name: evil }, { from: "2026-01-01" }).name).toBe("report vsc.exe x");
    expect(recordingBody({ kind: "quotes", source: "symbols", symbols: ["NSE:INFY"], everySec: 5, format: "csv", name: evil }, "once", {}).name).toBe("report vsc.exe x");
  });
  it("the receiver form does not say a plain http address works", () => {
    expect(receiverProblem({ url: "ftp://x", topics: ["a"] })).toMatch(/must start with https:\/\/.*refused unless you allow local addresses/);
    expect(receiverProblem({ url: "https://example.com/e", topics: ["a"] })).toBe("");
  });
  it("the TradingView source link is only drawn for an https address", () => {
    expect(src("views.js")).toContain('/^https:\\/\\//i.test(ipList.source ?? "")');
  });
});
