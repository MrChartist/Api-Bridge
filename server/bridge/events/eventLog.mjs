/**
 * The event log: every event the Bridge offers, in order, with a cursor, kept on disk so a client that was away (or a
 * Bridge that restarted) can ask "everything after cursor N".
 *
 *  - cursor: the event's number, counting up from 1 for as long as the log file lives. Sent as a string ("1042") in the
 *    `id` of every event; clients treat it as opaque and give it back as `since=` or `Last-Event-ID`.
 *  - storage: dataDir/events/log.jsonl, one JSON line per event (mode 0600), appended as events arrive and rewritten
 *    atomically (temp file, fsync, rename) to the last `retain` events when it grows past twice that. The same events are
 *    kept in memory, so a replay never reads the disk.
 *  - a restart reads the file back: the numbering continues, so a cursor from before the restart still works. A torn last
 *    line (a crash in mid-write) is skipped. If the file is deleted the numbering starts again at 1; a client that asks
 *    for a cursor beyond the newest event is told (`gap`), not silently given nothing.
 *  - noisy topics (see catalog.mjs `throttleMs`) keep at most one event per key per interval; the rest are counted.
 *
 * Time is injected (`now`), nothing here starts a timer.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendLineSync, compact, quarantine, readLinesSync } from "../../lib/jsonl.mjs";
import { noteCorruptLines } from "../../lib/safeStore.mjs";
import { isOfferedTopic, topicInfo } from "./catalog.mjs";
import { sanitizePayload } from "./sanitize.mjs";

export const CURSOR_RE = /^\d{1,15}$/;

/** @typedef {{ seq: number, topic: string, at: number, data: object }} LoggedEvent */

/** The JSON a client receives for one event (SSE `data:`, WebSocket frame, webhook body, replay route). */
export const toEnvelope = (e) => ({ id: String(e.seq), topic: e.topic, time: new Date(e.at).toISOString(), apiVersion: "v1", data: e.data });

/**
 * @param {{ dir: string, retain?: number, maxEventBytes?: number, now?: () => number, logger?: any }} opts
 */
export function createEventLog({ dir, retain = 5000, maxEventBytes = 16_384, now = () => Date.now(), logger }) {
  const file = join(dir, "log.jsonl");
  /** @type {LoggedEvent[]} */
  let ring = [];
  let seq = 0;
  let linesOnDisk = 0;
  let writeErrors = 0;
  let throttled = 0;
  let recorded = 0;
  const lastSeen = new Map();
  const listeners = new Set();

  const valid = (r) => r && Number.isSafeInteger(r.seq) && r.seq > 0 && typeof r.topic === "string" && Number.isFinite(r.at) && r.data && typeof r.data === "object";
  try {
    const { items, corrupt, tornTail } = readLinesSync(file);
    const ok = items.filter(valid).sort((a, b) => a.seq - b.seq);
    if (corrupt > 0 && ok.length === 0 && existsSync(file)) {
      const to = quarantine(file, { now: now(), what: "event log", reason: "had no readable lines" });
      logger?.warn?.(`event log: ${file} had no readable lines and was moved aside to ${to}. Starting with an empty event log.`, { file, movedTo: to });
    } else if (corrupt > 0) noteCorruptLines(file, { what: "event log", corrupt, log: logger, now: now() });
    ring = ok.slice(-retain);
    seq = ring.at(-1)?.seq ?? 0;
    linesOnDisk = items.length + corrupt + (tornTail ? 1 : 0);
  } catch (err) {
    logger?.warn?.("event log could not be read; starting empty", { code: err?.code ?? "READ" });
  }

  function persist(evt) {
    try {
      appendLineSync(file, evt);
      linesOnDisk += 1;
      if (linesOnDisk > retain * 2) {
        compact(file, ring);
        linesOnDisk = ring.length;
      }
    } catch (err) {
      writeErrors += 1;
      if (writeErrors === 1 || writeErrors % 100 === 0) logger?.error?.("event log could not be written", { code: err?.code ?? "WRITE", failures: writeErrors });
    }
  }

  return {
    /**
     * Add an event from the bus. Returns the logged event, or null when the topic is not offered or the event was throttled.
     * @param {string} topic @param {unknown} payload
     * @returns {LoggedEvent | null}
     */
    record(topic, payload) {
      if (!isOfferedTopic(topic)) return null;
      const t = now();
      const info = topicInfo(topic);
      if (info?.throttleMs) {
        const keyed = info.key && payload && typeof payload === "object" ? String(payload[info.key] ?? "") : "";
        const k = `${topic}|${keyed}`;
        const last = lastSeen.get(k);
        if (last !== undefined && t - last < info.throttleMs) {
          throttled += 1;
          return null;
        }
        if (lastSeen.size >= 2000) lastSeen.delete(lastSeen.keys().next().value);
        lastSeen.set(k, t);
      }
      seq += 1;
      /** @type {LoggedEvent} */
      const evt = { seq, topic, at: t, data: sanitizePayload(payload, { maxBytes: maxEventBytes }) };
      ring.push(evt);
      if (ring.length > retain) ring.splice(0, ring.length - retain);
      recorded += 1;
      persist(evt);
      for (const l of [...listeners]) {
        try {
          l(evt);
        } catch (err) {
          logger?.error?.("event listener failed", { code: err?.code });
        }
      }
      return evt;
    },
    /** Be told of every new event, after it is stored. @returns {() => void} */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Events after a cursor, oldest first, that pass `filter`.
     * @param {number | null} after  cursor number; null = nothing replayed (live only)
     * @param {{ limit?: number, filter?: (e: LoggedEvent) => boolean }} [opts]
     * @returns {{ events: LoggedEvent[], oldest: number | null, latest: number, gap: boolean, gapReason: "retention"|"cursor_ahead"|null, more: boolean }}
     */
    since(after, { limit = retain, filter } = {}) {
      const latest = seq;
      const oldest = ring[0]?.seq ?? null;
      if (after === null) return { events: [], oldest, latest, gap: false, gapReason: null, more: false };
      let gapReason = null;
      if (after > latest) gapReason = "cursor_ahead";
      else if (oldest !== null && after + 1 < oldest) gapReason = "retention";
      const out = [];
      let more = false;
      for (const e of ring) {
        if (e.seq <= after) continue;
        if (filter && !filter(e)) continue;
        if (out.length >= limit) {
          more = true;
          break;
        }
        out.push(e);
      }
      return { events: out, oldest, latest, gap: gapReason !== null, gapReason, more };
    },
    latest: () => seq,
    stats: () => ({ latest: seq, oldest: ring[0]?.seq ?? null, kept: ring.length, retain, recorded, throttled, writeErrors, listeners: listeners.size }),
  };
}
