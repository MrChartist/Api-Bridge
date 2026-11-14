/**
 * Morning login reminders.
 *
 * Broker sessions end every night, so every trading morning the same thing happens: the TradingView alerts, the
 * spreadsheet and the Telegram status all fail because nobody logged in yet. This service nudges early. At a
 * configurable pre-open time (default 08:45 IST, trading days only) it emits ONE bus event per account that cannot be
 * used yet or whose session will end before the close:
 *
 *   account.login_needed { accountId, label, broker, method, reason, kind, endsAt? }
 *     reason  "missing" | "expired" | "error"                       the session state, or
 *             "ends_before_close"                                    connected, but the broker ends it before the close
 *     kind    "preopen"                                              the daily reminder at `remindAt`
 *             "ending_soon"                                          `warnBeforeEndMinutes` before a session that ends before the close
 *     method  the broker's login method (apiKeyToken | oauthRedirect | requestTokenExchange | sessionLogin)
 *     endsAt  ISO time (IST) when the session ends, when known
 *
 * The payload names the account by its label and says how it logs in. It carries no key, token, code, password or PIN.
 * Notification channels (Telegram, Discord, webhook) subscribe to the event by name.
 *
 * The Bridge never logs in by itself and never stores a one-time code: this only reminds. Each reminder is sent once per
 * IST day (the date is kept in <dataDir>/morning-login.json so a restart does not repeat it).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { z } from "zod";
import { isTradingDay as sessionTradingDay } from "../../lib/marketHours.mjs";
import { sharedCalendar } from "../reference/sharedCalendar.mjs";
import { isStub } from "../core/contracts.mjs";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN = 60_000;
const DAY = 86_400_000;
const IST_OFFSET_MS = 19_800_000;

/** The `morningLogin` config section (owned by the accounts module). */
export const MORNING_LOGIN_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    /** IST "HH:MM" on trading days. */
    remindAt: z.string().regex(HHMM, 'a time like "08:45" (IST, 24-hour)').default("08:45"),
    /** Warn this many minutes before a session that ends before the close (0 = no second reminder). */
    warnBeforeEndMinutes: z.number().int().min(0).max(240).default(30),
  })
  .strict();

const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMinuteOfDay = (ms) => Math.floor((((ms + IST_OFFSET_MS) % DAY) + DAY) % DAY / MIN);
const istInstant = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+05:30`);
const istIso = (ms) => (Number.isFinite(ms) ? `${new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30` : null);
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function readState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    return { reminderDate: typeof raw.reminderDate === "string" ? raw.reminderDate : null, warnedDate: typeof raw.warnedDate === "string" ? raw.warnedDate : null, warned: Array.isArray(raw.warned) ? raw.warned.map(String) : [] };
  } catch {
    return { reminderDate: null, warnedDate: null, warned: [] };
  }
}

/**
 * @param {any} deps  scoped deps: config (morningLogin section), logger, bus, clock, paths, accounts, reference (optional)
 * @param {{ timers?: { setInterval: Function, clearInterval: Function }, tickMs?: number }} [opts]
 */
export function createMorningLogin(deps, opts = {}) {
  const { bus, accounts } = deps;
  const cfg = MORNING_LOGIN_CONFIG_SCHEMA.parse(deps.config?.morningLogin ?? {});
  const log = deps.logger?.child ? deps.logger.child({ module: "morning-login" }) : deps.logger;
  const now = () => deps.clock.now();
  const timers = opts.timers ?? { setInterval, clearInterval };
  const file = deps.paths?.dataDir ? join(deps.paths.dataDir, "morning-login.json") : null;
  const state = file ? readState(file) : { reminderDate: null, warnedDate: null, warned: [] };
  let handle = null;

  const reference = (() => {
    try {
      const r = deps.reference;
      return r && !isStub(r) ? r : null;
    } catch {
      return null;
    }
  })();
  function isTradingDay(date) {
    if (reference) {
      try {
        return Boolean(reference.calendar().isTradingDay(date, "NFO"));
      } catch {
        /* fall back to weekdays */
      }
    }
    try {
      return sessionTradingDay(date, "NFO");
    } catch {
      const d = new Date(`${date}T00:00:00Z`).getUTCDay();
      return d >= 1 && d <= 5;
    }
  }

  /** The close of the NFO session on `date` (IST): the reference store's session, else its labelled default. */
  function closeOn(date, t) {
    if (reference) {
      try {
        const c = reference.session("NFO", t)?.close;
        if (typeof c === "string" && /^\d{2}:\d{2}$/.test(c)) return istInstant(date, c);
      } catch {
        /* fall back to the default */
      }
    }
    return istInstant(date, sharedCalendar().closeFor("NFO", date));
  }

  function persist() {
    if (!file) return;
    try {
      writeFileAtomic(file, JSON.stringify(state));
    } catch (err) {
      log?.warn?.("morning-login state could not be saved", { err: err?.message });
    }
  }

  /** Real broker accounts that are switched on. */
  function realAccounts() {
    return accounts.list().filter((a) => a.broker !== "paper" && a.broker !== "demo" && a.enabled !== false);
  }

  /**
   * What needs a login (or will end early) at `t`, without emitting anything.
   * @returns {Array<{ accountId: string, label: string, broker: string, method: string, reason: string, endsAt: string | null }>}
   */
  function plan(t = now()) {
    const close = closeOn(istDate(t), t);
    const out = [];
    for (const a of realAccounts()) {
      const s = a.session ?? {};
      const method = a.authKind ?? "apiKeyToken";
      if (s.state !== "connected") {
        out.push({ accountId: a.id, label: a.label, broker: a.broker, method, reason: s.state === "expired" || s.state === "error" ? s.state : "missing", endsAt: null });
        continue;
      }
      const ends = s.expiresAt ? Date.parse(s.expiresAt) : NaN;
      if (Number.isFinite(ends) && ends > t && ends < close) out.push({ accountId: a.id, label: a.label, broker: a.broker, method, reason: "ends_before_close", endsAt: istIso(ends) });
    }
    return out;
  }

  const emit = (item, kind) => {
    try {
      bus.emit("account.login_needed", { accountId: item.accountId, label: item.label, broker: item.broker, method: item.method, reason: item.reason, kind, ...(item.endsAt ? { endsAt: item.endsAt } : {}) });
    } catch (err) {
      log?.warn?.("account.login_needed could not be emitted", { err: err?.message });
    }
  };

  /** One pass: emits what is due now. Returns how many events it sent. */
  function tick() {
    if (!cfg.enabled) return 0;
    const t = now();
    const date = istDate(t);
    if (!isTradingDay(date)) return 0;
    const minute = istMinuteOfDay(t);
    const closeMinute = istMinuteOfDay(closeOn(date, t));
    let sent = 0;
    if (minute >= minutesOf(cfg.remindAt) && minute < closeMinute && state.reminderDate !== date) {
      state.reminderDate = date;
      for (const item of plan(t)) {
        emit(item, "preopen");
        sent += 1;
      }
      persist();
    }
    if (cfg.warnBeforeEndMinutes > 0 && minute < closeMinute) {
      if (state.warnedDate !== date) {
        state.warnedDate = date;
        state.warned = [];
      }
      const close = closeOn(date, t);
      let changed = false;
      for (const a of realAccounts()) {
        const ends = a.session?.state === "connected" && a.session.expiresAt ? Date.parse(a.session.expiresAt) : NaN;
        if (!Number.isFinite(ends) || ends <= t || ends >= close || ends - t > cfg.warnBeforeEndMinutes * MIN) continue;
        const key = `${a.id}@${a.session.expiresAt}`;
        if (state.warned.includes(key)) continue;
        state.warned.push(key);
        changed = true;
        emit({ accountId: a.id, label: a.label, broker: a.broker, method: a.authKind ?? "apiKeyToken", reason: "ends_before_close", endsAt: istIso(ends) }, "ending_soon");
        sent += 1;
      }
      if (changed) persist();
    }
    return sent;
  }

  return {
    config: cfg,
    plan,
    tick,
    start() {
      if (handle || !cfg.enabled) return;
      handle = timers.setInterval(() => {
        try {
          tick();
        } catch (err) {
          log?.warn?.("morning-login tick failed", { err: err?.message });
        }
      }, opts.tickMs ?? MIN);
      handle?.unref?.();
    },
    stop() {
      if (handle) timers.clearInterval(handle);
      handle = null;
    },
  };
}
