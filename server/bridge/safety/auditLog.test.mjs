/**
 * AuditLog (S9): hash chain across IST-day files, redaction, query with cursor, verify() pinpointing tampering,
 * restart continuity and crash/clock edge cases. Real files in a temp dir; a hand-driven clock.
 */
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createLogger, createNullLogger } from "../core/logger.mjs";
import { GENESIS_HASH, MAX_DATA_BYTES, canonicalJson, createAuditLog, recordHash } from "./auditLog.mjs";

const IST_1000_MON = Date.UTC(2026, 9, 19, 4, 30); // 2026-10-19 10:00 IST
const HOUR = 3_600_000;

function setup({ t = IST_1000_MON, dataDir = mkdtempSync(join(tmpdir(), "mcb-audit-")), logger = createNullLogger(), bus } = {}) {
  const clock = { t, now: () => clock.t };
  const audit = createAuditLog({ logger, bus, clock, paths: { dataDir } });
  return { audit, clock, dataDir, dir: join(dataDir, "audit") };
}

const input = (n, extra = {}) => ({ type: "order.placed", actor: { kind: "key", id: "k1" }, source: "rest", accountId: "dhan-main", requestId: `req_${n}`, data: { n }, ...extra });
const linesOf = (dir, day) => readFileSync(join(dir, `${day}.jsonl`), "utf8").trimEnd().split("\n");

describe("canonicalJson", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe("append", () => {
  it("writes one chained, IST-stamped line per record and emits audit.appended", async () => {
    const bus = createEventBus();
    const seen = [];
    bus.on("audit.appended", (p) => seen.push(p));
    const { audit, dir } = setup({ bus });
    const r1 = await audit.append(input(1));
    const r2 = await audit.append(input(2));
    expect(r1).toMatchObject({ seq: 1, at: "2026-10-19T10:00:00.000+05:30", type: "order.placed", prevHash: GENESIS_HASH, accountId: "dhan-main", requestId: "req_1" });
    expect(r2.prevHash).toBe(r1.hash);
    expect(r2.hash).toBe(recordHash(r1.hash, r2));
    const lines = linesOf(dir, "2026-10-19");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(r1);
    expect(seen).toEqual([
      { seq: 1, type: "order.placed", accountId: "dhan-main" },
      { seq: 2, type: "order.placed", accountId: "dhan-main" },
    ]);
  });

  it("uses owner-only permissions on POSIX", async () => {
    if (process.platform === "win32") return;
    const { audit, dir } = setup();
    await audit.append(input(1));
    expect(statSync(join(dir, "2026-10-19.jsonl")).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  it("starts a new file at IST midnight and chains across files", async () => {
    const { audit, clock, dir } = setup({ t: Date.UTC(2026, 9, 19, 18, 29, 59) }); // 23:59:59 IST
    const a = await audit.append(input(1));
    clock.t += 2000; // 00:00:01 IST on the 20th
    const b = await audit.append(input(2));
    expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()).toEqual(["2026-10-19.jsonl", "2026-10-20.jsonl"]);
    expect(b.prevHash).toBe(a.hash);
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2 });
    expect(await audit.verify({ day: "2026-10-20" })).toMatchObject({ ok: true, checked: 1 });
  });

  it("keeps writing to the latest file when the clock jumps backwards", async () => {
    const { audit, clock } = setup();
    await audit.append(input(1));
    clock.t -= 48 * HOUR;
    await audit.append(input(2));
    expect(audit.files()).toEqual(["2026-10-19"]);
    expect((await audit.verify()).ok).toBe(true);
  });

  it("rejects a malformed type and survives 100 concurrent appends with a valid chain", async () => {
    const { audit } = setup();
    await expect(audit.append({ type: "Bad Type" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await Promise.all(Array.from({ length: 100 }, (_, i) => audit.append(input(i))));
    const v = await audit.verify();
    expect(v).toMatchObject({ ok: true, checked: 100 });
    expect(audit.head().seq).toBe(100);
  });

  it("replaces oversized data with a marker", async () => {
    const { audit } = setup();
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, "x".repeat(1000)]));
    const r = await audit.append(input(1, { data: big }));
    expect(r.data.truncated).toBe(true);
    expect(r.data.bytes).toBeGreaterThan(MAX_DATA_BYTES);
  });
});

describe("redaction (capture test)", () => {
  it("never writes a secret to the audit file", async () => {
    const logger = createLogger({ write: () => {} });
    const exact = "SUPER-SECRET-ACCESS-TOKEN-1234567";
    logger.addSecret(exact);
    // A logger that exposes redact() bound to its registered secrets is used when present (forward compatible).
    const { redact } = await import("../core/logger.mjs");
    logger.redact = (v) => redact(v, [exact]);
    const { audit, dir } = setup({ logger });
    const key = "mcb_abcdefghij_" + "Z".repeat(43);
    await audit.append({
      type: "account.connected",
      actor: { kind: "key", id: "k1" },
      source: "rest",
      accountId: "zerodha-main",
      data: {
        password: "hunter2-password",
        totp: "123456",
        pin: "9876",
        accessToken: "tok-should-not-appear",
        apiKey: "api-key-should-not-appear",
        nested: { authorization: "Bearer abcdefghijklmnop", note: `key was ${key}`, jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl" },
        message: `broker said ${exact}`,
      },
    });
    const file = readFileSync(join(dir, "2026-10-19.jsonl"), "utf8");
    for (const s of ["hunter2-password", "123456", "9876", "tok-should-not-appear", "api-key-should-not-appear", "abcdefghijklmnop", key, "eyJhbGciOiJIUzI1NiJ9", exact]) {
      expect(file).not.toContain(s);
    }
    expect(file).toContain("[redacted]");
    expect((await audit.verify()).ok).toBe(true);
  });
});

describe("query", () => {
  it("returns newest first with a working cursor and filters", async () => {
    const { audit, clock } = setup();
    for (let i = 1; i <= 7; i += 1) {
      await audit.append(input(i, { type: i % 2 ? "order.placed" : "key.created", accountId: i <= 4 ? "dhan-main" : "zerodha-main" }));
      clock.t += HOUR;
    }
    const p1 = await audit.query({ limit: 3 });
    expect(p1.items.map((r) => r.seq)).toEqual([7, 6, 5]);
    const p2 = await audit.query({ limit: 3, cursor: p1.nextCursor });
    expect(p2.items.map((r) => r.seq)).toEqual([4, 3, 2]);
    const p3 = await audit.query({ limit: 3, cursor: p2.nextCursor });
    expect(p3.items.map((r) => r.seq)).toEqual([1]);
    expect(p3.nextCursor).toBeNull();

    expect((await audit.query({ type: "key.created" })).items.map((r) => r.seq)).toEqual([6, 4, 2]);
    expect((await audit.query({ type: "order.*" })).items.map((r) => r.seq)).toEqual([7, 5, 3, 1]);
    expect((await audit.query({ accountId: "zerodha-main" })).items.map((r) => r.seq)).toEqual([7, 6, 5]);
    const from = new Date(IST_1000_MON + 2 * HOUR).toISOString();
    const to = new Date(IST_1000_MON + 4 * HOUR).toISOString();
    expect((await audit.query({ from, to })).items.map((r) => r.seq)).toEqual([5, 4, 3]);
  });

  it("spans day files and refuses bad parameters", async () => {
    const { audit, clock } = setup();
    await audit.append(input(1));
    clock.t += 24 * HOUR;
    await audit.append(input(2));
    expect((await audit.query({})).items.map((r) => r.seq)).toEqual([2, 1]);
    await expect(audit.query({ cursor: "nonsense" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(audit.query({ limit: 501 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(audit.query({ from: "yesterday" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("verify: tampering is reported at the exact line", () => {
  async function threeDays() {
    const ctx = setup();
    for (let d = 0; d < 3; d += 1) {
      for (let i = 0; i < 4; i += 1) await ctx.audit.append(input(d * 4 + i + 1));
      ctx.clock.t += 24 * HOUR;
    }
    return ctx;
  }
  const days = ["2026-10-19", "2026-10-20", "2026-10-21"];

  it("passes on an untouched log", async () => {
    const { audit } = await threeDays();
    expect(await audit.verify()).toEqual({ ok: true, checked: 12, brokenAt: null, day: null, line: null, reason: null });
  });

  it("an edited field (same JSON shape) breaks at that line", async () => {
    const { audit, dir } = await threeDays();
    const lines = linesOf(dir, days[1]);
    const rec = JSON.parse(lines[2]);
    rec.data.n = 999; // seq 7
    lines[2] = JSON.stringify(rec);
    writeFileSync(join(dir, `${days[1]}.jsonl`), lines.join("\n") + "\n");
    const v = await audit.verify();
    expect(v).toMatchObject({ ok: false, brokenAt: 7, day: days[1], line: 3, checked: 6 });
    expect(v.reason).toMatch(/hash/);
    expect(await audit.verify({ day: days[1] })).toMatchObject({ ok: false, brokenAt: 7, line: 3 });
    expect((await audit.verify({ day: days[0] })).ok).toBe(true);
  });

  it("a re-hashed edit is still caught on the next line", async () => {
    const { audit, dir } = await threeDays();
    const lines = linesOf(dir, days[0]);
    const rec = JSON.parse(lines[1]);
    rec.data.n = 42;
    rec.hash = recordHash(rec.prevHash, rec); // attacker recomputes this line's hash
    lines[1] = JSON.stringify(rec);
    writeFileSync(join(dir, `${days[0]}.jsonl`), lines.join("\n") + "\n");
    expect(await audit.verify()).toMatchObject({ ok: false, brokenAt: 3, day: days[0], line: 3 });
  });

  it("a deleted line, a garbage line and a cut-off tail are all reported", async () => {
    const a = await threeDays();
    const l = linesOf(a.dir, days[2]);
    l.splice(1, 1); // remove seq 10
    writeFileSync(join(a.dir, `${days[2]}.jsonl`), l.join("\n") + "\n");
    expect(await a.audit.verify()).toMatchObject({ ok: false, brokenAt: 10, day: days[2], line: 2 });

    const b = await threeDays();
    const g = linesOf(b.dir, days[0]);
    g[0] = "{not json";
    writeFileSync(join(b.dir, `${days[0]}.jsonl`), g.join("\n") + "\n");
    expect(await b.audit.verify()).toMatchObject({ ok: false, brokenAt: 1, day: days[0], line: 1 });

    const c = await threeDays();
    const t = linesOf(c.dir, days[2]);
    writeFileSync(join(c.dir, `${days[2]}.jsonl`), t.slice(0, 2).join("\n") + "\n"); // drop seq 11 and 12
    const v = await c.audit.verify();
    expect(v).toMatchObject({ ok: false, brokenAt: 11, day: days[2], line: 3 });
    expect(v.reason).toMatch(/missing at the end/);
  });
});

describe("restart", () => {
  it("continues the chain after a restart", async () => {
    const first = setup();
    await first.audit.append(input(1));
    await first.audit.append(input(2));
    const second = createAuditLog({ logger: createNullLogger(), clock: first.clock, paths: { dataDir: first.dataDir } });
    const r3 = await second.append(input(3));
    expect(r3.seq).toBe(3);
    expect(await second.verify()).toMatchObject({ ok: true, checked: 3 });
  });

  it("a torn final line from a crash is reported but new records still chain from the last good one", async () => {
    const first = setup();
    await first.audit.append(input(1));
    appendFileSync(join(first.dir, "2026-10-19.jsonl"), '{"seq":2,"at":"2026'); // crash mid-write
    const second = createAuditLog({ logger: createNullLogger(), clock: first.clock, paths: { dataDir: first.dataDir } });
    const r = await second.append(input(2));
    expect(r.seq).toBe(2);
    const lines = linesOf(first.dir, "2026-10-19");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).seq).toBe(2);
    expect(await second.verify()).toMatchObject({ ok: false, brokenAt: 2, line: 2 });
  });

  it("a log shorter than its head keeps the head's chain (so the gap stays visible)", async () => {
    const first = setup();
    for (let i = 1; i <= 3; i += 1) await first.audit.append(input(i));
    const l = linesOf(first.dir, "2026-10-19");
    writeFileSync(join(first.dir, "2026-10-19.jsonl"), l.slice(0, 1).join("\n") + "\n");
    const second = createAuditLog({ logger: createNullLogger(), clock: first.clock, paths: { dataDir: first.dataDir } });
    const r = await second.append(input(4));
    expect(r.seq).toBe(4);
    expect(await second.verify()).toMatchObject({ ok: false, brokenAt: 2, line: 2 });
  });
});

describe("two processes appending to one log (regression: CLI keys create while the Bridge runs)", () => {
  it("keeps one unbroken chain when two AuditLog instances share a directory", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-audit-2p-"));
    const server = createAuditLog({ paths: { dataDir } });
    const cli = createAuditLog({ paths: { dataDir } });
    await cli.append({ type: "key.created", data: { n: 1 } });
    await server.append({ type: "order.refused", data: { n: 2 } });
    await server.append({ type: "order.refused", data: { n: 3 } });
    await cli.append({ type: "key.created", data: { n: 4 } });
    await server.append({ type: "order.placed", data: { n: 5 } });
    const v = await createAuditLog({ paths: { dataDir } }).verify();
    expect(v).toMatchObject({ ok: true, checked: 5 });
    expect(server.head().seq).toBe(5);
  });
});
