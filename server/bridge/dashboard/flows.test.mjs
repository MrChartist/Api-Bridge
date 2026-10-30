// The pure rules behind the Create a key and Add a broker flows (flows.js).
import { describe, expect, it } from "vitest";
import { KEY_USES, afterDemoSaveSteps, brokerSetupSteps, capabilityLabel, capabilitySummary, defaultKeyName, istDay, keyFormProblem, keyUse, sessionText, ticketRisk } from "./flows.js";
import { loginFormSpec } from "./app.js";
import { snippets } from "./snippets.js";

const OCT30 = new Date("2026-10-30T05:00:00Z"); // 10:30 IST

describe("Create a key", () => {
  it("names a key after its tool and the IST day, and keeps names apart", () => {
    expect(defaultKeyName("excel", OCT30)).toBe("Excel key · 30 Oct");
    expect(defaultKeyName("claude", OCT30)).toBe("AI key · 30 Oct");
    expect(defaultKeyName("excel", OCT30, ["Excel key · 30 Oct"])).toBe("Excel key · 30 Oct 2");
    expect(defaultKeyName("excel", OCT30, ["excel key · 30 oct", "Excel key · 30 Oct 2"])).toBe("Excel key · 30 Oct 3");
    expect(defaultKeyName("nosuch", OCT30)).toBe("API key · 30 Oct");
    // 20:00 UTC on the 30th is already the 31st in India.
    expect(istDay(new Date("2026-10-30T20:00:00Z"))).toBe("2026-10-31");
  });

  it("gives each tool the least access it needs, and only spreadsheet keys sit in URLs", () => {
    for (const u of KEY_USES) {
      expect(u.scopes).not.toContain("admin");
      if (u.allowQuery) expect(u.scopes).toEqual(["read"]);
      // Every snippet a tool points at exists.
      for (const id of u.snippets) expect(snippets({ base: "http://127.0.0.1:4300" })[id], `${u.id} → ${id}`).toBeTruthy();
    }
    expect(keyUse("excel")).toMatchObject({ scopes: ["read"], allowQuery: true, clientKind: "excel" });
    expect(keyUse("python").scopes).toEqual(["paper"]);
  });

  it("explains what is wrong with the form, on the field at fault", () => {
    expect(keyFormProblem({ label: "  ", scopes: ["read"], allowQuery: false })).toMatchObject({ field: "label" });
    expect(keyFormProblem({ label: "x".repeat(61), scopes: ["read"], allowQuery: false })).toMatchObject({ field: "label" });
    expect(keyFormProblem({ label: "Excel key", scopes: ["paper"], allowQuery: true })).toMatchObject({ field: "access" });
    expect(keyFormProblem({ label: "Excel key", scopes: ["read"], allowQuery: true })).toBeNull();
  });

  it("fills the new key into every setup it shows", () => {
    const s = snippets({ base: "http://127.0.0.1:4300", key: "mcb_abc_secret" });
    for (const id of ["excel", "python", "node", "claude", "rest"]) expect(JSON.stringify(s[id]), id).toContain("mcb_abc_secret");
  });
});

describe("Trade ticket risk", () => {
  it("works out max loss, max profit and breakeven for one option order", () => {
    expect(ticketRisk({ side: "BUY", right: "CE", strike: 26400, price: 300, qty: 65 })).toEqual({ maxLoss: 19500, maxProfit: null, breakeven: 26700, premium: 19500 });
    expect(ticketRisk({ side: "BUY", right: "PE", strike: 26400, price: 250, qty: 65 })).toEqual({ maxLoss: 16250, maxProfit: (26400 - 250) * 65, breakeven: 26150, premium: 16250 });
    expect(ticketRisk({ side: "SELL", right: "CE", strike: 26400, price: 300, qty: 65 })).toMatchObject({ maxLoss: null, maxProfit: 19500, breakeven: 26700 });
    expect(ticketRisk({ side: "SELL", right: "PE", strike: 26400, price: 250, qty: 65 })).toMatchObject({ maxLoss: (26400 - 250) * 65, maxProfit: 16250 });
    for (const bad of [{ kind: "FUT" }, { price: 0 }, { qty: null }, { right: "XX" }]) expect(ticketRisk({ side: "BUY", right: "CE", strike: 100, price: 1, qty: 1, ...bad })).toBeNull();
  });
});

describe("Accounts in plain words", () => {
  it("names capabilities and session states the way people say them", () => {
    expect(capabilityLabel("placeOrder")).toBe("Place orders");
    expect(capabilityLabel("somethingNew")).toBe("somethingNew");
    expect(capabilitySummary(["ltp", "placeOrder"])).toBe("Data and orders");
    expect(capabilitySummary(["orderBook", "placeOrder"])).toBe("Orders only");
    expect(capabilitySummary(["feed"])).toBe("Data only");
    expect(sessionText("missing")).toEqual({ text: "Not logged in", tone: "warn" });
    expect(sessionText("expired").tone).toBe("bad");
    expect(sessionText("connected").text).toBe("Logged in");
  });
});

describe("Add a broker", () => {
  const zerodha = { id: "zerodha", name: "Zerodha", authKind: "oauthRedirect", credentialFields: ["apiKey", "apiSecret", "accessToken"], loginFields: [], tokenExpiry: "06:00 IST" };
  const angel = { id: "angelone", name: "Angel One", authKind: "sessionLogin", credentialFields: ["apiKey", "clientCode"], loginFields: [{ key: "pin", label: "PIN", kind: "secret" }, { key: "totp", label: "TOTP", kind: "totp" }] };

  it("lists the fields a broker will ask for, step by step", () => {
    const steps = brokerSetupSteps(zerodha, loginFormSpec(zerodha), { demo: true });
    expect(steps.map((s) => s.title)).toEqual(["Get your API details from Zerodha", "Start the Bridge normally", "Log in on Accounts", "Trade on paper first"]);
    expect(steps[0].fields).toEqual(["API key", "API secret", "Access token"]);
    expect(steps[3].text).toMatch(/every day/);
    const a = brokerSetupSteps(angel, loginFormSpec(angel));
    expect(a.map((s) => s.title)).not.toContain("Start the Bridge normally");
    expect(a.find((s) => s.title === "Log in on Accounts").fields).toEqual(["PIN", "TOTP"]);
  });

  it("says what to do after saving from demo mode, by what the config file holds", () => {
    expect(afterDemoSaveSteps({ demoTurnedOff: true }, "Zerodha").join(" ")).toMatch(/starts normally now.*Log in next to Zerodha/);
    expect(afterDemoSaveSteps({ demoWasInFile: true, configFile: "C:/b/bridge.config.json" }).join(" ")).toMatch(/Delete the line "demo": true there/);
    expect(afterDemoSaveSteps({}).join(" ")).toMatch(/without --demo/);
  });

  it("keeps the flow copy free of em dashes", () => {
    const all = JSON.stringify([brokerSetupSteps(zerodha, loginFormSpec(zerodha), { demo: true }), afterDemoSaveSteps({}), KEY_USES]);
    expect(all).not.toContain("\u2014");
  });
});
