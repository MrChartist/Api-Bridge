import { describe, expect, it } from "vitest";
import { parseGeneric } from "./receivers/generic.mjs";
import { parseGoCharting } from "./receivers/gocharting.mjs";
import { alertTemplates } from "./templates.mjs";

const hook = (o) => ({ source: "generic", side: null, orderType: "LIMIT", product: null, maxLotsPerSignal: 2, ...o });

describe("alert templates match their receivers", () => {
  it("MARKET hooks get examples without a price, LIMIT hooks with one", () => {
    expect(JSON.parse(alertTemplates(hook({ orderType: "MARKET" }))[0].message).price).toBeUndefined();
    expect(JSON.parse(alertTemplates(hook({}))[0].message).price).toBe(1402.5);
    expect(alertTemplates(hook({ source: "gocharting", orderType: "MARKET" }))[0].message).toContain("MKT");
  });
  it("GoCharting and generic examples parse", () => {
    expect(parseGoCharting(alertTemplates(hook({ source: "gocharting" }))[0].message).signals[0]).toMatchObject({ side: "BUY", quantity: 1 });
    expect(parseGeneric(JSON.parse(alertTemplates(hook({ source: "generic", side: "SELL" }))[0].message)).signals[0]).toMatchObject({ side: "SELL" });
  });
  it("ChartInk explains that the side comes from the hook", () => {
    expect(alertTemplates(hook({ source: "chartink" }))[0].notes.join(" ")).toMatch(/Set a side/);
  });
});
