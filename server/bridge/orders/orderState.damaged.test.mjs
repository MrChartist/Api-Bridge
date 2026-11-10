/**
 * OPS-04: a damaged orders/state.json (empty after a power cut, garbage, an unknown version) is never silently replaced.
 * It is set aside, paper orders keep working, live orders are refused with ORDER_STATE_DAMAGED until the owner
 * acknowledges, and the refusal survives a restart.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetQuarantined, quarantined } from "../../lib/storageHealth.mjs";
import { buildHarness, liveOrder } from "./__fixtures__/helpers.mjs";
import { DAMAGED_MARKER, createStateFile } from "./stateFile.mjs";

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("damaged order records", () => {
  beforeEach(() => resetQuarantined());

  for (const [label, content] of [
    ["an empty file", ""],
    ["garbage", "{not json"],
    ["an unknown version", JSON.stringify({ version: 99, idempotency: {} })],
  ]) {
    it(`${label}: set aside, paper works, live is refused, a restart still refuses, acknowledging allows it`, async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "mcb-ordstate-"));
      const first = buildHarness({ dataDir });
      await first.svc.place(first.ctx("live"), liveOrder({ clientOrderId: "before-1" })); // writes a good state file
      first.rawSvc.close();
      const stateFile = join(dataDir, "orders", "state.json");
      expect(existsSync(stateFile)).toBe(true);
      writeFileSync(stateFile, content);

      const h = buildHarness({ dataDir });
      // The damaged copy is kept and reported.
      expect(readdirSync(join(dataDir, "orders")).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
      expect(quarantined({ under: dataDir }).some((q) => q.file === stateFile)).toBe(true);
      expect(h.rawSvc.stateDamage()).toMatchObject({ file: stateFile });
      expect(existsSync(join(dataDir, "orders", DAMAGED_MARKER))).toBe(true);

      // Live: refused with a clear code, nothing reaches the broker.
      const e = await reject(h.svc.place(h.ctx("live"), liveOrder({ clientOrderId: "after-1" })));
      expect(e).toMatchObject({ code: "ORDER_STATE_DAMAGED", status: 503 });
      expect(h.zerodha.placed).toHaveLength(0);
      // Paper: keeps working from a fresh state.
      const paper = await h.svc.place(h.ctx("live"), liveOrder({ mode: undefined }));
      expect(paper.order.mode).toBe("paper");
      h.rawSvc.close();

      // A restart: the fresh state file was written, but the refusal must not vanish with the damaged copy.
      const again = buildHarness({ dataDir });
      expect(again.rawSvc.stateDamage()).not.toBeNull();
      expect(await reject(again.svc.place(again.ctx("live"), liveOrder({ clientOrderId: "after-2" })))).toMatchObject({ code: "ORDER_STATE_DAMAGED" });

      // The owner checked the order book and acknowledges.
      expect(again.rawSvc.acknowledgeStateDamage()).toBe(true);
      const ok = await again.svc.place(again.ctx("live"), liveOrder({ clientOrderId: "after-3" }));
      expect(ok.order.mode).toBe("live");
      expect(again.zerodha.placed).toHaveLength(1);
      again.rawSvc.close();
      expect(buildHarness({ dataDir }).rawSvc.stateDamage()).toBeNull();
    });
  }

  it("a good or missing file is not reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-ordstate-"));
    const f = createStateFile(join(dir, "orders", "state.json"));
    expect(f.read()).toBeNull();
    expect(f.damage()).toBeNull();
    expect(f.write({ idempotency: {} })).toBe(true);
    expect(createStateFile(join(dir, "orders", "state.json")).read()).toMatchObject({ version: 1 });
    expect(quarantined({ under: dir })).toEqual([]);
  });

  it("a write that fails reports false and leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-ordstate-"));
    // The parent "folder" is a file, so the write cannot succeed.
    writeFileSync(join(dir, "orders"), "x");
    const f = createStateFile(join(dir, "orders", "state.json"));
    expect(f.write({})).toBe(false);
  });
});
