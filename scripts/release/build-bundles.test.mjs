import { describe, expect, it } from "vitest";
import { TARGETS, pickNode, readMe, shipped } from "./build-bundles.mjs";

describe("ready-to-run downloads", () => {
  it("ships the app but not tests, fixtures, CI, screenshots or deploy kits", () => {
    for (const f of ["bin/mc-bridge.mjs", "server/bridge/core/app.mjs", "start-windows.bat", "start-mac.command", "start-linux.sh", "scripts/install/launch.sh", "README.md", "docs/guides/safety.md"]) expect(shipped(f)).toBe(true);
    for (const f of ["server/bridge/core/app.test.mjs", "server/brokers/__fixtures__/dhan/x.json", ".github/workflows/ci.yml", "docs/screenshots/home-dark.webp", "deploy/hostinger/Caddyfile", "Dockerfile", "scripts/release/build-bundles.mjs", "test/pinDate.mjs"]) {
      expect(shipped(f)).toBe(false);
    }
  });

  it("picks the newest Node.js 22 from nodejs.org's index", () => {
    const index = [{ version: "v24.1.0" }, { version: "v22.9.0" }, { version: "v22.23.4" }, { version: "v22.23.10" }, { version: "v20.19.0" }];
    expect(pickNode(index)).toBe("v22.23.10");
    expect(() => pickNode([{ version: "v20.1.0" }])).toThrow(/no Node.js 22/);
  });

  it("covers Windows, both Macs and both Linux machines, each with its double-click launcher", () => {
    expect(TARGETS.map((t) => t.id)).toEqual(["windows-x64", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64"]);
    for (const t of TARGETS) {
      const note = readMe(t, "1.2.3", "v22.0.0");
      expect(note).toContain(t.launcher);
      expect(note).toContain("already signed in");
    }
    expect(readMe(TARGETS[0], "1", "v22").split("\r\n").length).toBeGreaterThan(5); // Notepad-friendly line ends
    expect(readMe(TARGETS[1], "1", "v22")).toMatch(/Open Anyway/);
  });
});
