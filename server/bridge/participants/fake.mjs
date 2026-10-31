/**
 * A fake `participants` service for other streams' tests (P1-8 exposure reads latest()). It satisfies the contract
 * (core/contracts.mjs ParticipantOI) without files, clocks or network.
 *
 *   createFakeParticipants()                                  → latest() answers the demo day for asOfDate
 *   createFakeParticipants({ latest: { available: false, reason: "PARTICIPANT_STALE", detail: "…" } })
 */
import { demoParticipantDay } from "./demo.mjs";
import { INSTRUMENTS, PARTICIPANTS } from "./parser.mjs";

/** Flatten a ParticipantDay's rows into the latest() row list (CLIENT, DII, FII, PRO; no TOTAL). */
export function latestRowsOf(day) {
  const rows = [];
  for (const participant of PARTICIPANTS) for (const instrument of INSTRUMENTS) {
    const v = day?.rows?.[participant]?.[instrument];
    if (Array.isArray(v)) rows.push({ participant, instrument, long: v[0], short: v[1] });
  }
  return rows;
}

/**
 * @param {{ asOfDate?: string, latest?: object, days?: object[] }} [o]
 */
export function createFakeParticipants({ asOfDate = "2026-10-28", latest = null, days = null } = {}) {
  const calls = [];
  const day = demoParticipantDay(asOfDate);
  const list = days ?? (day ? [day] : []);
  return {
    calls,
    latest(args = {}) {
      calls.push(["latest", args]);
      if (String(args.exchange ?? "NSE").toUpperCase() === "BSE") return { available: false, reason: "NOT_FOR_BSE", detail: "No BSE participant file." };
      if (latest) return structuredClone(latest);
      if (!day) return { available: false, reason: "NO_PARTICIPANT_DATA", detail: "No participant OI file yet." };
      return { available: true, asOfDate, source: "demo", file: "demo", unit: "contracts", quality: "ok", lotRegime: null, rows: latestRowsOf(day) };
    },
    series({ from, to } = {}) {
      calls.push(["series", { from, to }]);
      return list.filter((d) => (!from || d.date >= from) && (!to || d.date <= to)).map((d) => ({ exchange: "NSE", unit: "contracts", quality: "ok", lotRegime: null, source: "demo", ...d }));
    },
    status() {
      return { enabled: true, demo: true, source: { nseArchives: "demo", setBy: "demo", verified: false }, latestDate: asOfDate, lastAttemptAt: null, lastError: null, nextRunAt: null, backfill: { enabled: true, target: 0, have: 0, noFile: 0, failed: 0, running: false, cursor: null, done: true, pausedUntil: null, lastErrorCode: null }, rows: list.length, diskBytes: 0 };
    },
    async sync() {
      calls.push(["sync"]);
      return { fetched: [], noFile: [], failed: [] };
    },
  };
}
