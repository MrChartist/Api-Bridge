/**
 * The single-session policy flag: brokers where a second login for the same app ends the first session. The Bridge warns
 * about it before login (GET /v1/brokers carries singleSession: true; the dashboard shows the warning).
 */
import { describe, expect, it } from "vitest";
import { createBrokerRegistry } from "./registry.mjs";

describe("capabilities.auth.singleSession", () => {
  it("is set for the XTS family, whose documentation allows one session per app key pair, and for no one else", () => {
    const reg = createBrokerRegistry();
    const flagged = reg.list().filter((id) => reg.get(id).capabilities?.auth?.singleSession === true).sort();
    expect(flagged).toEqual(["anandrathi", "compositedge", "fivepaisaxts", "ibulls", "iifl", "jainamxts", "rmoney", "wisdom"]);
  });
});
