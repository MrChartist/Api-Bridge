/**
 * Checks for the Windows installer scripts (install.ps1, start-windows.bat, scripts/install/*.ps1).
 * The static checks always run. The rest needs PowerShell (pwsh, or MCB_PWSH=<path to pwsh>) and is skipped without
 * it; it runs fully offline: the Node.js version pick reads fixture JSON, the download + SHA-256 check and install.ps1
 * read from a local HTTP server and a fake Bridge folder. Two opt-in groups go further:
 *   MCB_INSTALL_E2E=1      install.ps1 dry run from a copy of this repository (npm ci needs the npm registry)
 *   MCB_NETWORK_TESTS=1    download the real win-x64 Node.js zip from nodejs.org and check its SHA-256
 * Windows-only steps (shortcuts, user PATH) are skipped by the scripts themselves when not on Windows.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER = join(ROOT, "scripts/install/node-runtime.ps1");
const LAUNCHER = join(ROOT, "scripts/install/launch-windows.ps1");
const INSTALL = join(ROOT, "install.ps1");
const BAT = join(ROOT, "start-windows.bat");
const PS_FILES = ["install.ps1", "scripts/install/node-runtime.ps1", "scripts/install/launch-windows.ps1"];
const WINDOWS_FILES = [...PS_FILES, "start-windows.bat"];
const read = (f) => readFileSync(join(ROOT, f), "utf8");

function findPwsh() {
  const candidates = [process.env.MCB_PWSH, "pwsh", process.platform === "win32" ? "powershell" : null].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (r.status === 0 && /^\d+/.test(r.stdout.trim())) return c;
  }
  return null;
}
const PWSH = findPwsh();
const onWindows = process.platform === "win32";

/** Environment for child processes: no proxies (only 127.0.0.1 is used), node first on PATH, npm kept offline. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(MCB_|npm_)/i.test(k) && k !== "MCB_PWSH") delete env[k];
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? env.Path ?? ""}`;
  env.npm_config_update_notifier = "false";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.NO_PROXY = `127.0.0.1,localhost${env.NO_PROXY ? `,${env.NO_PROXY}` : ""}`;
  env.no_proxy = env.NO_PROXY;
  return { ...env, ...extra };
}

/** Run PowerShell without blocking the event loop (the local HTTP server must keep answering). */
function pwsh(args, { env = {}, input = "", cwd = ROOT } = {}) {
  return new Promise((done, fail) => {
    const p = spawn(PWSH, ["-NoProfile", ...args], { cwd, env: childEnv(env) });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", fail);
    p.on("close", (status) => done({ status, stdout, stderr, out: stdout + stderr }));
    p.stdin.end(input);
  });
}
/** Dot-source node-runtime.ps1 and run a snippet. */
const helper = (snippet, opts) => pwsh(["-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; . '${HELPER}'; ${snippet}`], opts);

/** Remove comments and string literals so operator checks see only code. Good enough for these files. */
function codeOnly(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "'") {
      i++;
      while (i < src.length && !(src[i] === "'" && src[i + 1] !== "'")) i += src[i] === "'" ? 2 : 1;
      out += "''";
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "`" ? 2 : 1;
      out += '""';
    } else out += c;
  }
  return out;
}

describe("Windows installer files (static)", () => {
  it("exist", () => {
    for (const f of WINDOWS_FILES) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  it(".gitattributes keeps CRLF for .bat, .cmd and .ps1", () => {
    const attrs = read(".gitattributes");
    for (const ext of ["bat", "cmd", "ps1"]) expect(attrs).toMatch(new RegExp(`^\\*\\.${ext}\\s+text\\s+eol=crlf\\s*$`, "m"));
  });

  it("use CRLF line endings (cmd.exe misreads labels and blocks in LF batch files)", () => {
    for (const f of WINDOWS_FILES) {
      const s = read(f);
      expect(s.includes("\n"), f).toBe(true);
      expect(/(^|[^\r])\n/.test(s), `${f} has a line ending without CR`).toBe(false);
    }
  });

  it("are plain ASCII (Windows PowerShell 5.1 reads files without a BOM as ANSI)", () => {
    for (const f of WINDOWS_FILES) expect(/[^\x00-\x7f]/.test(read(f)), f).toBe(false);
  });

  it("use no PowerShell 7-only syntax or parameters", () => {
    for (const f of PS_FILES) {
      const code = codeOnly(read(f));
      expect(code, f).not.toMatch(/\?\?|\?\.|\?\[|&&|\|\||\s\?\s/);
      expect(code, f).not.toMatch(/-AdditionalChildPath|-Parallel\b|-SkipCertificateCheck|Join-String|ConvertFrom-Json\s+-AsHashtable|-NoProxy\b/i);
      // $IsWindows exists only on PowerShell 6+, so every file that reads it checks the version first.
      if (/\$IsWindows/.test(code)) expect(code, f).toMatch(/PSVersion\.Major -(lt|ge) 6/);
    }
  });

  it("install.ps1 is one function called on its last line, with no top-level param block", () => {
    const lines = read("install.ps1").split(/\r?\n/);
    const code = lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    expect(code.at(-1)).toBe("Install-McBridge -ExitOnFailure:([bool]$MyInvocation.MyCommand.Path) @args");
    // At column 0 there is only the function header, its closing brace and the call: a download cut short runs nothing.
    expect(code.filter((l) => !/^\s/.test(l))).toEqual(["function Install-McBridge {", "}", code.at(-1)]);
    // exit only when run as a file; under irm | iex an exit would close the user's PowerShell window.
    for (const l of code.filter((x) => /\bexit\b/.test(x))) expect(l).toMatch(/if \(\$ExitOnFailure\) \{ exit 1 \}/);
  });

  it("node-runtime.ps1 only defines functions, so dot-sourcing it runs nothing", () => {
    const code = read("scripts/install/node-runtime.ps1").split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    for (const l of code.filter((x) => !/^\s/.test(x))) expect(l).toMatch(/^(function [A-Z][A-Za-z]+-Mcb[A-Za-z0-9]+( ?\(.*\))? \{.*|\})$/);
    for (const fn of ["Initialize-McbNode", "Select-McbNodeRelease", "Save-McbNodeArchive", "Install-McbNodeRuntime", "Install-McbPackages", "Initialize-McbConfig", "Start-McbBridge"]) {
      expect(code.join("\n")).toContain(`function ${fn}`);
    }
  });

  it("downloads only over HTTPS from nodejs.org and GitHub, and checks the Node.js SHA-256", () => {
    for (const f of PS_FILES) for (const url of read(f).match(/https?:\/\/[^\s'"`)]+/g) ?? []) expect(url, f).toMatch(/^https:\/\/(nodejs\.org|codeload\.github\.com|raw\.githubusercontent\.com|github\.com)\//);
    const h = read("scripts/install/node-runtime.ps1");
    expect(h).toContain("SHASUMS256.txt");
    expect(h).toMatch(/Get-FileHash -LiteralPath \$archive -Algorithm SHA256/);
    expect(h).toContain("Tls12");
  });

  it("install.ps1 installs released versions only, and checks the download before unpacking it", () => {
    const s = read("install.ps1");
    expect(s).not.toMatch(/codeload\.github\.com|refs\/heads|raw\.githubusercontent\.com\/[^\s]*\/main\//);
    expect(s).toContain("/releases/latest/download/install.ps1");
    expect(s).toContain("SHA256SUMS.txt");
    expect(s).toContain("Get-FileHash -LiteralPath $Path -Algorithm SHA256");
    expect(s).toContain("-source.zip");
    for (const w of ["[string]$Version", "[string]$Sha256", "MCB_VERSION", "MCB_SHA256", "MCB_RELEASE_BASE"]) expect(s, w).toContain(w);
    // the check comes before the unpack, on every route that downloads
    const dl = s.slice(s.indexOf("# A released version, checked"), s.indexOf("# A release ZIP holds one folder"));
    for (const part of dl.split("} elseif").slice(0, 2)) expect(part.indexOf("Confirm-McbDownload")).toBeGreaterThan(-1);
    expect(dl.indexOf("Confirm-McbDownload $zip $expected")).toBeLessThan(dl.indexOf("Expand-McbArchive $zip $unpacked"));
    expect(s).toContain("does not match its published checksum, so it was NOT installed");
    expect(s).toContain("needs the expected checksum too");
  });

  it("install.ps1 changes only per-user places (no admin rights)", () => {
    const s = read("install.ps1");
    expect(s).not.toMatch(/RunAs|HKLM:|LocalMachine|'Machine'|ProgramFiles|Set-ExecutionPolicy/i);
    expect(s).toContain("[Microsoft.Win32.Registry]::CurrentUser");
    expect(s).toContain("LOCALAPPDATA");
    expect(s).toContain("WScript.Shell");
  });

  it("the installed mc-bridge command and shortcut name the command mc-bridge in hints; the ZIP launcher does not", () => {
    const s = read("install.ps1");
    expect(s).toContain(`'set "MCB_CLI_NAME=mc-bridge"',`);
    expect(s).toContain('-File `"$launcher`" -Pause -CliName mc-bridge"');
    expect(read("start-windows.bat")).not.toContain("MCB_CLI_NAME");
  });

  it("start-windows.bat hands over to the PowerShell launcher safely from any folder", () => {
    const s = read("start-windows.bat");
    expect(s).toMatch(/^@echo off\r\n/);
    expect(s).toContain('cd /d "%~dp0"');
    expect(s).toMatch(/-NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install\\launch-windows\.ps1" -AppDir "%~dp0\." -ConfigDir "%~dp0\."/);
    // "%~dp0" ends in a backslash, which would escape a closing quote on the PowerShell command line.
    for (const l of s.split("\r\n").filter((x) => /powershell|MCB_PS%/i.test(x) && !/^rem /.test(x))) expect(l).not.toMatch(/%~dp0"/);
    // No ( ) blocks: a folder name with a bracket in it would end the block early.
    expect(s).not.toMatch(/\(\s*\r\n/);
    expect(s).toMatch(/if not exist "%~dp0package\.json" goto notextracted/);
    expect(s).toContain("pause");
    expect(existsSync(join(ROOT, "scripts/install/launch-windows.ps1"))).toBe(true);
  });
});

describe.skipIf(!PWSH)("Windows installer scripts (PowerShell, offline)", () => {
  let tmp;
  let server;
  let base;
  const routes = new Map();
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "mcb-win-test-"));
    server = createServer((req, res) => {
      const body = routes.get(req.url);
      if (body === undefined) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("every .ps1 parses with the PowerShell parser and has no PowerShell 7-only tokens", async () => {
    const files = PS_FILES.map((f) => `'${join(ROOT, f)}'`).join(",");
    const r = await pwsh(["-NonInteractive", "-Command", `
      $bad = 'QuestionQuestion','QuestionQuestionEquals','QuestionDot','QuestionLBracket','AndAnd','OrOr','QuestionMark'
      foreach ($f in @(${files})) {
        $tokens = $null; $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
        foreach ($e in $errors) { "PARSE $f $($e.Extent.StartLineNumber): $($e.Message)" }
        foreach ($t in $tokens) { if ($bad -contains [string]$t.Kind) { "PS7 $f $($t.Extent.StartLineNumber): $($t.Text)" } }
      }
      'checked'`]);
    expect(r.stdout.trim()).toBe("checked");
  });

  it("picks the newest Node.js 22 that has a build for this computer", async () => {
    const index = [
      { version: "v24.1.0", files: ["win-x64-zip", "win-arm64-zip"] },
      { version: "v22.22.0", files: ["linux-x64", "osx-arm64-tar"] },
      { version: "v22.10.2", files: ["win-x64-zip", "win-arm64-zip"] },
      { version: "v22.9.0", files: ["win-x64-zip", "win-arm64-zip"] },
      { version: "v22.21.1", files: ["win-x64-zip"] },
      { version: "v21.7.3", files: ["win-x64-zip"] },
    ];
    const idx = join(tmp, "index.json");
    writeFileSync(idx, JSON.stringify(index));
    const r = await helper(`
      Select-McbNodeRelease -IndexPath '${idx}' -FileKey win-x64-zip
      Select-McbNodeRelease -IndexPath '${idx}' -FileKey win-arm64-zip
      Select-McbNodeRelease -IndexJson (Get-Content -Raw '${idx}') -Major 24
      try { Select-McbNodeRelease -IndexPath '${idx}' -Major 20 } catch { 'none: ' + $_.Exception.Message }`);
    expect(r.stdout.trim().split(/\r?\n/)).toEqual(["v22.21.1", "v22.10.2", "v24.1.0", "none: No Node.js 20 release for this computer (win-x64-zip) was found on nodejs.org."]);
  });

  it("reads the expected checksum from SHASUMS256.txt", async () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const r = await helper(`
      $t = "${a}  node-v22.1.0-win-x64.zip\`n${b}  node-v22.1.0-win-arm64.zip\`r\`n"
      Get-McbExpectedSha256 $t 'node-v22.1.0-win-arm64.zip'
      [string](Get-McbExpectedSha256 $t 'node-v22.1.0-win-x64.7z') + '|'`);
    expect(r.stdout.trim().split(/\r?\n/)).toEqual(["b".repeat(64), "|"]);
  });

  /** A tiny stand-in for a Node.js release zip, built with PowerShell's own Compress-Archive. */
  async function fakeNodeZip(version, arch = "x64") {
    const dir = join(tmp, `zip-${version}-${arch}`);
    const inner = join(dir, `node-${version}-win-${arch}`);
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "node.exe"), `fake node ${version}`);
    writeFileSync(join(inner, "npm.cmd"), "@echo off\r\n");
    const zip = join(tmp, `node-${version}-win-${arch}.zip`);
    const r = await pwsh(["-NonInteractive", "-Command", `$ProgressPreference='SilentlyContinue'; Compress-Archive -Path '${inner}' -DestinationPath '${zip}' -Force`]);
    expect(r.status, r.out).toBe(0);
    return readFileSync(zip);
  }

  it("downloads Node.js from a mirror, checks its SHA-256 and unpacks it into <app>\\runtime", async () => {
    const zip = await fakeNodeZip("v22.99.1");
    const sha = createHash("sha256").update(zip).digest("hex");
    routes.set("/ok/index.json", JSON.stringify([{ version: "v22.99.1", files: ["win-x64-zip"] }, { version: "v22.5.0", files: ["win-x64-zip"] }]));
    routes.set("/ok/v22.99.1/SHASUMS256.txt", `${"0".repeat(64)}  node-v22.99.1.tar.gz\n${sha}  node-v22.99.1-win-x64.zip\n`);
    routes.set("/ok/v22.99.1/node-v22.99.1-win-x64.zip", zip);
    const app = join(tmp, "app-ok");
    mkdirSync(join(app, "runtime"), { recursive: true });
    writeFileSync(join(app, "runtime", "old.txt"), "old runtime");
    const r = await helper(`Install-McbNodeRuntime -AppDir '${app}' -Arch x64 -BaseUrl '${base}/ok'`);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("Downloading Node.js v22.99.1");
    expect(readFileSync(join(app, "runtime", "node.exe"), "utf8")).toBe("fake node v22.99.1");
    expect(existsSync(join(app, "runtime", "npm.cmd"))).toBe(true);
    expect(existsSync(join(app, "runtime", "old.txt"))).toBe(false);
    expect(readdirSync(app).sort()).toEqual(["runtime"]);
  });

  it("refuses a Node.js download whose checksum does not match and keeps the old runtime", async () => {
    const zip = await fakeNodeZip("v22.99.2");
    routes.set("/bad/index.json", JSON.stringify([{ version: "v22.99.2", files: ["win-x64-zip"] }]));
    routes.set("/bad/v22.99.2/SHASUMS256.txt", `${"f".repeat(64)}  node-v22.99.2-win-x64.zip\n`);
    routes.set("/bad/v22.99.2/node-v22.99.2-win-x64.zip", zip);
    const app = join(tmp, "app-bad");
    mkdirSync(join(app, "runtime"), { recursive: true });
    writeFileSync(join(app, "runtime", "node.exe"), "previous");
    const r = await helper(`try { Install-McbNodeRuntime -AppDir '${app}' -Arch x64 -BaseUrl '${base}/bad'; 'installed' } catch { 'refused: ' + $_.Exception.Message }`);
    expect(r.stdout).toContain("refused: The Node.js download did not pass its safety check");
    expect(readFileSync(join(app, "runtime", "node.exe"), "utf8")).toBe("previous");
    expect(readdirSync(app)).toEqual(["runtime"]);
  });

  /** A fake Bridge folder: real installer scripts, a dependency-free lockfile and a mc-bridge.mjs that logs its args. */
  function fakeBridge(dir) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "scripts", "install"), { recursive: true });
    for (const f of ["node-runtime.ps1", "launch-windows.ps1"]) cpSync(join(ROOT, "scripts/install", f), join(dir, "scripts/install", f));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-bridge", version: "1.0.0", private: true }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fake-bridge", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fake-bridge", version: "1.0.0" } } }));
    writeFileSync(
      join(dir, "bin", "mc-bridge.mjs"),
      `import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MCB_TEST_LOG, JSON.stringify({ args, cwd: process.cwd(), cli: process.env.MCB_CLI_NAME ?? null }) + "\\n");
if (args[0] === "init") writeFileSync(args[args.indexOf("--config") + 1], JSON.stringify({ demo: args.includes("--demo") }));
console.log("fake bridge " + args[0]);
`,
    );
    return dir;
  }
  const logOf = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

  it("launch-windows.ps1: installs, runs first setup without questions, then starts with --open", async () => {
    const app = fakeBridge(join(tmp, "launch app"));
    const cfg = join(tmp, "launch cfg");
    const log = join(tmp, "launch.log");
    const r = await pwsh(["-NonInteractive", "-File", join(app, "scripts/install/launch-windows.ps1"), "-ConfigDir", cfg, "-Demo"], { env: { MCB_TEST_LOG: log } });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("Installing the Bridge");
    expect(r.stdout).toContain("The Bridge has stopped.");
    const calls = logOf(log);
    expect(calls.map((c) => c.args[0])).toEqual(["init", "start"]);
    expect(calls[0].args).toEqual(["init", "--yes", "--config", join(cfg, "bridge.config.json"), "--demo"]);
    expect(calls[1].args).toEqual(["start", "--open", "--config", join(cfg, "bridge.config.json"), "--demo"]);
    expect(JSON.parse(readFileSync(join(cfg, "bridge.config.json"), "utf8"))).toEqual({ demo: true });
    // The ZIP launcher has no mc-bridge command, so the Bridge keeps its default command hints; init runs in the config folder.
    expect(calls.map((c) => c.cli)).toEqual([null, null]);
    expect(calls[0].cwd).toBe(cfg);
    expect(existsSync(join(app, "node_modules", ".mcb-installed"))).toBe(true);

    // Second run: parts are current and the config exists, so it only starts.
    rmSync(log);
    const again = await pwsh(["-NonInteractive", "-File", join(app, "scripts/install/launch-windows.ps1"), "-ConfigDir", cfg, "-NoStart"], { env: { MCB_TEST_LOG: log } });
    expect(again.status, again.out).toBe(0);
    expect(again.stdout).not.toContain("Installing the Bridge");
    expect(logOf(log)).toEqual([]);
  }, 120_000);

  it("launch-windows.ps1: a folder without the Bridge gives a friendly message and exit code 1", async () => {
    const r = await pwsh(["-NonInteractive", "-File", LAUNCHER, "-AppDir", join(tmp, "nothing-here"), "-ConfigDir", join(tmp, "cfg-x"), "-NoStart"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("The Bridge files are missing from");
  });

  it.skipIf(onWindows)("install.ps1 explains that it is for Windows when not on Windows", async () => {
    const r = await pwsh(["-NonInteractive", "-File", INSTALL]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("On a Mac or Linux, use install.sh");
  });

  it("install.ps1 stops with a friendly message for a source that does not exist, and exits 1 only as a file", async () => {
    const env = { MCB_INSTALL_DIR: join(tmp, "inst-missing"), MCB_HOME: join(tmp, "home-missing"), MCB_SOURCE: join(tmp, "no-such-source") };
    const r = await pwsh(["-NonInteractive", "-File", INSTALL], { env });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Could not find");
    expect(r.stdout).toContain("Nothing in your settings or data was changed.");
    expect(existsSync(join(tmp, "inst-missing", "download"))).toBe(false);
    // The irm | iex way: the same failure must not close the PowerShell window.
    const iex = await pwsh(["-NonInteractive", "-Command", `Get-Content -Raw '${INSTALL}' | Invoke-Expression; 'window still open'`], { env });
    expect(iex.stdout).toContain("Could not find");
    expect(iex.stdout.trim().endsWith("window still open")).toBe(true);
  });

  // Not on Windows: uninstall there would also remove this computer's real "Mr Chartist Bridge" shortcuts.
  it.skipIf(onWindows)("install.ps1: installs a release checked against SHA256SUMS.txt, and refuses a swapped file or a wrong -Sha256", async () => {
    const rel = join(tmp, "releases");
    const makeRelease = async (v, { tamper = false } = {}) => {
      const src = fakeBridge(join(tmp, `rel-src-${v}`, `mr-chartist-bridge-${v}`));
      const dir = join(rel, "download", `v${v}`);
      mkdirSync(dir, { recursive: true });
      const name = `mr-chartist-bridge-${v}-source.zip`;
      const zip = join(dir, name);
      const z = await pwsh(["-NonInteractive", "-Command", `$ProgressPreference='SilentlyContinue'; Compress-Archive -Path '${src}' -DestinationPath '${zip}' -Force`]);
      expect(z.status, z.out).toBe(0);
      const good = createHash("sha256").update(readFileSync(zip)).digest("hex");
      writeFileSync(join(dir, "SHA256SUMS.txt"), `${"0".repeat(64)}  Mr-Chartist-Bridge-Setup-${v}.exe\n${good}  ${name}\n`);
      if (tamper) writeFileSync(zip, Buffer.concat([readFileSync(zip), Buffer.from("tampered")]));
      mkdirSync(join(rel, "latest", "download"), { recursive: true });
      writeFileSync(join(rel, "latest", "download", "SHA256SUMS.txt"), readFileSync(join(dir, "SHA256SUMS.txt")));
      return good;
    };
    const env = (n, extra = {}) => ({ MCB_INSTALL_DIR: join(tmp, `rel-inst-${n}`), MCB_HOME: join(tmp, `rel-home-${n}`), MCB_TEST_LOG: join(tmp, `rel-${n}.log`), MCB_RELEASE_BASE: rel, MCB_NO_START: "1", ...extra });
    const good = await makeRelease("1.0.0");
    const ok = await pwsh(["-NonInteractive", "-File", INSTALL], { env: env("a") });
    expect(ok.status, ok.out).toBe(0);
    expect(ok.stdout).toContain("The newest release");
    expect(ok.stdout).toContain("Checked: the SHA-256 matches");
    expect(existsSync(join(tmp, "rel-inst-a", "app", "bin", "mc-bridge.mjs"))).toBe(true);
    const pinned = await pwsh(["-NonInteractive", "-File", INSTALL, "-Version", "1.0.0", "-Sha256", good.toUpperCase()], { env: env("b") });
    expect(pinned.status, pinned.out).toBe(0);
    const wrong = await pwsh(["-NonInteractive", "-File", INSTALL, "-Sha256", "a".repeat(64)], { env: env("c") });
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain("is not the one the release publishes");
    expect(existsSync(join(tmp, "rel-inst-c", "app"))).toBe(false);
    await makeRelease("1.0.0", { tamper: true });
    const bad = await pwsh(["-NonInteractive", "-File", INSTALL], { env: env("d") });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("does not match its published checksum, so it was NOT installed");
    expect(bad.stdout).toContain("Nothing on this computer was changed");
    expect(existsSync(join(tmp, "rel-inst-d", "app"))).toBe(false);
    const url = await pwsh(["-NonInteractive", "-File", INSTALL], { env: env("e", { MCB_SOURCE: `${base}/bridge.zip` }) });
    expect(url.status).toBe(1);
    expect(url.stdout).toContain("needs the expected checksum too");
  }, 240_000);

  it.skipIf(onWindows)("install.ps1: installs from a folder, a .zip and a URL, updates in place, then uninstalls keeping data", async () => {
    const src = fakeBridge(join(tmp, "src (with spaces)"));
    cpSync(INSTALL, join(src, "install.ps1"));
    writeFileSync(join(src, "bridge.config.json"), "{\"from\":\"source\"}"); // a developer's local config is never copied
    const inst = join(tmp, "inst");
    const home = join(tmp, "home");
    const log = join(tmp, "install.log");
    const env = { MCB_INSTALL_DIR: inst, MCB_HOME: home, MCB_TEST_LOG: log, MCB_SOURCE: src, MCB_NO_START: "1" };
    const app = join(inst, "app");

    const first = await pwsh(["-NonInteractive", "-File", INSTALL], { env });
    expect(first.status, first.out).toBe(0);
    for (const n of ["[1/6]", "[2/6]", "[3/6]", "[4/6]", "[5/6]", "[6/6]", "All done", "Skipped: shortcuts and PATH are only set up on Windows."]) expect(first.stdout).toContain(n);
    expect(existsSync(join(app, "bin", "mc-bridge.mjs"))).toBe(true);
    expect(existsSync(join(app, "bridge.config.json"))).toBe(false);
    expect(existsSync(join(inst, "download"))).toBe(false);
    expect(logOf(log).map((c) => c.args.slice(0, 2).join(" "))).toEqual(["init --yes"]);
    expect(logOf(log)[0].cli).toBe("mc-bridge");
    expect(logOf(log)[0].cwd).toBe(home);
    const config = readFileSync(join(home, "bridge.config.json"), "utf8");

    // Update from a GitHub-style zip (one top folder) with the runtime kept, old files gone and settings untouched.
    mkdirSync(join(app, "runtime"), { recursive: true });
    writeFileSync(join(app, "runtime", "keep.txt"), "private node");
    writeFileSync(join(app, "stale.txt"), "from the old version");
    rmSync(join(src, "bridge.config.json"));
    const zip = join(tmp, "bridge.zip");
    const z = await pwsh(["-NonInteractive", "-Command", `$ProgressPreference='SilentlyContinue'; Compress-Archive -Path '${src}' -DestinationPath '${zip}' -Force`]);
    expect(z.status, z.out).toBe(0);
    const second = await pwsh(["-NonInteractive", "-File", INSTALL], { env: { ...env, MCB_SOURCE: zip, MCB_DEMO: "1" } });
    expect(second.status, second.out).toBe(0);
    expect(second.stdout).toContain("Updating the Bridge");
    expect(second.stdout).toContain("Keeping your existing settings");
    expect(readFileSync(join(app, "runtime", "keep.txt"), "utf8")).toBe("private node");
    expect(existsSync(join(app, "stale.txt"))).toBe(false);
    expect(readFileSync(join(home, "bridge.config.json"), "utf8")).toBe(config);

    // Update from a URL, then start (the fake Bridge exits at once).
    routes.set("/bridge.zip", readFileSync(zip));
    rmSync(log);
    const third = await pwsh(["-NonInteractive", "-File", INSTALL], { env: { ...env, MCB_SOURCE: `${base}/bridge.zip`, MCB_SHA256: createHash("sha256").update(readFileSync(zip)).digest("hex"), MCB_NO_START: "" } });
    expect(third.status, third.out).toBe(0);
    expect(third.stdout).toContain("fake bridge start");
    expect(logOf(log).map((c) => c.args)).toEqual([["start", "--open", "--config", join(home, "bridge.config.json")]]);
    expect(logOf(log)[0].cli).toBe("mc-bridge");

    // Uninstall with switches through the scriptblock form; purge asked for but not confirmed.
    const un = await pwsh(["-Command", `& ([scriptblock]::Create((Get-Content -Raw '${INSTALL}'))) -Uninstall -Purge; 'window still open'`], { env: { MCB_INSTALL_DIR: inst, MCB_HOME: home }, input: "no\n" });
    expect(un.stdout).toContain("The Bridge program has been removed.");
    expect(un.stdout).toContain(`Your settings, keys and data are kept in: ${home}`);
    expect(un.stdout).toContain("Kept. Nothing else was deleted.");
    expect(un.stdout.trim().endsWith("window still open")).toBe(true);
    expect(existsSync(inst)).toBe(false);
    expect(readFileSync(join(home, "bridge.config.json"), "utf8")).toBe(config);

    // Purge only on the exact word DELETE.
    const purge = await pwsh(["-File", INSTALL, "-Uninstall", "-Purge"], { env: { MCB_INSTALL_DIR: inst, MCB_HOME: home }, input: "DELETE\n" });
    expect(purge.stdout).toContain("Your settings and data have been deleted.");
    expect(existsSync(home)).toBe(false);
  }, 180_000);
});

describe.skipIf(!PWSH || onWindows || process.env.MCB_INSTALL_E2E !== "1")("install.ps1 dry run from this repository (MCB_INSTALL_E2E=1)", () => {
  it("installs, sets up and leaves the settings alone on update", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcb-win-e2e-"));
    try {
      const src = join(tmp, "src");
      cpSync(ROOT, src, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git|runtime|coverage|\.cache|data)$/.test(p) && !p.endsWith("bridge.config.json") });
      const env = { MCB_SOURCE: src, MCB_INSTALL_DIR: join(tmp, "inst"), MCB_HOME: join(tmp, "home"), MCB_MASTER_KEY_FILE: join(tmp, "key", "master.key"), MCB_NO_START: "1", npm_config_audit: "false" };
      const r = await pwsh(["-NonInteractive", "-File", INSTALL], { env });
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(tmp, "inst", "app", "node_modules", "ws"))).toBe(true);
      const cfg = readFileSync(join(tmp, "home", "bridge.config.json"), "utf8");
      const again = await pwsh(["-NonInteractive", "-File", INSTALL], { env });
      expect(again.status, again.out).toBe(0);
      expect(readFileSync(join(tmp, "home", "bridge.config.json"), "utf8")).toBe(cfg);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 600_000);
});

describe.skipIf(!PWSH || process.env.MCB_NETWORK_TESTS !== "1")("Node.js for Windows from nodejs.org (MCB_NETWORK_TESTS=1)", () => {
  it("downloads the newest Node.js 22 win-x64 zip, checks its SHA-256 and unpacks node.exe", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcb-win-net-"));
    try {
      const r = await helper(`
        $v = Select-McbNodeRelease -IndexJson (Invoke-WebRequest -UseBasicParsing https://nodejs.org/dist/index.json).Content -FileKey win-x64-zip
        $zip = Save-McbNodeArchive -Version $v -FileName "node-$v-win-x64.zip" -Folder '${join(tmp, "dl")}'
        "RESULT|$v|$zip"
        Install-McbNodeRuntime -AppDir '${join(tmp, "app")}' -Arch x64 | Out-Null`);
      expect(r.status, r.out).toBe(0);
      const [, version, zip] = r.stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT|")).split("|");
      expect(version).toMatch(/^v22\.\d+\.\d+$/);
      // Check the checksum independently of the PowerShell code.
      const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
      const line = sums.split("\n").find((l) => l.endsWith(`  node-${version}-win-x64.zip`));
      expect(line.split(/\s+/)[0]).toBe(createHash("sha256").update(readFileSync(zip)).digest("hex"));
      expect(existsSync(join(tmp, "app", "runtime", "node.exe"))).toBe(true);
      expect(existsSync(join(tmp, "app", "runtime", "npm.cmd"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 600_000);
});
