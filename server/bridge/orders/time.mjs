/**
 * IST time helpers for orders. India has no daylight saving, so IST is always UTC+05:30; nothing here reads the
 * host's time zone.
 */

export const IST_OFFSET_MS = 19_800_000;
export const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" of the IST calendar day that contains `ms`. */
export function istDay(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms of the next IST midnight after `ms` (the end of that IST day). */
export function endOfIstDay(ms) {
  return Date.parse(`${istDay(ms)}T00:00:00+05:30`) + DAY_MS;
}

/** ISO-8601 with the +05:30 offset, e.g. 2026-10-19T09:30:00.000+05:30. */
export function istIso(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().replace("Z", "+05:30");
}

/**
 * Retention for idempotency keys and clientOrderIds: until the end of the IST trading day and at least 24 hours.
 * @param {number} createdAt epoch ms
 */
export function idempotencyExpiry(createdAt) {
  return Math.max(endOfIstDay(createdAt), createdAt + DAY_MS);
}
