/**
 * The real reason a background job (a download, a recording) did not work, in plain words with the fix.
 *
 * A job fails for one of three kinds of reason: an API problem code (the broker said no: SESSION_EXPIRED,
 * UPSTREAM_RATE_LIMITED, SYMBOL_NOT_FOUND ...), a reason of the job itself (the disk limit, an internal error) or a
 * recorder condition (the feed went quiet, no login). Every one gets the same shape,
 *
 *   { code, message, fix }
 *
 * where `code` is the machine-readable reason, `message` is what happened (the real text, never replaced by a generic
 * one) and `fix` is what to do next. API codes take their fix from the error catalogue (errorCatalogue.mjs) so the
 * wording is written once; the few that mean something more specific for a job are overridden below.
 */
import { ERROR_GUIDE } from "./errorCatalogue.mjs";

/** code -> fix for reasons that are not API codes, or whose meaning inside a job is more specific. */
const JOB_FIX = Object.freeze({
  SESSION_EXPIRED: "Log in to your broker again on the Accounts page, then resume the job. What was already saved is kept.",
  BROKER_UNAVAILABLE: "Check that the broker is reachable and an account is logged in on the Accounts page, then resume the job.",
  UPSTREAM_RATE_LIMITED: "Nothing is lost. The Bridge waits and tries again by itself; resume the job to try now, or lower downloads.maxBudgetShare.",
  UPSTREAM_TIMEOUT: "The broker did not answer. Check your internet connection and resume the job.",
  SYMBOL_NOT_FOUND: "The broker has no history for this symbol. Check the spelling with GET /v1/symbols/resolve, remove it from the job, or (for an expired contract) start a new job with allowExpired.",
  CAPABILITY_UNSUPPORTED: "The connected broker does not give this kind of history. Use another broker account (account), or turn on backup sources (backup: true) to accept delayed or end-of-day data.",
  VALIDATION_FAILED: "The broker refused the request, for example a range or interval it does not serve. Change the range or the interval and start a new job.",
  ACCOUNT_NOT_FOUND: "The account of this job no longer exists. Start a new job with an account that is listed on the Accounts page.",
  KILL_SWITCH_ACTIVE: "The kill switch is on. Release it on the Safety page, then resume the job.",
  DISK_LIMIT: "The downloads folder reached its limit (downloads.maxDiskMb). Delete old downloads, or raise the limit and resume the job.",
  disk_limit: "The downloads folder reached its limit (downloads.maxDiskMb). Delete old downloads, or raise the limit and resume the job.",
  DISK_LOW: "The disk is almost full. Free some space (delete old downloads or recordings), then resume.",
  disk_low: "The disk is almost full. Free some space (delete old downloads or recordings), then resume.",
  disk_full: "A disk limit was reached, so writing stopped. Delete old recordings or raise recorder.maxDiskMb in bridge.config.json and restart the Bridge.",
  internal: "This is a fault in the Bridge, not in your request. Resume the job to try again; if it fails again, look in the Bridge log and report it.",
  session_lost: "The broker session ended. Log in again on the Accounts page; the job continues by itself.",
  kill_switch: "The kill switch is on. Release it on the Safety page; the job continues.",
  LOGIN_MISSING: "No broker account is logged in. Log in on the Accounts page; recording starts by itself as soon as a price feed is available.",
  UNIVERSE_UNRESOLVED: "The symbols to record could not be chosen right now (for example the underlying price is missing). It tries again by itself; check the notes on the recording.",
  NOT_REALTIME: "A recording saves real-time data only. Connect a broker account with a live feed; delayed and end-of-day data is never recorded.",
  feed_silent: "A gap is marked in the file. It carries on when prices come back.",
  "feed-silent": "A gap is marked in the file. It carries on when prices come back.",
  "feed-down": "The live feed was down and the broker could not be read instead. It carries on when the feed is back.",
  "login-missing": "No broker account is logged in. Log in on the Accounts page; recording starts by itself.",
  items_failed: "Some items failed. See each failed item for its own reason, fix it, then resume the job to try those again.",
});

const GENERIC = "Resume the job to try again. What was already saved is kept. If it keeps failing, read the message above or look in the Bridge log.";

/** The fix for a code: the job-specific words, else the catalogue's, else a generic line. */
export function fixFor(code) {
  return JOB_FIX[code] ?? ERROR_GUIDE[code]?.fix ?? GENERIC;
}

/**
 * @param {string | null | undefined} code
 * @param {string | null | undefined} message the real text of what happened
 * @returns {{ code: string, message: string, fix: string }}
 */
export function describeFailure(code, message) {
  const c = typeof code === "string" && code ? code : "UNKNOWN";
  const m = typeof message === "string" && message.trim() ? message.trim() : (ERROR_GUIDE[c]?.means ?? "The job stopped and the Bridge did not record why.");
  return { code: c, message: m, fix: fixFor(c) };
}
