import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TarError, createTarWriter, readTar, tarHeader } from "./tar.mjs";

async function pack(files) {
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  const w = createTarWriter(out);
  for (const [name, data] of files) await w.add(name, Buffer.from(data));
  await w.end();
  return Buffer.concat(chunks);
}
async function unpack(buf, opts = {}) {
  const got = {};
  await readTar(
    (async function* () {
      // feed in awkward 7-byte pieces to exercise the chunk handling
      for (let i = 0; i < buf.length; i += 7) yield buf.subarray(i, i + 7);
    })(),
    { ...opts, onFile: (name) => ({ write: (c) => (got[name] = Buffer.concat([got[name] ?? Buffer.alloc(0), c])), finish: () => (got[name] ??= Buffer.alloc(0)) }) },
  );
  return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.toString()]));
}

describe("tar", () => {
  it("round-trips files of any size, empty files and long names", async () => {
    const long = `data/${"a".repeat(60)}/${"b".repeat(60)}/file.json`;
    const files = [["data/a.json", "{}"], ["data/empty", ""], ["data/big.bin", "x".repeat(5000)], [long, "long"], ["data/exact512", "y".repeat(512)]];
    expect(await unpack(await pack(files))).toEqual(Object.fromEntries(files));
  });

  it("refuses a name too long for ustar", () => {
    expect(() => tarHeader(`${"d".repeat(200)}/${"f".repeat(120)}`, 0)).toThrow(/too long/);
  });

  it("detects a damaged header, a cut-short archive and an oversize file", async () => {
    const buf = await pack([["data/a.json", "hello"]]);
    const bad = Buffer.from(buf);
    bad[10] ^= 0xff;
    await expect(unpack(bad)).rejects.toThrow(TarError);
    await expect(unpack(buf.subarray(0, 700))).rejects.toThrow(/cut short/);
    await expect(unpack(buf, { maxFileBytes: 3 })).rejects.toThrow(/larger than the allowed/);
    await expect(unpack(await pack([["a", "1"], ["b", "2"]]), { maxEntries: 1 })).rejects.toThrow(/too many files/);
    await expect(unpack(await pack([["a", "1234"], ["b", "5678"]]), { maxTotalBytes: 6 })).rejects.toThrow(/total size/);
  });
});
