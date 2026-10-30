/**
 * A strategy run's key is found and revoked at the next start even when the strategies state file cannot be read:
 * the keys are marked in the key store (purpose "strategy-run"), not only listed in that file.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeKeyStore } from "../auth/fake.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createStrategyRunner } from "./runner.mjs";

describe("strategy run keys at startup", () => {
  it("revokes every active strategy-run key even when state.json is corrupt (kept aside); other keys are untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcb-strat-keys-"));
    const dataDir = join(home, "data");
    mkdirSync(join(dataDir, "strategies"), { recursive: true });
    const keyStore = createFakeKeyStore();
    // Two runs that never ended cleanly (the Bridge itself crashed), one script key, one already revoked run key.
    const runA = await keyStore.create({ label: "Algo a", scopes: ["paper"], accounts: ["paper"], clientKind: "script" }, { purpose: "strategy-run" });
    const runB = await keyStore.create({ label: "Algo b", scopes: ["live"], accounts: ["paper"], clientKind: "script" }, { purpose: "strategy-run" });
    const old = await keyStore.create({ label: "Algo c", scopes: ["paper"], accounts: ["paper"], clientKind: "script" }, { purpose: "strategy-run" });
    await keyStore.revoke(old.record.id);
    const script = await keyStore.create({ label: "my script", scopes: ["paper"], clientKind: "script" });
    // The state file that listed them is cut short.
    writeFileSync(join(dataDir, "strategies", "state.json"), '{"version":1,"settings":{},"keys":["');
    const runner = createStrategyRunner({ config: { dataDir }, logger: createNullLogger(), paths: { dataDir, root: home }, keyStore }, { dir: join(home, "strategies") });
    try {
      await runner.revokeOrphans();
      expect((await keyStore.get(runA.record.id)).revokedAt).not.toBeNull();
      expect((await keyStore.get(runB.record.id)).revokedAt).not.toBeNull();
      expect((await keyStore.get(script.record.id)).revokedAt).toBeNull();
      // The unreadable file was kept aside (state.json.corrupt-<ms>), not overwritten by the saves above.
      const dir = join(dataDir, "strategies");
      const kept = readdirSync(dir).filter((f) => /^state\.json\.corrupt-\d+$/.test(f));
      expect(kept).toHaveLength(1);
      expect(readFileSync(join(dir, kept[0]), "utf8")).toBe('{"version":1,"settings":{},"keys":["');
      expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))).toMatchObject({ version: 1 });
    } finally {
      await runner.close();
    }
  });
});
