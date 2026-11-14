// Builds Mr-Chartist-Bridge-Setup-<version>.exe: Node.js for Windows with scripts/release/windows-exe/main.cjs and the
// whole Bridge (app files and node_modules) packed inside, as a Node.js single executable application. One file that
// installs itself and then is the app (see main.cjs). Called by build-bundles.mjs; works on Linux, no Windows needed.
//
// The preparation blob must come from the same Node.js version as the binary it goes into, so the blob is made with a
// Linux Node.js of that exact version (downloaded and checked like the Windows one). The .exe gets the Bridge icon and
// its own version details after the blob is injected; node.exe's Authenticode signature is dropped because the file is
// changed (the release is unsigned, like the ZIPs).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** Every file under `dir` as [relative posix path, absolute path]. */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else if (st.isFile()) out.push([relative(base, abs).split("\\").join("/"), abs, st.mode & 0o777]);
  }
  return out;
}

/** The app as one gzip: [u32 path length][path][u32 mode][u32 size][bytes] per file (read back by main.cjs). */
export function packApp(dir) {
  const parts = [];
  for (const [rel, abs, mode] of walk(dir)) {
    const name = Buffer.from(rel, "utf8");
    const data = readFileSync(abs);
    const head = Buffer.alloc(12 + name.length);
    head.writeUInt32LE(name.length, 0);
    name.copy(head, 4);
    head.writeUInt32LE(mode, 4 + name.length);
    head.writeUInt32LE(data.length, 8 + name.length);
    parts.push(head, data);
  }
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/**
 * @param {{ app: string, nodeBinary: string, blobNode: string, out: string, version: string, windows: boolean, work: string }} o
 *   app: staged Bridge folder (with node_modules); nodeBinary: node.exe (or a Linux node for tests) to turn into the
 *   .exe; blobNode: a runnable node of the same version, to make the blob; work: scratch folder.
 */
export async function buildExe(o) {
  mkdirSync(o.work, { recursive: true });
  writeFileSync(join(o.work, "app.pack"), packApp(o.app));
  writeFileSync(join(o.work, "version"), o.version);
  const cfg = {
    main: join(ROOT, "scripts/release/windows-exe/main.cjs"),
    output: join(o.work, "sea.blob"),
    disableExperimentalSEAWarning: true,
    useCodeCache: false, // the blob is made on Linux for a Windows binary
    useSnapshot: false,
    assets: { "app.pack": join(o.work, "app.pack"), version: join(o.work, "version") },
  };
  writeFileSync(join(o.work, "sea.json"), JSON.stringify(cfg));
  execFileSync(o.blobNode, ["--experimental-sea-config", join(o.work, "sea.json")], { stdio: ["ignore", "ignore", "inherit"] });

  writeFileSync(o.out, readFileSync(o.nodeBinary), { mode: 0o755 });
  const { inject } = (await import("postject")).default ?? (await import("postject"));
  await inject(o.out, "NODE_SEA_BLOB", readFileSync(cfg.output), { sentinelFuse: SEA_FUSE });
  // Icon and details after the injection: resedit then only rewrites the resource section (keeping the blob), while
  // the other order lets postject re-lay the sections resedit had moved.
  if (o.windows) writeFileSync(o.out, await brand(readFileSync(o.out), o.version), { mode: 0o755 });
  return o.out;
}

/** Icon and version details (Properties > Details, Task Manager, Settings > Apps) on node.exe. */
async function brand(exeBuffer, version) {
  const { NtExecutable, NtExecutableResource, Data, Resource } = await import("resedit");
  const exe = NtExecutable.from(exeBuffer, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const ico = Data.IconFile.from(readFileSync(join(ROOT, "scripts/install/icon/mr-chartist-bridge.ico")));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const targets = groups.length ? groups.map((g) => [g.id, g.lang]) : [[1, 1033]];
  for (const [id, lang] of targets) Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons.map((i) => i.data));
  const vi = Resource.VersionInfo.fromEntries(res.entries)[0] ?? Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      CompanyName: "Mr. Chartist",
      FileDescription: "Mr Chartist Bridge (setup and app)",
      ProductName: "Mr. Chartist API Bridge",
      OriginalFilename: "Mr Chartist Bridge.exe",
      InternalName: "mr-chartist-bridge",
      LegalCopyright: "PolyForm Noncommercial License 1.0.0. Includes Node.js (MIT, OpenJS Foundation).",
      FileVersion: version,
      ProductVersion: version,
    },
  );
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}
