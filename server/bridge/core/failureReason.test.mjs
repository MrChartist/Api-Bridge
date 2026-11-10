import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./errors.mjs";
import { describeFailure, fixFor } from "./failureReason.mjs";

describe("failure reasons", () => {
  it("every API code has a fix, and the job's own reasons too", () => {
    for (const code of Object.keys(ERROR_CODES)) expect(fixFor(code).length, code).toBeGreaterThan(15);
    for (const r of ["disk_limit", "disk_full", "disk_low", "internal", "session_lost", "kill_switch", "items_failed", "LOGIN_MISSING", "UNIVERSE_UNRESOLVED", "NOT_REALTIME", "feed-silent"]) {
      expect(fixFor(r), r).not.toMatch(/^Resume the job to try again\. What was already saved/);
    }
  });

  it("keeps the real text, and only falls back to the catalogue when there is none", () => {
    expect(describeFailure("SESSION_EXPIRED", " The broker said the token is old. ")).toMatchObject({ code: "SESSION_EXPIRED", message: "The broker said the token is old." });
    expect(describeFailure("SYMBOL_NOT_FOUND", "").message).toMatch(/could not be matched/);
    expect(describeFailure(undefined, undefined)).toMatchObject({ code: "UNKNOWN" });
    expect(describeFailure("WEIRD", "x").fix).toMatch(/Resume the job/);
  });
});
