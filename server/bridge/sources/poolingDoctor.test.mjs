/** `mc-bridge doctor` shows the pooling checks, and still creates nothing. */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../core/cli.mjs";
import { loadConfig } from "../core/config.mjs";
import { POOLING_NOTICE_VERSION, writeConsentRecord } from "./pooling.mjs";

const OPT = { pooling: true, poolingWhenTermsUnknown: true };
const doctor = async (accounts, dataDir) => {
  const { config } = loadConfig({ raw: { dataDir, accounts }, env: {} });
  return (await runDoctor({ config, env: {}, portCheck: false })).filter((c) => c.check === "pooling");
};

describe("mc-bridge doctor: pooling", () => {
  it("is ok and creates nothing when no account pools", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "mcb-pdoc-")), "data");
    const checks = await doctor([{ id: "dhan-main", broker: "dhan", holder: "self" }], dataDir);
    expect(checks).toEqual([{ level: "ok", check: "pooling", message: "Pooling is off (no account opts in)" }]);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("warns about a pooled account without consent, a paid data plan and different holders", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "mcb-pdoc-")), "data");
    const checks = await doctor(
      [
        { id: "dhan-main", broker: "dhan", holder: "self", marketData: OPT },
        { id: "zerodha-main", broker: "zerodha", holder: "spouse", marketData: OPT },
      ],
      dataDir,
    );
    expect(checks.every((c) => c.level === "warn")).toBe(true);
    const text = checks.map((c) => c.message).join("\n");
    expect(text).toMatch(/dhan-main, zerodha-main are set to pool market data but you have not given consent/);
    expect(text).toMatch(/different holders \(self, spouse\)/);
    expect(text).toMatch(/dhan-main \(dhan\) needs a paid data plan/);
    expect(text).toMatch(/zerodha-main \(zerodha\) needs a paid data plan/);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("is ok when the consent covers every pooled account and no plan is paid", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-pdoc-"));
    writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T09:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["upstox-a", "upstox-b"] });
    const checks = await doctor([{ id: "upstox-a", broker: "upstox", holder: "self", marketData: OPT }, { id: "upstox-b", broker: "upstox", holder: "self", marketData: OPT }], dataDir);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ level: "ok", message: expect.stringMatching(/2 account\(s\) pool market data under the consent given/) });
  });
});
