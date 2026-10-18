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
