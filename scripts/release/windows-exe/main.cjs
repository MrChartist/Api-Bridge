// Mr Chartist Bridge for Windows as one .exe: Node.js with this script and the whole Bridge packed inside
// (a Node.js single executable application, built by scripts/release/build-exe.mjs).
//
// One file, three jobs:
//   Setup:   double-clicked anywhere else (Downloads, a USB stick): copies itself and the Bridge into
//            %LOCALAPPDATA%\MrChartist\Bridge\app, adds Start-menu and Desktop shortcuts, an entry under Settings > Apps
//            (so it uninstalls like any program) and the mc-bridge command, then starts the installed copy.
//            No admin rights. Running a newer Setup upgrades in place; settings and data are never touched.
//   App:     the installed copy (what the shortcuts open): sets up paper trading on the first run, then starts the
//            Bridge and opens the dashboard, already signed in. Keep its window open; close it to stop the Bridge.
//   Command: "Mr Chartist Bridge.exe" --mcb-cli <command ...>  (what mc-bridge.cmd runs), e.g. mc-bridge doctor.
//   Also:    --uninstall (asks first; --yes to skip), --install-only (no start), --demo (sample data).
//
// The installed .exe is also the Bridge's Node.js: it imports the unpacked app from disk, so nothing else is needed.
// MCB_INSTALL_DIR / MCB_HOME move the program and the settings (tests use them on Linux, where the Windows-only steps
// are skipped).
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const zlib = require("node:zlib");

const APP_NAME = "Mr Chartist Bridge";
const EXE_NAME = `${APP_NAME}.exe`;
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MrChartistBridge";
const isWindows = process.platform === "win32";
const env = process.env;

const appDir = path.resolve(env.MCB_INSTALL_DIR || path.join(env.LOCALAPPDATA || path.join(require("node:os").homedir(), "AppData", "Local"), "MrChartist", "Bridge", "app"));
const configDir = path.resolve(env.MCB_HOME || (isWindows && env.APPDATA ? path.join(env.APPDATA, "MrChartist", "Bridge") : path.join(require("node:os").homedir(), ".mc-bridge")));
const installedExe = path.join(appDir, EXE_NAME);
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

const say = (s = "") => process.stdout.write(`${s}\n`);
const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Keep a copy of everything this window shows in <settings>\\logs\\window.log, so that when something goes wrong the
 * person can send one file instead of describing a window that has already closed. Never throws; the log is started
 * afresh once it passes 1 MB. Keys never appear in what the window shows, and are masked here in any case.
 */
const logFile = path.join(configDir, "logs", "window.log");
function keepWindowLog(what) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.rmSync(logFile, { force: true });
    const fd = fs.openSync(logFile, "a");
    const put = (chunk) => {
      try {
        fs.writeSync(fd, String(chunk).replace(/mcb_[A-Za-z0-9_-]{20,}/g, "mcb_<hidden>").replace(/#signin=[A-Za-z0-9_-]+/g, "#signin=<hidden>"));
      } catch {
        /* the log is a convenience */
      }
    };
    put(`\n===== ${new Date().toISOString()}  ${what}  ${version()}  ${process.platform} ${process.arch}  ${process.execPath} =====\n`);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk, ...rest) => {
        put(chunk);
        return write(chunk, ...rest);
      };
    }
    process.on("uncaughtException", (err) => {
      put(`\nuncaught: ${err?.stack ?? err}\n`);
      fail(err?.message ?? String(err), `A copy of these messages is in ${logFile}`);
    });
  } catch {
    /* no log: carry on */
  }
}

/** Wait for Enter when a window opened just for us would otherwise close before the message can be read. */
function pauseThenExit(code) {
  if (has("--no-pause") || (!isWindows && !process.stdin.isTTY)) return process.exit(code);
  // On Windows the window was opened for us by a double-click. With a keyboard it waits for Enter; without one
  // (some launchers give the app no input) it stays for a minute, so the message can always be read.
  if (!process.stdin.isTTY) {
    process.stdout.write("\nThis window closes by itself in 60 seconds.\n");
    return setTimeout(() => process.exit(code), 60_000);
  }
  process.stdout.write("\nPress Enter to close this window.");
  process.stdin.resume();
  process.stdin.once("data", () => process.exit(code));
}

/** When something went wrong on Windows: open the saved copy of this window in Notepad, so it can be read and sent. */
function showLogInNotepad() {
  if (!isWindows || has("--no-pause")) return;
  try {
    if (fs.existsSync(logFile)) spawn("notepad.exe", [logFile], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* a convenience */
  }
}

function fail(message, hint) {
  say("");
  say(`Something went wrong: ${message}`);
  if (hint) say(hint);
  say(`A copy of these messages is in: ${logFile}`);
  showLogInNotepad();
  pauseThenExit(1);
}

/** The Bridge packed by the build: gzip of [u32 path length][path][u32 mode][u32 size][bytes] per file. */
function unpackApp(target) {
  const sea = require("node:sea");
  const packed = Buffer.from(sea.getAsset("app.pack"));
  const buf = zlib.gunzipSync(packed);
  let at = 0;
  let files = 0;
  while (at < buf.length) {
    const nameLen = buf.readUInt32LE(at);
    const name = buf.subarray(at + 4, at + 4 + nameLen).toString("utf8");
    at += 4 + nameLen;
    const mode = buf.readUInt32LE(at);
    const size = buf.readUInt32LE(at + 4);
    at += 8;
    if (name.includes("..") || path.isAbsolute(name)) throw new Error(`bad path in the package: ${name}`);
    const dest = path.join(target, ...name.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf.subarray(at, at + size), { mode: mode || 0o644 });
    at += size;
    files += 1;
  }
  return files;
}

function version() {
  try {
    return require("node:sea").getAsset("version", "utf8").trim();
  } catch {
    return "0.0.0";
  }
}

/** Run a PowerShell snippet (shortcuts, user PATH); Windows only. Never throws: these steps are conveniences. */
function powershell(script) {
  if (!isWindows) return true;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  return r.status === 0;
}
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function shortcutPaths() {
  if (!isWindows) return [];
  const start = path.join(env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", `${APP_NAME}.lnk`);
  const desktop = path.join(env.USERPROFILE || "", "Desktop", `${APP_NAME}.lnk`);
  return [start, desktop];
}

function addShortcutsAndCommand() {
  // mc-bridge command: a .cmd next to the .exe, and that folder on the user PATH (no admin; new windows see it).
  fs.writeFileSync(path.join(appDir, "mc-bridge.cmd"), `@echo off\r\nset "MCB_CLI_NAME=mc-bridge"\r\n"%~dp0${EXE_NAME}" --mcb-cli %*\r\n`);
  if (!isWindows) return;
  const lines = [`$s = New-Object -ComObject WScript.Shell`];
  for (const lnk of shortcutPaths()) {
    lines.push(`$l = $s.CreateShortcut(${psq(lnk)}); $l.TargetPath = ${psq(installedExe)}; $l.WorkingDirectory = ${psq(appDir)}; $l.IconLocation = ${psq(`${installedExe},0`)}; $l.Description = 'Start Mr. Chartist API Bridge and open its dashboard'; $l.Save()`);
  }
  lines.push(`$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $p) { $p = '' }`);
  lines.push(`if (($p -split ';') -notcontains ${psq(appDir)}) { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + ${psq(appDir)}).TrimStart(';'), 'User') }`);
  if (!powershell(lines.join("; "))) say("    (Could not add the shortcuts; start it from " + installedExe + ")");
  // Settings > Apps entry, so it uninstalls like any other program.
  const reg = (name, type, value) => spawnSync("reg.exe", ["add", UNINSTALL_KEY, "/v", name, "/t", type, "/d", value, "/f"], { stdio: "ignore", windowsHide: true });
  reg("DisplayName", "REG_SZ", "Mr. Chartist API Bridge");
  reg("DisplayVersion", "REG_SZ", version());
  reg("Publisher", "REG_SZ", "Mr. Chartist");
  reg("DisplayIcon", "REG_SZ", `${installedExe},0`);
  reg("InstallLocation", "REG_SZ", appDir);
  reg("UninstallString", "REG_SZ", `"${installedExe}" --uninstall`);
  reg("QuietUninstallString", "REG_SZ", `"${installedExe}" --uninstall --yes`);
  reg("NoModify", "REG_DWORD", "1");
  reg("NoRepair", "REG_DWORD", "1");
}

/** Setup: copy the Bridge and this .exe into place (into a new folder first, then swap), shortcuts, first-run setup. */
function install() {
  say(`Installing Mr. Chartist API Bridge ${version()}`);
  say(`Program: ${appDir}`);
  say(`Your settings and data: ${configDir}`);
  say("");
  say("[1/3] Unpacking the Bridge ...");
  const fresh = `${appDir}.new`;
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.mkdirSync(fresh, { recursive: true });
  const n = unpackApp(fresh);
  fs.copyFileSync(process.execPath, path.join(fresh, EXE_NAME));
  if (fs.existsSync(appDir)) {
    try {
      // A running Bridge keeps its .exe open. Check that first: removing the folder would otherwise delete the files
      // around it before failing on the .exe, and leave a broken install.
      if (isWindows && fs.existsSync(installedExe)) fs.closeSync(fs.openSync(installedExe, "r+"));
      fs.rmSync(appDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // The installed Bridge is running (its files are in use), so it cannot be replaced now. That is not a failure
      // for the person who double-clicked: carry on with the installed one, which opens the running dashboard.
      fs.rmSync(fresh, { recursive: true, force: true });
      say("    The Bridge is already running, so it was not updated this time.");
      say("    To update it: close the Mr Chartist Bridge window, then run this Setup again.");
      return true;
    }
  }
  fs.renameSync(fresh, appDir);
  say(`    ${n} files.`);
  say("[2/3] Adding shortcuts and the mc-bridge command ...");
  addShortcutsAndCommand();
  say("[3/3] Setting up (a practice account with virtual money; real orders stay off) ...");
  if (!setupConfig()) {
    fail("the first-run setup did not finish.", "Run this Setup again; if it keeps failing, open an issue at https://github.com/MrChartist/api-bridge-v2/issues.");
    return false;
  }
  say("");
  say("Installed. Next time, start it from \"Mr Chartist Bridge\" in the Start menu or on your Desktop.");
  return true;
}

/** mc-bridge init --yes in the settings folder when there is no config yet. Returns false on failure. */
function setupConfig() {
  if (fs.existsSync(path.join(configDir, "bridge.config.json"))) return true;
  fs.mkdirSync(configDir, { recursive: true });
  // What init prints is for people at a terminal (an admin key, commands to type). The dashboard needs neither on
  // this computer, so the window stays quiet unless the setup fails, and then shows all of it.
  const r = spawnSync(installedExe, ["--mcb-cli", "init", "--yes", "--config", path.join(configDir, "bridge.config.json")], { cwd: configDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...env, MCB_CLI_NAME: "mc-bridge" } });
  if (r.status !== 0) say(`${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/mcb_[A-Za-z0-9_-]{20,}/g, "mcb_<hidden>"));
  return r.status === 0;
}

/** Run a Bridge command in this process: the .exe is the Bridge's Node.js. */
async function runBridge(bridgeArgs) {
  const bin = path.join(appDir, "bin", "mc-bridge.mjs");
  if (!fs.existsSync(bin)) return fail(`the Bridge's files are missing in ${appDir}.`, "Download Mr-Chartist-Bridge-Setup.exe again and run it.");
  env.MCB_CLI_NAME = env.MCB_CLI_NAME || "mc-bridge";
  process.argv = [process.execPath, bin, ...bridgeArgs];
  await import(pathToFileURL(bin).href);
}

/** The installed copy, opened from a shortcut: first-run setup, then start and open the dashboard. */
async function launch() {
  process.title = APP_NAME;
  if (!setupConfig()) return fail("the first-run setup did not finish.");
  // The window must never just vanish. If the Bridge stops with a problem, the reason stays on screen until Enter;
  // if it had nothing to do (it was already running) the window says so and closes by itself a moment later.
  const startedAt = Date.now();
  const realExit = process.exit.bind(process);
  let leaving = false;
  process.exit = (code = 0) => {
    if (leaving) return realExit(code);
    leaving = true;
    if (code !== 0) {
      say("");
      say("  The Bridge could not start. The reason is above.");
      say(`  A copy of these messages is in: ${logFile}`);
      showLogInNotepad();
      return pauseThenExit(code);
    }
    if (Date.now() - startedAt < 20_000 && isWindows && !has("--no-pause")) {
      say("  This window closes by itself in a few seconds.");
      return setTimeout(() => realExit(0), 6000);
    }
    return realExit(code);
  };
  // This window was opened by a double-click, not by someone at a terminal: a short, plain status and no log lines
  // (cli.mjs appWindowLines). MCB_LOG_LEVEL still wins for anyone who wants the detail.
  env.MCB_APP_WINDOW = "1";
  if (!env.MCB_LOG_LEVEL) env.MCB_LOG_LEVEL = "error";
  const config = path.join(configDir, "bridge.config.json");
  const extra = has("--demo") ? ["--demo"] : [];
  process.chdir(configDir);
  await runBridge(["start", "--open", "--config", config, ...extra]);
  // A running Bridge leaves no exit code (it keeps serving). One that is set means the command is over already: it
  // could not start, or the Bridge was running before and only its dashboard was opened.
  if (process.exitCode !== undefined && process.exitCode !== null) process.exit(Number(process.exitCode) || 0);
}

function uninstall() {
  say("Uninstalling Mr. Chartist API Bridge.");
  say(`Your settings, keys and data stay in ${configDir}; delete that folder yourself if you no longer want them.`);
  const go = () => {
    for (const lnk of shortcutPaths()) fs.rmSync(lnk, { force: true });
    if (isWindows) {
      spawnSync("reg.exe", ["delete", UNINSTALL_KEY, "/f"], { stdio: "ignore", windowsHide: true });
      powershell(`$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($p) { [Environment]::SetEnvironmentVariable('Path', (($p -split ';') | Where-Object { $_ -and ($_ -ne ${psq(appDir)}) }) -join ';', 'User') }`);
    }
    if (isWindows && sameFile(process.execPath, installedExe)) {
      // A running .exe cannot delete itself: remove the folder a moment after this window closes.
      spawn("cmd.exe", ["/c", `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${appDir}"`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
    } else {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
    say("Removed.");
    pauseThenExit(0);
  };
  if (has("--yes") || !process.stdin.isTTY) return go();
  process.stdout.write("Remove the program now? Type Y and press Enter: ");
  process.stdin.resume();
  process.stdin.once("data", (d) => (String(d).trim().toLowerCase().startsWith("y") ? go() : (say("Nothing removed."), pauseThenExit(0))));
}

async function main() {
  try {
    if (args[0] === "--mcb-cli") return await runBridge(args.slice(1));
    if (has("--uninstall")) return uninstall();
    // The first line appears at once, before any work, so a window that opens is never empty.
    process.title = APP_NAME;
    keepWindowLog(sameFile(process.execPath, installedExe) ? "app" : "setup");
    say("Mr. Chartist API Bridge");
    say("");
    if (sameFile(process.execPath, installedExe)) return await launch();
    if (!install()) return undefined;
    if (has("--install-only")) return pauseThenExit(0);
    // Setup carries straight on as the app, in this same window. There is no second window to wait for and nothing
    // to hand over: the Bridge runs from the installed files, and this window is the one to keep open.
    say("");
    say("Starting the Bridge ...");
    return await launch();
  } catch (err) {
    fail(err?.message ?? String(err));
  }
}

main();
