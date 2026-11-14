/**
 * Offline checks for the macOS / Linux installer scripts (install.sh, start-linux.sh, start-mac.command and
 * scripts/install/*.sh). Nothing here touches the network: the Node.js version pick and checksum check run against
 * local fixture files. Skipped on Windows (no POSIX sh there).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER = join(ROOT, "scripts/install/node-runtime.sh");
const INSTALL = join(ROOT, "install.sh");
const SCRIPTS = [
  "install.sh",
  "start-linux.sh",
  "start-mac.command",
  ...readdirSync(join(ROOT, "scripts/install"))
    .filter((f) => f.endsWith(".sh"))
    .map((f) => `scripts/install/${f}`),
];
const posix = process.platform !== "win32";
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const tmp = posix ? mkdtempSync(join(tmpdir(), "mcb-install-test-")) : "";
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Source the helper in sh and run a snippet; returns { status, stdout, stderr }. */
function helper(snippet, env = {}) {
  const r = spawnSync("sh", ["-c", `. "$1"; ${snippet}`, "sh", HELPER], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

describe.skipIf(!posix)("installer scripts (macOS / Linux)", () => {
  for (const shell of ["sh", "bash", "dash"]) {
    it.skipIf(!has(shell))(`parse with ${shell} -n`, () => {
      for (const f of SCRIPTS) execFileSync(shell, ["-n", join(ROOT, f)], { stdio: "pipe" });
    });
  }

  it("use LF line endings and no tabs-vs-CRLF surprises", () => {
    for (const f of SCRIPTS) expect(readFileSync(join(ROOT, f), "utf8")).not.toContain("\r");
  });

  it("install.sh only defines functions at the top level and calls main on its last line", () => {
    const lines = readFileSync(INSTALL, "utf8").split("\n");
    const code = lines.filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(code.at(-1)).toBe('mcb_main "$@"');
    // Everything at column 0 apart from the last line is a function header or a closing brace: a download cut
    // short anywhere defines functions at most, and runs nothing.
    for (const l of code.slice(0, -1).filter((x) => !/^\s/.test(x))) expect(l).toMatch(/^([a-z_][a-z0-9_]*\(\) \{( .*; \})?|\})$/);
  });

  it("launchers hand over to the shared launcher with this folder as app and settings folder", () => {
    for (const f of ["start-linux.sh", "start-mac.command"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).toMatch(/scripts\/install\/launch\.sh "\$PWD" "\$PWD" "\$@"/);
    }
  });

  it("picks the newest Node.js 22 from a nodejs.org index.json", () => {
    const index = join(tmp, "index.json");
    const entries = ["v23.1.0", "v22.9.0", "v22.10.1", "v22.10.0", "v20.18.0", "v22.2.0"].map((v) => ({ version: v, files: ["linux-x64"], lts: "Jod" }));
    // One entry per line, like nodejs.org, plus a pretty-printed one to show spacing does not matter.
    writeFileSync(index, `[\n${entries.map((e) => JSON.stringify(e)).join(",\n")},\n{ "version": "v22.3.0" }\n]\n`);
    expect(helper(`mcb_pick_node_version "${index}" 22`)).toMatchObject({ status: 0, stdout: "v22.10.1" });
    expect(helper(`mcb_pick_node_version "${index}"`).stdout).toBe("v22.10.1");
    expect(helper(`mcb_pick_node_version "${index}" 24`).status).not.toBe(0);
    expect(helper(`mcb_pick_node_version "${join(tmp, "missing.json")}"`).status).not.toBe(0);
  });

  it("maps uname to nodejs.org download names", () => {
    const cases = [
      ["Linux x86_64", "linux-x64"],
      ["Linux aarch64", "linux-arm64"],
      ["Linux armv7l", "linux-armv7l"],
      ["Darwin arm64", "darwin-arm64"],
      ["Darwin x86_64", "darwin-x64"],
    ];
    for (const [args, want] of cases) expect(helper(`mcb_node_platform ${args}`).stdout).toBe(want);
    expect(helper("mcb_node_platform FreeBSD amd64").status).not.toBe(0);
    expect(helper("mcb_node_platform Linux mips").status).not.toBe(0);
  });

  it.skipIf(!has("sha256sum") && !has("shasum") && !has("openssl"))("checks a download against SHASUMS256.txt", () => {
    const file = join(tmp, "node-v22.0.0-linux-x64.tar.gz");
    writeFileSync(file, "pretend tarball");
    const sum = createHash("sha256").update("pretend tarball").digest("hex");
    const sums = join(tmp, "SHASUMS256.txt");
    writeFileSync(sums, `${"0".repeat(64)}  node-v22.0.0-darwin-x64.tar.gz\n${sum}  node-v22.0.0-linux-x64.tar.gz\n`);
    expect(helper(`mcb_sha256 "${file}"`).stdout).toBe(sum);
    expect(helper(`mcb_verify_sha256 "${file}" "${sums}" node-v22.0.0-linux-x64.tar.gz`).status).toBe(0);
    expect(helper(`mcb_verify_sha256 "${file}" "${sums}" node-v22.0.0-darwin-x64.tar.gz`).status).not.toBe(0);
    expect(helper(`mcb_verify_sha256 "${file}" "${sums}" node-v22.0.0-linux-arm64.tar.gz`).status).not.toBe(0);
  });

  it("reads Node.js major versions and uses a new enough system Node.js without downloading", () => {
    const fake = join(tmp, "oldnode");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "node"), "#!/bin/sh\necho v18.19.0\n");
    chmodSync(join(fake, "node"), 0o755);
    expect(helper(`mcb_node_major "${join(fake, "node")}"`).stdout).toBe("18");
    expect(helper(`mcb_node_major "${join(fake, "nothing")}"`).stdout).toBe("");
    const r = helper(`mcb_ensure_node "${join(tmp, "app")}" && node -v`, { MCB_NODE_DIST: "http://127.0.0.1:9/unreachable" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already on this computer");
    expect(existsSync(join(tmp, "app", "runtime"))).toBe(false);
  });

  it("rejects unknown options and --purge without --uninstall", () => {
    const run = (...args) => spawnSync("sh", [INSTALL, ...args], { encoding: "utf8", env: { ...process.env, HOME: tmp } });
    expect(run("--frobnicate").status).toBe(1);
    expect(run("--frobnicate").stderr).toContain("Unknown option");
    expect(run("--purge").status).toBe(1);
  });

  it("--uninstall removes the program and its shortcuts but keeps settings and data", () => {
    const home = join(tmp, "home");
    const mcb = join(home, ".mc-bridge");
    mkdirSync(join(mcb, "app", "bin"), { recursive: true });
    mkdirSync(join(mcb, "data"), { recursive: true });
    writeFileSync(join(mcb, "bridge.config.json"), "{}\n");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "mc-bridge"), "#!/bin/sh\n# mr-chartist-bridge-shim\n");
    writeFileSync(join(home, ".local", "bin", "other-tool"), "#!/bin/sh\n");
    mkdirSync(join(home, ".local", "share", "applications"), { recursive: true });
    const entry = join(home, ".local", "share", "applications", "mr-chartist-bridge.desktop");
    writeFileSync(entry, "[Desktop Entry]\nComment=Start the Mr. Chartist API Bridge\n");
    const env = { PATH: process.env.PATH, HOME: home };
    const r = spawnSync("sh", [INSTALL, "--uninstall"], { encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(existsSync(join(mcb, "app"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "mc-bridge"))).toBe(false);
    expect(existsSync(entry)).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "other-tool"))).toBe(true);
    expect(existsSync(join(mcb, "bridge.config.json"))).toBe(true);
    expect(r.stdout).toContain("kept in");
    // --purge without a keyboard and without --yes deletes nothing.
    const p = spawnSync("sh", [INSTALL, "--uninstall", "--purge"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    expect(p.status).toBe(1);
    expect(existsSync(join(mcb, "bridge.config.json"))).toBe(true);
    const y = spawnSync("sh", [INSTALL, "--uninstall", "--purge", "--yes"], { encoding: "utf8", env });
    expect(y.status).toBe(0);
    expect(existsSync(mcb)).toBe(false);
  });

  describe("downloads are checked before anything is installed", () => {
    const sha = (buf) => createHash("sha256").update(buf).digest("hex");
    /** A tiny stand-in for the Bridge: enough for the installer to place it, "init" it and make its shortcuts. */
    function fakeBridge(dir, version) {
      mkdirSync(join(dir, "bin"), { recursive: true });
      mkdirSync(join(dir, "scripts", "install"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-bridge", version, private: true }));
      writeFileSync(join(dir, "bin", "mc-bridge.mjs"), `import { writeFileSync } from "node:fs";\nif (process.argv[2] === "init") { writeFileSync("bridge.config.json", "{}"); console.log("fake init"); }\nelse console.log("fake bridge " + process.argv.slice(2).join(" "));\n`);
      writeFileSync(join(dir, "marker.txt"), `version ${version}\n`);
      for (const f of ["node-runtime.sh", "launch.sh"]) writeFileSync(join(dir, "scripts", "install", f), readFileSync(join(ROOT, "scripts", "install", f)));
      return dir;
    }
    /**
     * A folder laid out like the GitHub releases page: latest/download/<files> and download/v<version>/<files>, each
     * version with its source archive (one folder inside, like the real one) and a SHA256SUMS.txt.
     */
    function fakeReleases(root, versions, { newest = versions.at(-1), tamper = [], omit = [] } = {}) {
      const base = join(root, "releases");
      for (const v of versions) {
        const work = join(root, `work-${v}`);
        fakeBridge(join(work, `mr-chartist-bridge-${v}`), v);
        const name = `mr-chartist-bridge-${v}-source.tar.gz`;
        const dir = join(base, "download", `v${v}`);
        mkdirSync(dir, { recursive: true });
        execFileSync("tar", ["-czf", join(dir, name), "-C", work, `mr-chartist-bridge-${v}`]);
        const good = sha(readFileSync(join(dir, name)));
        const lines = [`${"0".repeat(64)}  Mr-Chartist-Bridge-Setup-${v}.exe`, ...(omit.includes(v) ? [] : [`${good}  ${name}`])];
        writeFileSync(join(dir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
        if (tamper.includes(v)) writeFileSync(join(dir, name), Buffer.concat([readFileSync(join(dir, name)), Buffer.from("tampered")]));
        if (v === newest) {
          mkdirSync(join(base, "latest", "download"), { recursive: true });
          writeFileSync(join(base, "latest", "download", "SHA256SUMS.txt"), readFileSync(join(dir, "SHA256SUMS.txt")));
        }
      }
      return base;
    }
    function install(root, base, args = [], extra = {}) {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const env = { PATH: process.env.PATH, HOME: home, MCB_RELEASE_BASE: base, MCB_TEST_OS: "linux", MCB_NODE_DIST: "http://127.0.0.1:9/never", npm_config_cache: join(root, "npm-cache"), ...extra };
      const r = spawnSync("sh", [INSTALL, "--no-start", ...args], { encoding: "utf8", env, timeout: 120_000 });
      return { ...r, home, app: join(home, ".mc-bridge", "app"), out: r.stdout + r.stderr };
    }
    const fresh = () => mkdtempSync(join(tmp, "rel-"));

    it("takes the newest release, checks its SHA-256 against SHA256SUMS.txt and installs it", () => {
      const root = fresh();
      const base = fakeReleases(root, ["1.0.0", "1.1.0"]);
      const r = install(root, base);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/The newest release/);
      expect(r.out).toMatch(/That is v1\.1\.0/);
      expect(r.out).toMatch(/Checked: the SHA-256 matches/);
      expect(readFileSync(join(r.app, "marker.txt"), "utf8")).toBe("version 1.1.0\n");
    }, 150_000);

    it("--version (and MCB_VERSION) picks that release, with or without a leading v", () => {
      const root = fresh();
      const base = fakeReleases(root, ["1.0.0", "1.1.0"]);
      const r = install(root, base, ["--version", "v1.0.0"]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/Release v1\.0\.0/);
      expect(readFileSync(join(r.app, "marker.txt"), "utf8")).toBe("version 1.0.0\n");
      const root2 = fresh();
      const r2 = install(root2, fakeReleases(root2, ["1.0.0", "1.1.0"]), [], { MCB_VERSION: "1.0.0" });
      expect(r2.status, r2.out).toBe(0);
      expect(readFileSync(join(r2.app, "marker.txt"), "utf8")).toBe("version 1.0.0\n");
      const root3 = fresh();
      const r3 = install(root3, fakeReleases(root3, ["1.0.0"]), ["--version=1.0.0"]);
      expect(r3.status, r3.out).toBe(0);
    }, 300_000);

    it("a download that does not match its published checksum is refused with a plain message and nothing is installed", () => {
      const root = fresh();
      const base = fakeReleases(root, ["1.0.0"], { tamper: ["1.0.0"] });
      const r = install(root, base);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/STOPPED: The Bridge download does not match its published checksum, so it was NOT installed/);
      expect(r.out).toMatch(/expected SHA-256: [0-9a-f]{64}/);
      expect(r.out).toMatch(/Nothing on this computer was changed/);
      expect(existsSync(r.app)).toBe(false);
      expect(existsSync(join(r.home, ".mc-bridge", "app.new"))).toBe(false);
      expect(existsSync(join(r.home, ".local", "bin", "mc-bridge"))).toBe(false);
    });

    it("an upgrade that fails the check leaves the installed version exactly as it was", () => {
      const root = fresh();
      const good = install(root, fakeReleases(root, ["1.0.0"]));
      expect(good.status, good.out).toBe(0);
      const root2 = fresh();
      const base2 = fakeReleases(root2, ["1.1.0"], { tamper: ["1.1.0"] });
      const bad = spawnSync("sh", [INSTALL, "--no-start"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: good.home, MCB_RELEASE_BASE: base2, MCB_TEST_OS: "linux" } });
      expect(bad.status).toBe(1);
      expect(readFileSync(join(good.app, "marker.txt"), "utf8")).toBe("version 1.0.0\n");
    }, 150_000);

    it("refuses a release whose checksum list does not name the download, or that has no list", () => {
      const root = fresh();
      const r = install(root, fakeReleases(root, ["1.0.0"], { omit: ["1.0.0"] }), ["--version", "1.0.0"]);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/does not name mr-chartist-bridge-1\.0\.0-source\.tar\.gz, so it cannot be checked/);
      const root2 = fresh();
      const r2 = install(root2, fakeReleases(root2, ["1.0.0"]), ["--version", "9.9.9"]);
      expect(r2.status).toBe(1);
      expect(r2.out).toMatch(/Could not download the list of checksums/);
      expect(existsSync(r2.app)).toBe(false);
    });

    it("--sha256 must agree with the published list: a different value stops the install", () => {
      const root = fresh();
      const base = fakeReleases(root, ["1.0.0"]);
      const real = readFileSync(join(base, "download", "v1.0.0", "SHA256SUMS.txt"), "utf8").split("\n").find((l) => l.endsWith("-source.tar.gz")).slice(0, 64);
      const ok = install(root, base, ["--sha256", real.toUpperCase()]);
      expect(ok.status, ok.out).toBe(0);
      const root2 = fresh();
      const bad = install(root2, fakeReleases(root2, ["1.0.0"]), ["--sha256", "a".repeat(64)]);
      expect(bad.status).toBe(1);
      expect(bad.out).toMatch(/the checksum you gave with --sha256 is not the one the release publishes/);
      expect(existsSync(bad.app)).toBe(false);
    }, 150_000);

    it("a web address as MCB_SOURCE needs a checksum; a local file is checked when one is given", () => {
      const root = fresh();
      const url = install(root, "x", [], { MCB_SOURCE: "http://127.0.0.1:9/bridge.tar.gz" });
      expect(url.status).toBe(1);
      expect(url.out).toMatch(/needs the expected checksum too/);
      const base = fakeReleases(root, ["1.0.0"]);
      const file = join(base, "download", "v1.0.0", "mr-chartist-bridge-1.0.0-source.tar.gz");
      const wrong = install(root, "x", ["--sha256", "b".repeat(64)], { MCB_SOURCE: file });
      expect(wrong.status).toBe(1);
      expect(wrong.out).toMatch(/does not match its published checksum/);
      expect(existsSync(wrong.app)).toBe(false);
    });

    it("rejects a malformed --version or --sha256, and the old MCB_REF", () => {
      const run = (args, env = {}) => spawnSync("sh", [INSTALL, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp, ...env } });
      expect(run(["--version", "latest"]).stderr).toMatch(/--version must be a release number/);
      expect(run(["--version"]).stderr).toMatch(/--version needs a number/);
      expect(run(["--sha256", "abc"]).stderr).toMatch(/exactly 64 hexadecimal/);
      expect(run(["--no-start"], { MCB_REF: "main", MCB_SOURCE: ROOT }).stderr).toMatch(/MCB_REF is not used any more/);
    });

    it("no longer fetches the main branch: the only source is a release, and the script names its checks", () => {
      const src = readFileSync(INSTALL, "utf8");
      expect(src).not.toMatch(/codeload\.github\.com|refs\/heads\/main|raw\.githubusercontent\.com/);
      expect(src).toMatch(/releases\/latest\/download\/install\.sh/);
      expect(src).toMatch(/SHA256SUMS\.txt/);
      expect(src).toContain("mcb_check_sha");
      expect(src).toContain("--version");
    });

    it("the help text lists --version and --sha256", () => {
      const r = spawnSync("sh", [INSTALL, "--help"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp } });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/--version <number>/);
      expect(r.stdout).toMatch(/--sha256 <hex>/);
    });
  });

  it("macOS: makes an app bundle in ~/Applications and never writes to the Desktop", () => {
    const src = readFileSync(INSTALL, "utf8");
    for (const key of ["CFBundleName", "CFBundleDisplayName", "CFBundleIdentifier", "CFBundleExecutable", "CFBundlePackageType"]) expect(src).toContain(`<key>${key}</key>`);
    expect(src).toContain('MAC_APP="$HOME/Applications/Mr Chartist Bridge.app"');
    expect(src).toContain("/usr/bin/open -a Terminal");
    const mac = src.slice(src.indexOf("mcb_make_mac_shortcuts() {"), src.indexOf("mcb_make_mac_icon() {"));
    expect(mac).not.toMatch(/mcb_desktop_dir|Desktop"/);
  });

  it("macOS --uninstall removes the app bundle and an old .command launcher, but not someone else's app", () => {
    const home = join(tmp, "machome");
    const apps = join(home, "Applications");
    const bundle = join(apps, "Mr Chartist Bridge.app", "Contents", "MacOS");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "mr-chartist-bridge"), "#!/bin/sh\n# Made by the Mr. Chartist API Bridge installer.\n");
    writeFileSync(join(apps, "Mr Chartist Bridge.command"), "#!/bin/sh\n# Double-click to start the Mr. Chartist API Bridge. Made by its installer.\n");
    mkdirSync(join(apps, "Other.app", "Contents"), { recursive: true });
    const r = spawnSync("sh", [INSTALL, "--uninstall"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, MCB_TEST_OS: "mac" } });
    expect(r.status).toBe(0);
    expect(existsSync(join(apps, "Mr Chartist Bridge.app"))).toBe(false);
    expect(existsSync(join(apps, "Mr Chartist Bridge.command"))).toBe(false);
    expect(existsSync(join(apps, "Other.app"))).toBe(true);
    // An app of the same name that the installer did not make is left alone.
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "mr-chartist-bridge"), "#!/bin/sh\necho someone else\n");
    spawnSync("sh", [INSTALL, "--uninstall"], { env: { PATH: process.env.PATH, HOME: home, MCB_TEST_OS: "mac" } });
    expect(existsSync(join(bundle, "mr-chartist-bridge"))).toBe(true);
  });

  it("refuses an MCB_HOME that is the home folder itself", () => {
    const r = spawnSync("sh", [INSTALL, "--uninstall", "--purge", "--yes"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp, MCB_HOME: tmp } });
    expect(r.status).toBe(1);
    expect(existsSync(tmp)).toBe(true);
  });

  it("Android (Termux): Node.js from pkg (never nodejs.org), the command in Termux's bin, a Termux:Widget shortcut", () => {
    const home = join(tmp, "android-home");
    const prefix = join(tmp, "android-prefix");
    const tools = join(tmp, "android-tools");
    for (const d of [home, join(prefix, "bin"), tools]) mkdirSync(d, { recursive: true });
    // A stand-in for Termux's package manager: "installs" Node.js by linking this machine's node into $PREFIX/bin, with a fake npm
    // beside it. The fake records what the installer asked for and links this checkout's node_modules: the real npm would fetch the
    // Bridge's parts from the registry, and a test must never need the network (it failed after minutes on an offline machine).
    const npmLog = join(tmp, "android-npm.log");
    writeFileSync(join(tools, "pkg"), `#!/bin/sh\necho "pkg $*" >> "${join(tmp, "android-pkg.log")}"\nln -sf "${process.execPath}" "${join(prefix, "bin", "node")}"\ncp "${join(tools, "npm")}" "${join(prefix, "bin", "npm")}"\n`);
    writeFileSync(join(tools, "npm"), `#!/bin/sh\necho "npm $* (in $PWD)" >> "${npmLog}"\ncase "$1" in\n  ci|install) ln -s "${ROOT}/node_modules" node_modules ;;\n  *) echo "fake npm: $*" >&2; exit 1 ;;\nesac\n`);
    chmodSync(join(tools, "pkg"), 0o755);
    chmodSync(join(tools, "npm"), 0o755);
    const env = { HOME: home, PREFIX: prefix, PATH: `${join(prefix, "bin")}:${tools}:/usr/bin:/bin`, MCB_TEST_OS: "android", MCB_SOURCE: ROOT, MCB_NODE_DIST: "http://127.0.0.1:9/never", npm_config_cache: join(tmp, "npm-cache") };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "npm_config_registry"]) if (process.env[k]) env[k] = process.env[k];
    const r = spawnSync("sh", [INSTALL, "--no-start"], { encoding: "utf8", env, timeout: 240_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Installing Node.js with Termux's package manager/);
    expect(r.stdout).not.toMatch(/Downloading Node.js/);
    expect(readFileSync(join(tmp, "android-pkg.log"), "utf8")).toMatch(/install -y nodejs-lts/);
    expect(readFileSync(npmLog, "utf8")).toMatch(/^npm ci --omit=dev /m); // the parts were "installed" by the fake, not fetched
    expect(existsSync(join(prefix, "bin", "mc-bridge"))).toBe(true); // already on Termux's PATH
    const shortcut = join(home, ".shortcuts", "Mr Chartist Bridge");
    expect(readFileSync(shortcut, "utf8")).toMatch(/launch\.sh/);
    expect(existsSync(join(home, ".local", "share", "applications"))).toBe(false); // no Linux desktop entries on Android
    const u = spawnSync("sh", [INSTALL, "--uninstall"], { encoding: "utf8", env });
    expect(u.status, u.stdout + u.stderr).toBe(0);
    expect(existsSync(shortcut)).toBe(false);
    expect(existsSync(join(prefix, "bin", "mc-bridge"))).toBe(false);
  }, 300_000);
});
