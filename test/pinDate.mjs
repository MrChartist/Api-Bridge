/**
 * Vitest setup: the broker adapter fixtures (option chains, expiries, session times) were recorded for the week of
 * 19 October 2026. Their tests pin Date to Monday 19 Oct 2026 09:30 IST (time still moves forward from there), so
 * they keep passing after those expiries are in the past. Other tests use the real clock or their own fake clocks.
 */
import { afterAll, beforeAll, expect, vi } from "vitest";

export const PINNED_NOW = Date.UTC(2026, 9, 19, 4, 0, 0);
const PINNED_FILES = /server\/brokers\/[^/]+\.test\.mjs$|server\/bridge\/accounts\/accountManager\.test\.mjs$/;

let pinned = false;
beforeAll(() => {
  const path = String(expect.getState().testPath ?? "").replace(/\\/g, "/");
  if (!PINNED_FILES.test(path)) return;
  vi.useFakeTimers({ toFake: ["Date"], now: PINNED_NOW, shouldAdvanceTime: true });
  pinned = true;
});
afterAll(() => {
  if (pinned) vi.useRealTimers();
});
