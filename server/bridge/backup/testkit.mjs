/**
 * Test helpers for the backup module: a realistic data folder, a way to read it back as { path: content }, and a
 * hand-made archive writer for the malicious and damaged cases. Not loaded by the Bridge.
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createTarWriter } from "./tar.mjs";

export const tmp = (prefix = "mcb-backup-") => mkdtempSync(join(tmpdir(), prefix));

/** Every file a Bridge keeps, with recognisable content. Returns the data folder. */
export function makeDataDir(root = tmp(), { withSecrets = true } = {}) {
  const dir = join(root, "data");
  const put = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, rel), content, { mode: 0o600 });
  };
  put("keys.json", JSON.stringify({ version: 1, keys: [{ id: "mcb_aaaaaaaaaa", scopes: ["admin"] }] }));
  put("hooks.json", JSON.stringify({ version: 1, hooks: [] }));
  put("quotas.json", JSON.stringify({ version: 1, overrides: {} }));
  put("audit/head.json", JSON.stringify({ seq: 2, hash: "a".repeat(64), day: "2026-11-09" }));
  put("audit/2026-11-09.jsonl", '{"seq":1}\n{"seq":2}\n');
  put("paper/book-paper-main.json", JSON.stringify({ version: 1, positions: [{ symbol: "NSE:RELIANCE", qty: 10 }] }));
  put("orders/state.json", JSON.stringify({ version: 1, idempotency: { "k-1": "o-1" } }));
  put("safety/state.json", JSON.stringify({ version: 1, killSwitch: false }));
  put("sources/state.json", JSON.stringify({ version: 1 }));
  put("pooling/consent.json", JSON.stringify({ version: 1, accepted: true }));
  put("readiness/state.json", JSON.stringify({ version: 1 }));
  // Never part of a backup:
  put("master.key", "MASTER-KEY-MATERIAL-DO-NOT-COPY");
  put("control.token", "mcbctl_not-for-backups\n");
  put("sign-in-codes.json", "[]");
  put("instruments/demo-2026-11-09.json", "x".repeat(5000));
  put("keys.json.123.1.tmp", "half written");
  if (withSecrets) put("secrets.enc", "ENCRYPTED-BROKER-LOGINS");
  return dir;
}

/** { "relative/path": "content" } of every regular file under `dir`. */
export function snapshotOf(dir, { skip = () => false } = {}) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      if (statSync(p).isDirectory()) walk(p, r);
      else out[r] = readFileSync(p).toString("latin1");
    }
  };
  walk(dir, "");
  return out;
}

/** Same as snapshotOf but only what a backup holds (no master key, tokens, caches, backups/). */
export const backedUpSnapshot = (dir) => snapshotOf(dir, { skip: (r) => /^(master\.key|control\.token|sign-in-codes\.json|instruments|backups|\.restore|\.pre-restore|last-version)/.test(r) || r.endsWith(".tmp") });

const sha = (b) => createHash("sha256").update(b).digest("hex");

/**
 * Write an archive by hand: `entries` is [[name, content]]; the manifest lists them (with correct checksums unless
 * `manifestFiles` is given) and goes last, as in a real backup.
 */
export async function craftArchive(file, entries, { manifestFiles, manifest = {}, noManifest = false } = {}) {
  const gz = createGzip();
  const done = pipeline(gz, createWriteStream(file));
  const tar = createTarWriter(gz);
  for (const [name, content] of entries) await tar.add(name, Buffer.from(content));
  if (!noManifest) {
    const files = manifestFiles ?? entries.map(([name, content]) => ({ path: name, size: Buffer.byteLength(content), sha256: sha(Buffer.from(content)) }));
    const m = { format: "mc-bridge-backup", formatVersion: 1, bridgeVersion: "2.0.0", createdAt: new Date().toISOString(), kind: "manual", includesSecrets: false, files, ...manifest };
    await tar.add("manifest.json", Buffer.from(JSON.stringify(m)));
  }
  await tar.end();
  await done;
  return file;
}
