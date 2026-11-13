import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAC_APP_NAME, TARGETS, buildMacApp, macAppPlist, macAppReadMe, pickNode, readMe, shipped } from "./build-bundles.mjs";

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

  it("leaves the announcement video out of every download", () => {
    expect(shipped("docs/media/announcement.mp4")).toBe(false);
    expect(shipped("docs/guides/webhooks.md")).toBe(true);
  });
});

describe("the Mac app", () => {
  const stageApp = () => {
    const work = mkdtempSync(join(tmpdir(), "mcb-macapp-"));
    const from = join(work, "bridge");
    mkdirSync(join(from, "scripts/install"), { recursive: true });
    mkdirSync(join(from, "bin"), { recursive: true });
    writeFileSync(join(from, "bin/mc-bridge.mjs"), "// stand-in\n");
    // A stand-in launcher that reports what it was given, so the app's own two scripts can be run here.
    writeFileSync(join(from, "scripts/install/launch.sh"), 'printf "%s|%s|%s|%s\\n" "$1" "$2" "$3" "$MCB_CACHE_DIR"\n');
    const app = buildMacApp({ from, stage: join(work, "out"), version: "2.3.4" });
    return { work, app };
  };

  it("is a real application bundle: Info.plist, an executable, the icon, and the Bridge inside", () => {
    const { app } = stageApp();
    expect(app.endsWith(`${MAC_APP_NAME}.app`)).toBe(true);
    const plist = readFileSync(join(app, "Contents/Info.plist"), "utf8");
    expect(plist).toBe(macAppPlist("2.3.4"));
    for (const key of ["CFBundleExecutable</key><string>mr-chartist-bridge", "CFBundleIdentifier</key><string>com.mrchartist.bridge", "CFBundlePackageType</key><string>APPL", "CFBundleShortVersionString</key><string>2.3.4", "CFBundleIconFile</key><string>AppIcon"]) expect(plist).toContain(key);
    expect(macAppPlist("not a version")).toContain("<string>0.0.0</string>");
    for (const f of ["Contents/MacOS/mr-chartist-bridge", "Contents/Resources/launch.command"]) expect(statSync(join(app, f)).mode & 0o111, f).toBe(0o111);
    expect(readFileSync(join(app, "Contents/Resources/AppIcon.icns")).subarray(0, 4).toString("latin1")).toBe("icns");
    expect(existsSync(join(app, "Contents/Resources/app/bin/mc-bridge.mjs"))).toBe(true);
    expect(readFileSync(join(app, "Contents/PkgInfo"), "utf8")).toBe("APPL????");
  });

  it("starts the Bridge that is inside it, with settings in ~/.mc-bridge and nothing written into the app", () => {
    const { work, app } = stageApp();
    const home = join(work, "home with space");
    mkdirSync(home);
    const out = execFileSync("/bin/sh", [join(app, "Contents/Resources/launch.command"), "--demo"], { env: { ...process.env, HOME: home }, encoding: "utf8" }).trim();
    expect(out).toBe(`${join(app, "Contents/Resources/app")}|${join(home, ".mc-bridge")}|--demo|${join(home, ".mc-bridge", "cache")}`);
    // The app's executable hands that launcher to Terminal by its full path, wherever the app was put.
    expect(readFileSync(join(app, "Contents/MacOS/mr-chartist-bridge"), "utf8")).toContain('open -a Terminal "$(cd "$(dirname "$0")/../Resources" && pwd)/launch.command"');
  });

  it("tells people how to open an app macOS cannot check, and where their settings live", () => {
    const note = macAppReadMe("2.3.4", "v22.1.0");
    expect(note).toMatch(/Open Anyway/);
    expect(note).toContain(".mc-bridge");
    expect(note).toContain("not signed");
  });
});
