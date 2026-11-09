import { describe, expect, it } from "vitest";
import { createTicketBook } from "./tickets.mjs";

const T0 = Date.parse("2026-10-19T09:30:00+05:30");

function make() {
  let t = T0;
  const book = createTicketBook({ now: () => t, ticketTtlMs: 60_000, confirmTokenTtlMs: 60_000, maxOpen: 3 });
  return { book, advance: (ms) => (t += ms) };
}

const input = (over = {}) => ({
  order: { account: "zerodha-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400, mode: "live" },
  accountId: "zerodha-main",
  fingerprint: "fp1",
  source: "mcp",
  client: "Claude",
  principalId: "key:mcp1",
  checks: [],
  estimatedValue: 1400,
  ...over,
});
const expectFor = { fingerprint: "fp1", accountId: "zerodha-main", principalId: "key:mcp1" };

describe("ticket book", () => {
  it("opens, lists (OpenAPI shape, IST times) and confirms a ticket once", () => {
    const { book } = make();
    const t = book.open(input());
    expect(t.ticketId).toMatch(/^tkt_/);
    expect(t.createdAt).toBe("2026-10-19T09:30:00.000+05:30");
    expect(t.expiresAt).toBe("2026-10-19T09:31:00.000+05:30");
    expect(book.list().map((x) => x.ticketId)).toEqual([t.ticketId]);
    const c = book.confirm(t.ticketId, "key:admin");
    expect(c.confirmToken).toMatch(/^mct_/);
    expect(book.list()).toEqual([]);
    expect(() => book.confirm(t.ticketId, "key:admin")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("binds the token to the exact order, account and client, and burns it once", () => {
    const { book } = make();
    const { confirmToken } = book.confirm(book.open(input()).ticketId, "key:admin");
    expect(book.verify(confirmToken, { ...expectFor, fingerprint: "other" })).toMatchObject({ ok: false, message: expect.stringMatching(/different order/) });
    expect(book.verify(confirmToken, { ...expectFor, accountId: "dhan-main" }).ok).toBe(false);
    expect(book.verify(confirmToken, { ...expectFor, principalId: "key:someone" })).toMatchObject({ ok: false, message: expect.stringMatching(/different client/) });
    expect(book.verify("mct_forged_token_value_xxxxxxxxxx", expectFor).ok).toBe(false);
    expect(book.verify(confirmToken, expectFor).ok).toBe(true);
    expect(book.consume(confirmToken, expectFor)).toBe(true);
    expect(book.consume(confirmToken, expectFor)).toBe(false);
  });

  it("expires unconfirmed tickets and unused tokens", () => {
    const { book, advance } = make();
    const t = book.open(input());
    advance(60_001);
    expect(book.list()).toEqual([]);
    expect(() => book.confirm(t.ticketId, "a")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    const { confirmToken } = book.confirm(book.open(input()).ticketId, "a");
    advance(60_001);
    expect(book.verify(confirmToken, expectFor).ok).toBe(false);
  });

  it("caps the number of open tickets", () => {
    const { book } = make();
    book.open(input());
    book.open(input());
    book.open(input());
    expect(() => book.open(input())).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
  });
});

describe("ticket book: declining", () => {
  it("declines an open ticket once: it leaves the pending list, joins the recent declined list, and can never be confirmed", () => {
    const { book } = make();
    const t = book.open(input());
    const r = book.reject(t.ticketId, "local:cli", "  Wrong\nquantity  ");
    expect(r.alreadyRejected).toBe(false);
    expect(r.ticket).toMatchObject({ ticketId: t.ticketId, status: "rejected", reason: "Wrong quantity", rejectedAt: "2026-10-19T09:30:00.000+05:30" });
    expect(book.list()).toEqual([]);
    expect(book.listRejected().map((x) => x.ticketId)).toEqual([t.ticketId]);
    // reject, then confirm: a clear 409, no token
    expect(() => book.confirm(t.ticketId, "key:admin")).toThrow(expect.objectContaining({ code: "STATE_CONFLICT", status: 409, retryable: false, fields: { ticketId: t.ticketId, state: "rejected" } }));
    expect(book.verifyTicket(t.ticketId, expectFor)).toMatchObject({ ok: false, message: expect.stringMatching(/declined/) });
    expect(book.statusOf(t.ticketId)).toMatchObject({ status: "rejected", reason: "Wrong quantity", principalId: "key:mcp1" });
  });

  it("is idempotent: declining again answers the same state and keeps the first reason", () => {
    const { book } = make();
    const t = book.open(input());
    const first = book.reject(t.ticketId, "local:cli", "first");
    const again = book.reject(t.ticketId, "local:other", "second");
    expect(again.alreadyRejected).toBe(true);
    expect(again.ticket).toEqual(first.ticket);
  });

  it("refuses a confirmed, used or expired ticket with its state (confirm then reject)", () => {
    const { book, advance } = make();
    const a = book.open(input());
    const { confirmToken } = book.confirm(a.ticketId, "key:admin");
    expect(() => book.reject(a.ticketId, "x")).toThrow(expect.objectContaining({ code: "STATE_CONFLICT", status: 409, fields: { ticketId: a.ticketId, state: "confirmed" } }));
    expect(book.consume(confirmToken, expectFor)).toBe(true);
    expect(() => book.reject(a.ticketId, "x")).toThrow(expect.objectContaining({ fields: { ticketId: a.ticketId, state: "consumed" } }));
    advance(100);
    expect(() => book.reject(a.ticketId, "x")).toThrow(expect.objectContaining({ fields: { ticketId: a.ticketId, state: "consumed" } }));
    const b = book.open(input());
    advance(60_001);
    expect(() => book.reject(b.ticketId, "x")).toThrow(expect.objectContaining({ fields: { ticketId: b.ticketId, state: "expired" } }));
    expect(() => book.reject("tkt_unknown", "x")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("a ticket confirmed and then left unused reads as expired", () => {
    const { book, advance } = make();
    const a = book.open(input());
    book.confirm(a.ticketId, "key:admin");
    expect(book.statusOf(a.ticketId).status).toBe("confirmed");
    advance(60_001);
    expect(book.statusOf(a.ticketId).status).toBe("expired");
  });

  it("forgets declined tickets after the trail window and keeps the trail bounded", () => {
    let t = T0;
    const book = createTicketBook({ now: () => t, ticketTtlMs: 60_000, confirmTokenTtlMs: 60_000, maxOpen: 10, trailTtlMs: 5 * 60_000, trailMax: 2 });
    const ids = [0, 1, 2].map(() => book.open(input()).ticketId);
    for (const id of ids) book.reject(id, "x");
    expect(book.listRejected().map((x) => x.ticketId)).toEqual([ids[2], ids[1]]);
    t += 5 * 60_000 + 1;
    expect(book.listRejected()).toEqual([]);
    expect(book.statusOf(ids[2])).toBeNull();
  });

  it("a declined ticket frees its place among the open ones", () => {
    const { book } = make();
    const ids = [0, 1, 2].map(() => book.open(input()).ticketId);
    expect(() => book.open(input())).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
    book.reject(ids[0], "x");
    expect(() => book.open(input())).not.toThrow();
  });
});
