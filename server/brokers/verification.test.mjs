/**
 * The verification record (verification.json) must agree with the adapters, the tests and docs/BROKERS.md.
 * Fix a failure here with:  node scripts/generate-broker-verification.mjs
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBrokerRegistry } from "./registry.mjs";
import { buildContractMatrix, expectedVerificationFile, spliceVerificationSection } from "./contractMatrix.mjs";
import { LEVEL_ORDER, MANUAL_LEVELS, expectedLevel, isLiveVerified, levelCounts, liveVerifiedBrokers, loadVerification, verificationOf } from "./verification.mjs";
import { VERIFIED_BROKERS } from "../bridge/accounts/brokerInfo.mjs";
import { LIVE_ORDER_MAPPERS } from "../bridge/orders/brokerOrders.mjs";

const file = loadVerification({ fresh: true });
const ids = [...createBrokerRegistry().list()].sort();

describe("verification.json", () => {
  it("lists exactly the registered adapters, each at a known level", () => {
    expect(Object.keys(file.brokers).sort()).toEqual(ids);
    expect(file.levels.map((l) => l.id)).toEqual([...LEVEL_ORDER]);
    for (const [id, rec] of Object.entries(file.brokers)) expect(LEVEL_ORDER, id).toContain(rec.level);
  });

  it("asks for evidence on the levels a person sets: who, and when or why the date is missing", () => {
    for (const [id, rec] of Object.entries(file.brokers)) {
      if (!MANUAL_LEVELS.includes(rec.level)) {
        expect(rec.verifiedBy, id).toBeUndefined();
        continue;
      }
      expect(typeof rec.verifiedBy === "string" && rec.verifiedBy.length > 0, `${id} needs verifiedBy`).toBe(true);
      expect(typeof rec.evidence === "string" && rec.evidence.length > 0, `${id} needs evidence`).toBe(true);
      if (rec.verifiedOn === null) expect(rec.note, `${id}: a null date needs a note`).toMatch(/date/i);
      else expect(rec.verifiedOn, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("is honest today: Dhan is the only live-verified broker", () => {
    expect(liveVerifiedBrokers()).toEqual(["dhan"]);
    expect(isLiveVerified("dhan")).toBe(true);
    expect(isLiveVerified("zerodha")).toBe(false);
    expect(verificationOf("not-a-broker").level).toBe("beta");
  });

  it("feeds everything that shows or enforces verification", () => {
    expect([...VERIFIED_BROKERS]).toEqual(liveVerifiedBrokers());
    for (const [id, mapper] of Object.entries(LIVE_ORDER_MAPPERS)) expect(mapper.liveVerified, id).toBe(isLiveVerified(id));
  });

  it("counts are computed from the file", () => {
    const counts = levelCounts(ids);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(ids.length);
    for (const level of LEVEL_ORDER) expect(counts[level]).toBe(Object.values(file.brokers).filter((r) => r.level === level).length);
  });
});

describe("the record agrees with the code", () => {
  it("every level matches what the contract cases prove, and no broker sits above a missing case", async () => {
    const rows = await buildContractMatrix();
    for (const r of rows) {
      const recorded = file.brokers[r.id].level;
      expect(recorded, `${r.id}: file says ${recorded}, the cases say ${expectedLevel(r, recorded)} (gaps: ${r.gaps.join(", ") || "none"}; failures: ${r.failures.length})`).toBe(expectedLevel(r, recorded));
    }
  });

  it("server/brokers/verification.json is what the generator would write", async () => {
    const rows = await buildContractMatrix();
    expect(`${JSON.stringify(expectedVerificationFile(rows), null, 2)}\n`).toBe(readFileSync(new URL("./verification.json", import.meta.url), "utf-8"));
  });

  it("docs/BROKERS.md carries the generated tables and status cells", async () => {
    const rows = await buildContractMatrix();
    const onDisk = readFileSync(new URL("../../docs/BROKERS.md", import.meta.url), "utf-8");
    expect(spliceVerificationSection(onDisk, rows)).toBe(onDisk);
    expect(onDisk).toContain(`${ids.length} brokers: `); // the count is written by the generator from the registry
  });
});
