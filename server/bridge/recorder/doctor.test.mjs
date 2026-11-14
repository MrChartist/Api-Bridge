import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recorderDoctorChecks } from "./doctor.mjs";

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
function setup({ settings, rules, config = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-rec-doctor-"));
  dirs.push(dataDir);
  mkdirSync(join(dataDir, "recordings"));
  if (settings !== undefined) writeFileSync(join(dataDir, "recordings", "settings.json"), JSON.stringify(settings));
  if (rules !== undefined) writeFileSync(join(dataDir, "recordings", "rules.json"), JSON.stringify({ rules }));
  return { dataDir, recorder: { enabled: true, maxDiskMb: 5000, autoRecord: { enabled: false, rules: [] }, ...config } };
}
const auto = (config) => recorderDoctorChecks({ config }).find((c) => c.check === "auto-record").message;

describe("doctor: auto-record", () => {
  it("reads the switch the person saved, not only the config default (it said off while it was on)", () => {
    const config = setup({ settings: { autoRecord: { enabled: true } }, rules: [{ id: "rule-index-chains" }] });
    expect(auto(config)).toBe("Auto-record is on (1 rule)");
  });

  it("a saved off wins over a config that says on, and no saved switch falls back to the config", () => {
    expect(auto(setup({ settings: { autoRecord: { enabled: false } }, config: { autoRecord: { enabled: true, rules: [] } } }))).toMatch(/^Auto-record is off/);
    expect(auto(setup({ config: { autoRecord: { enabled: true, rules: [{ id: "a" }, { id: "b" }] } } }))).toBe("Auto-record is on (2 rules)");
    expect(auto(setup())).toMatch(/^Auto-record is off/);
  });

  it("a damaged settings file counts as no saved switch", () => {
    const config = setup();
    writeFileSync(join(config.dataDir, "recordings", "settings.json"), "{not json");
    expect(auto(config)).toMatch(/^Auto-record is off/);
  });
});
