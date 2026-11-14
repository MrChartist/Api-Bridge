/**
 * The outbox: messages waiting to be sent, kept on disk so a restart (or a crash) does not lose them. One JSON file
 * (dataDir/notify/outbox.json, mode 0600), rewritten atomically (temp file, fsync, rename) after every change, so a
 * reader sees the old file or the new one, never half of one. Bounded: when it is full the oldest message that is
 * not critical is dropped first (and counted), so a long Telegram outage cannot fill the disk or replay a flood.
 *
 * Holds only the text to send and which target and chat it is for (a chat KEY, never the chat id and never a token).
 * A file that cannot be read is moved aside (`outbox.json.corrupt-<stamp>`) and the outbox starts empty.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic, quarantine } from "../../lib/jsonl.mjs";

const VERSION = 1;

/**
 * @typedef {{ id: string, seq: number, targetId: string, chatKey: string, text: string, kind: "event"|"reply"|"test"|"digest",
 *   critical: boolean, silent: boolean, createdAt: number, nextAttemptAt: number, attempts: number, holdUntil?: number,
 *   maxAgeMs: number, event?: string, lastError?: { kind: string, at: number } }} OutboxItem
 */

/**
 * @param {{ file: string, max?: number, now?: () => number, logger?: any }} opts
 */
export function createOutbox({ file, max = 200, now = () => Date.now(), logger }) {
  /** @type {OutboxItem[]} */
  let items = [];
  let nextSeq = 1;
  let dropped = 0;
  let saveError = null;

  function load() {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw?.version !== VERSION || !Array.isArray(raw.items)) throw new Error("unexpected format");
      items = raw.items.filter((i) => i && typeof i.id === "string" && typeof i.text === "string" && typeof i.targetId === "string" && typeof i.chatKey === "string");
      nextSeq = Number.isInteger(raw.nextSeq) ? raw.nextSeq : items.reduce((m, i) => Math.max(m, i.seq ?? 0), 0) + 1;
      dropped = Number.isInteger(raw.dropped) ? raw.dropped : 0;
    } catch (err) {
      logger?.warn?.("notify outbox could not be read; starting empty", { code: err?.code ?? "PARSE" });
      try {
        quarantine(file, { now: now() });
      } catch {
        /* nothing more to do */
      }
      items = [];
    }
  }

  function save() {
    try {
      writeFileAtomic(file, JSON.stringify({ version: VERSION, nextSeq, dropped, items }));
      saveError = null;
    } catch (err) {
      saveError = err?.code ?? "WRITE";
      logger?.error?.("notify outbox could not be saved", { code: saveError });
    }
  }

  load();

  return {
    /** @param {Omit<OutboxItem, "id"|"seq"|"createdAt"|"attempts"|"nextAttemptAt"> & { createdAt?: number, nextAttemptAt?: number }} input */
    add(input) {
      const t = now();
      if (items.length >= max) {
        // Drop the oldest message that is not critical; if all are critical, the oldest of them.
        let idx = items.findIndex((i) => !i.critical);
        if (idx < 0) idx = 0;
        items.splice(idx, 1);
        dropped += 1;
      }
      const seq = nextSeq++;
      /** @type {OutboxItem} */
      const item = { attempts: 0, createdAt: t, nextAttemptAt: t, ...input, id: `ob_${seq}`, seq };
      items.push(item);
      save();
      return item;
    },
    /** Items that may be sent now: not held, retry time reached; oldest first. */
    due(t = now()) {
      return items.filter((i) => i.nextAttemptAt <= t && (i.holdUntil ?? 0) <= t).sort((a, b) => a.seq - b.seq);
    },
    /** @param {string} id @param {Partial<OutboxItem>} patch */
    update(id, patch) {
      const i = items.find((x) => x.id === id);
      if (!i) return null;
      Object.assign(i, patch);
      save();
      return i;
    },
    remove(id) {
      const n = items.length;
      items = items.filter((i) => i.id !== id);
      if (items.length !== n) save();
      return items.length !== n;
    },
    /** Remove every item for a target (it was deleted) or one chat of it. */
    removeFor(targetId, chatKey) {
      const n = items.length;
      items = items.filter((i) => !(i.targetId === targetId && (chatKey === undefined || i.chatKey === chatKey)));
      if (items.length !== n) save();
      return n - items.length;
    },
    /** Replace a set of items by one (a digest). */
    replace(ids, item) {
      const set = new Set(ids);
      const first = items.findIndex((i) => set.has(i.id));
      items = items.filter((i) => !set.has(i.id));
      const seq = nextSeq++;
      const added = { attempts: 0, createdAt: now(), nextAttemptAt: now(), ...item, id: `ob_${seq}`, seq };
      items.splice(first < 0 ? items.length : Math.min(first, items.length), 0, added);
      save();
      return added;
    },
    list: () => items.map((i) => ({ ...i })),
    size: () => items.length,
    stats() {
      const t = now();
      const waiting = items.filter((i) => (i.holdUntil ?? 0) > t).length;
      return { depth: items.length, held: waiting, dropped, oldestAt: items.length ? Math.min(...items.map((i) => i.createdAt)) : null, saveError };
    },
    /** Drop messages that are too old to be useful. @returns {OutboxItem[]} the dropped ones */
    expire(t = now()) {
      // Age counts from when the message could first be sent (a message held over night is not old at 07:00).
      const gone = items.filter((i) => (i.holdUntil ?? 0) <= t && t - Math.max(i.createdAt, i.holdUntil ?? 0) > i.maxAgeMs);
      if (gone.length) {
        const ids = new Set(gone.map((i) => i.id));
        items = items.filter((i) => !ids.has(i.id));
        dropped += gone.length;
        save();
      }
      return gone;
    },
  };
}
