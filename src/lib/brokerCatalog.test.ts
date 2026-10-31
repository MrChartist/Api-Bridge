import { describe, expect, it } from "vitest";
import { BROKERS } from "./brokerCatalog";
import { BROKER_ADAPTER_META } from "./brokerCapabilities.generated";
// @ts-expect-error plain ESM module without type declarations
import { BROKER_NAMES } from "../../server/bridge/accounts/brokerInfo.mjs";
// @ts-expect-error plain ESM module without type declarations
import { BROKER_POLICIES } from "../../server/bridge/ratelimit/brokerPolicies.mjs";

describe("broker catalogue", () => {
  const ids = BROKERS.map((b) => b.id).sort();

  it("has 41 unique brokers", () => {
    expect(ids).toHaveLength(41);
    expect(new Set(ids).size).toBe(41);
  });

  it("matches the generated adapter metadata, the Bridge's display names and its policy table", () => {
    expect(Object.keys(BROKER_ADAPTER_META).sort()).toEqual(ids);
    expect(Object.keys(BROKER_NAMES).sort()).toEqual(ids);
    expect(Object.keys(BROKER_POLICIES).sort()).toEqual(ids);
  });
});
