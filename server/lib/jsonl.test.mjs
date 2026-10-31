import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendLine, appendLineSync, appendLines, compact, fileStamp, istDate, lastWinsIndex, parseLines, pruneDated, quarantine, readLines, readLinesSync } from "./jsonl.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcb-jsonl-"));
});

describe("append and read", () => {
  it("appends one JSON record per line and reads them back (async and sync)", async () => {
    const f = join(dir, "sub", "a.jsonl");
    await appendLine(f, { id: 1 });
    appendLineSync(f, { id: 2 });
    await appendLine(f, '{"id":3}');
    expect(readFileSync(f, "utf8")).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
    expect(await readLines(f)).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], corrupt: 0, tornTail: false, missing: false });
    expect(readLinesSync(f).items).toHaveLength(3);
    if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("appendLines writes several records in one append, repairing a torn tail first", async () => {
    const f = join(dir, "many.jsonl");
    writeFileSync(f, '{"id":0}\n{"id":1,"to');
    expect(await appendLines(f, [{ id: 2 }, '{"id":3}'])).toMatchObject({ repaired: true, lines: 2 });
    expect(readFileSync(f, "utf8")).toBe('{"id":0}\n{"id":1,"to\n{"id":2}\n{"id":3}\n');
    expect((await readLines(f)).items.map((r) => r.id)).toEqual([0, 2, 3]);
    expect(await appendLines(f, [])).toEqual({ bytes: 0, repaired: false, lines: 0 });
    await expect(appendLines(f, ["a\nb"])).rejects.toThrow(/newline/);
  });

  it("a missing file reads as empty", async () => {
    expect(await readLines(join(dir, "none.jsonl"))).toEqual({ items: [], corrupt: 0, tornTail: false, missing: true });
    expect(readLinesSync(join(dir, "none.jsonl")).missing).toBe(true);
  });

  it("refuses a record with a newline in it", async () => {
    await expect(appendLine(join(dir, "a.jsonl"), "a\nb")).rejects.toThrow(/newline/);
    expect(() => appendLineSync(join(dir, "a.jsonl"), "x\r")).toThrow(/newline/);
  });
});

describe("torn lines and newline repair", () => {
  it("skips and reports a torn last line", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, '{"id":1}\n{"id":2}\n{"id":3,"na');
    const r = await readLines(f);
    expect(r.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r.tornTail).toBe(true);
    expect(r.corrupt).toBe(0);
  });

  it("repairs a missing final newline before the next append, so records never fuse", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, '{"id":1}\n{"id":2,"na');
    expect(await appendLine(f, { id: 3 })).toMatchObject({ repaired: true });
    expect(readFileSync(f, "utf8")).toBe('{"id":1}\n{"id":2,"na\n{"id":3}\n');
    const r = await readLines(f);
    expect(r.items).toEqual([{ id: 1 }, { id: 3 }]);
    expect(r.corrupt).toBe(1); // the old torn line is now a corrupt middle line, still skipped
    expect(r.tornTail).toBe(false);
    expect(appendLineSync(f, { id: 4 })).toMatchObject({ repaired: false });
  });

  it("keeps a complete last record that only lacks its newline; counts corrupt middle lines; ignores blank lines and CRLF", () => {
    expect(parseLines('{"a":1}\n\n{"a":2}')).toEqual({ items: [{ a: 1 }, { a: 2 }], corrupt: 0, tornTail: false });
    expect(parseLines('{"a":1}\r\nnot json\n{"a":2}\n')).toEqual({ items: [{ a: 1 }, { a: 2 }], corrupt: 1, tornTail: false });
    expect(parseLines("")).toEqual({ items: [], corrupt: 0, tornTail: false });
  });

  it("a custom parser can reject lines (schema checks)", () => {
    const parse = (l) => {
      const v = JSON.parse(l);
      if (typeof v.id !== "number") throw new Error("bad");
      return v;
    };
    expect(parseLines('{"id":1}\n{"id":"x"}\n', { parse })).toEqual({ items: [{ id: 1 }], corrupt: 1, tornTail: false });
  });
});

describe("last-wins index", () => {
  it("keeps the newest record per key, ordered by latest write, with optional tombstones", () => {
    const items = [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "a", v: 2 }, { v: 9 }, { id: "c", v: 1 }, { id: "b", deleted: true }];
    const idx = lastWinsIndex(items, "id", { isDeleted: (r) => r.deleted === true });
    expect([...idx.keys()]).toEqual(["a", "c"]);
    expect(idx.get("a")).toEqual({ id: "a", v: 2 });
    expect(lastWinsIndex(items, (r) => r.id).get("b")).toEqual({ id: "b", deleted: true });
  });
});

describe("compact and quarantine", () => {
  it("compact rewrites the file atomically with exactly the given records", async () => {
    const f = join(dir, "c.jsonl");
    for (let i = 0; i < 5; i++) await appendLine(f, { id: i % 2, v: i });
    const latest = lastWinsIndex((await readLines(f)).items, "id");
    expect(compact(f, latest.values())).toEqual({ lines: 2, bytes: readFileSync(f).length });
    expect((await readLines(f)).items).toEqual([{ id: 1, v: 3 }, { id: 0, v: 4 }]);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("quarantine renames a file to *.corrupt-<ts> and never overwrites an earlier one", () => {
    const f = join(dir, "q.jsonl");
    const now = Date.UTC(2026, 9, 29, 4, 30, 0, 123);
    expect(quarantine(f, { now })).toBe(null);
    writeFileSync(f, "garbage");
    const a = quarantine(f, { now });
    expect(a).toBe(`${f}.corrupt-20261029T043000123Z`);
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, "garbage 2");
    const b = quarantine(f, { now });
    expect(b).toBe(`${f}.corrupt-20261029T043000123Z-1`);
    expect(readFileSync(a, "utf8")).toBe("garbage");
    expect(fileStamp(now)).toBe("20261029T043000123Z");
  });
});

describe("dated-file retention", () => {
  it("deletes days and months older than today − keepDays, leaves undated and quarantined names", () => {
    for (const n of ["2026-10-01.jsonl", "2026-10-25.jsonl", "2026-10-26.jsonl", "2026-10-29.jsonl", "2026-09.jsonl", "2026-10.jsonl", "rules.jsonl", "2026-01-01.jsonl.corrupt-20260101T000000000Z", "notes.txt"]) {
      writeFileSync(join(dir, n), "x\n");
    }
    mkdirSync(join(dir, "2026-10-02"));
    writeFileSync(join(dir, "2026-10-02", "NIFTY.jsonl"), "x\n");
    const removed = pruneDated(dir, { keepDays: 3, today: "2026-10-29" });
    expect(removed).toEqual(["2026-09.jsonl", "2026-10-01.jsonl", "2026-10-02", "2026-10-25.jsonl"]);
    expect(readdirSync(dir).sort()).toEqual(["2026-01-01.jsonl.corrupt-20260101T000000000Z", "2026-10-26.jsonl", "2026-10-29.jsonl", "2026-10.jsonl", "notes.txt", "rules.jsonl"]);
    expect(pruneDated(join(dir, "missing"), { keepDays: 1, today: "2026-10-29" })).toEqual([]);
    expect(() => pruneDated(dir, { keepDays: -1, today: "2026-10-29" })).toThrow(RangeError);
    expect(() => pruneDated(dir, { keepDays: 1, today: "29/10/2026" })).toThrow(RangeError);
  });

  it("match limits which names are considered; istDate uses the IST calendar", () => {
    writeFileSync(join(dir, "2020-01-01.jsonl"), "x\n");
    writeFileSync(join(dir, "2020-01-01.csv"), "x\n");
    expect(pruneDated(dir, { keepDays: 1, today: "2026-10-29", match: /\.jsonl$/ })).toEqual(["2020-01-01.jsonl"]);
    // A /g match must not skip every other file (RegExp lastIndex).
    for (const n of ["2020-01-02.jsonl", "2020-01-03.jsonl", "2020-01-04.jsonl"]) writeFileSync(join(dir, n), "x\n");
    expect(pruneDated(dir, { keepDays: 1, today: "2026-10-29", match: /\.jsonl$/g })).toEqual(["2020-01-02.jsonl", "2020-01-03.jsonl", "2020-01-04.jsonl"]);
    expect(istDate(Date.UTC(2026, 9, 28, 18, 29))).toBe("2026-10-28");
    expect(istDate(Date.UTC(2026, 9, 28, 18, 30))).toBe("2026-10-29");
  });
});
