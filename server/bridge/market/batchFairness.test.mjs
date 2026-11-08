/**
 * Micro-batches are per consumer. A light reader's symbols must not ride in a heavy reader's batch (a batch is credited
 * to whoever opened it, so the light reader would wait in the heavy reader's place in the fair queue). The price is
 * that different symbols asked by two consumers in the same window cost two broker calls, not one. These tests pin
 * both sides with a counting adapter.
 */
import { describe, expect, it } from "vitest";
import { runAsConsumer } from "../ratelimit/consumer.mjs";
import { buildMarket, stubAdapter } from "./__fixtures__/helpers.mjs";

const HEAVY = ["NSE:RELIANCE", "NSE:INFY", "NSE:NIFTY", "NSE:M&M", "BSE:SENSEX"];
const LIGHT = ["NSE:INFY", "NSE:M&M", "NSE:STK01"];

const asKey = (id, fn) => runAsConsumer(`Key: ${id}`, fn, { key: { id, clientKind: "script", label: id }, principal: { kind: "key", id } });
const asNobody = (_id, fn) => fn();

function market() {
  const adapter = stubAdapter("zerodha");
  const built = buildMarket({ adapters: { zerodha: adapter }, accounts: [{ id: "zerodha-main", broker: "zerodha", adapter, creds: { apiKey: "k", accessToken: "t" } }] });
  const quoteCalls = () => adapter.calls.filter((c) => c[0] === "fetchQuotes").map((c) => c[1].length);
  return { ...built, quoteCalls };
}

/** Two readers ask in the same batch window. */
async function twoReaders(wrap) {
  const { md, clock, quoteCalls } = market();
  const heavy = wrap("heavy", () => md.ltp(HEAVY));
  const light = wrap("light", () => md.ltp(LIGHT));
  await clock.advance(60);
  const [h, l] = await Promise.all([heavy, light]);
  return { h, l, calls: quoteCalls() };
}

describe("quote batches are per consumer", () => {
  it("keeps two consumers' batches apart and still shares the symbols they both asked for", async () => {
    const { h, l, calls } = await twoReaders(asKey);
    expect(h.errors).toEqual([]);
    expect(l.errors).toEqual([]);
    expect(h.items).toHaveLength(HEAVY.length);
    expect(l.items).toHaveLength(LIGHT.length);
    // INFY and M&M were already in flight for the heavy reader, so the light reader joins them and only asks for its
    // own extra symbol in a batch of its own: two broker calls, 5 + 1 symbols.
    expect([...calls].sort()).toEqual([1, 5]);
  });

  it("makes one call when both readers are the same consumer (the earlier behaviour)", async () => {
    const { h, l, calls } = await twoReaders(asNobody);
    expect(h.items).toHaveLength(HEAVY.length);
    expect(l.items).toHaveLength(LIGHT.length);
    expect(calls).toEqual([6]);
  });

  it("makes two calls for different symbols from two consumers, one when they share a consumer", async () => {
    const run = async (wrap) => {
      const { md, clock, quoteCalls } = market();
      const a = wrap("a", () => md.ltp(["NSE:RELIANCE"]));
      const b = wrap("b", () => md.ltp(["NSE:INFY"]));
      await clock.advance(60);
      await Promise.all([a, b]);
      return quoteCalls().length;
    };
    expect(await run(asKey)).toBe(2);
    expect(await run(asNobody)).toBe(1);
  });
});
