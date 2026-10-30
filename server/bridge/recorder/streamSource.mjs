/**
 * Stream source (stream S17, docs/spec/p1-01-recorder.md §5.1 rule 1, M5). The recorder's subscriptions on the shared
 * stream hub: internal hub clients "recorder:0", "recorder:1" … of at most `maxSymbolsPerClient` (500) symbols each,
 * subscribed in chunks of `maxSymbolsPerRequest` (200), in "quote" mode. The hub reference-counts symbols across
 * clients, so a chain a page already streams costs nothing extra.
 *
 * `setDesired()` subscribes new symbols BEFORE it unsubscribes old ones, so an ATM re-centre never leaves a hole.
 * Legs are read from the hub's last tick per symbol (`lastTick`), with the time each leg was last received, so a
 * quiet leg is recorded with its age and a dead feed is decided for the whole chain from the hub's feed status.
 */

export const CLIENT_PREFIX = "recorder";

/**
 * @param {{ hub: object, maxPerClient?: number, maxPerRequest?: number, logger?: any, prefix?: string }} opts
 *   prefix: the hub client id prefix ("recorder"; the live events engine uses "events")
 */
export function createStreamSource({ hub, maxPerClient = 500, maxPerRequest = 200, logger, prefix = CLIENT_PREFIX }) {
  /** symbol -> client id */
  const owner = new Map();
  /** client id -> Set(symbol) */
  const clients = new Map();
  /** Symbols the hub refused last time, with the reason. */
  let rejected = [];
  let chain = Promise.resolve();

  const clientWithRoom = () => {
    for (const [id, set] of clients) if (set.size < maxPerClient) return id;
    const id = `${prefix}:${clients.size}`;
    clients.set(id, new Set());
    return id;
  };

  async function subscribe(symbols) {
    const byClient = new Map();
    for (const s of symbols) {
      const id = clientWithRoom();
      clients.get(id).add(s);
      owner.set(s, id);
      if (!byClient.has(id)) byClient.set(id, []);
      byClient.get(id).push(s);
    }
    const refused = [];
    for (const [id, list] of byClient) {
      for (let i = 0; i < list.length; i += maxPerRequest) {
        const part = list.slice(i, i + maxPerRequest);
        let res;
        try {
          res = await hub.subscribe(id, part, "quote");
        } catch (err) {
          res = { accepted: [], rejected: part.map((symbol) => ({ symbol, code: err?.code ?? "STREAM_ERROR", message: err?.message ?? "subscribe failed" })) };
        }
        for (const r of res?.rejected ?? []) {
          refused.push(r);
          const sym = typeof r === "string" ? r : r.symbol;
          // The hub may answer with a canonical form; drop whichever we asked for.
          const asked = part.find((p) => p === sym) ?? sym;
          clients.get(id)?.delete(asked);
          owner.delete(asked);
        }
      }
    }
    return refused;
  }

  function unsubscribe(symbols) {
    const byClient = new Map();
    for (const s of symbols) {
      const id = owner.get(s);
      if (!id) continue;
      owner.delete(s);
      clients.get(id)?.delete(s);
      if (!byClient.has(id)) byClient.set(id, []);
      byClient.get(id).push(s);
    }
    for (const [id, list] of byClient) {
      try {
        hub.unsubscribe(id, list);
      } catch (err) {
        logger?.warn?.("recorder unsubscribe failed", { client: id, err: err?.message });
      }
    }
  }

  return {
    /**
     * Hold exactly `desired` (subscribe the new ones first, then drop the rest). Serialised.
     * @param {Iterable<string>} desired canonical symbols
     * @returns {Promise<{ added: number, removed: number, rejected: object[] }>}
     */
    setDesired(desired) {
      const want = new Set(desired);
      const run = chain.then(async () => {
        const add = [...want].filter((s) => !owner.has(s));
        const drop = [...owner.keys()].filter((s) => !want.has(s));
        rejected = add.length ? await subscribe(add) : rejected.filter((r) => want.has(r.symbol));
        if (drop.length) unsubscribe(drop);
        return { added: add.length - rejected.length, removed: drop.length, rejected };
      });
      chain = run.catch(() => {});
      return run;
    },
    /** Symbols held now. */
    held: () => new Set(owner.keys()),
    holds: (symbol) => owner.has(symbol),
    rejected: () => [...rejected],
    /** Leg fields from the hub's last tick (null when none yet). */
    leg(symbol) {
      const t = hub.lastTick(symbol);
      if (!t) return null;
      return { ltp: t.ltp ?? null, bid: t.bid ?? null, ask: t.ask ?? null, bidQty: t.bidQty ?? null, askQty: t.askQty ?? null, oi: t.oi ?? null, volume: t.volume ?? null, at: t.receivedAt ?? null, accountId: t.accountId ?? null };
    },
    /**
     * Feed health for the data account from the hub's stats: "up", "stale", "down" or "none" (no upstream yet).
     * @returns {{ state: string, detail: string | null, limit: number | null, lastTickAt: string | null }}
     */
    health(accountId) {
      let st;
      try {
        st = hub.stats();
      } catch {
        return { state: "none", detail: null, limit: null, lastTickAt: null };
      }
      const up = (st?.upstreams ?? []).find((u) => u.accountId === accountId);
      if (!up) return { state: "none", detail: null, limit: null, lastTickAt: null };
      return { state: up.state ?? (up.connected ? "up" : "down"), detail: up.reason ?? up.detail ?? null, limit: up.limit ?? null, lastTickAt: up.lastTickAt ?? null };
    },
    /** Drop every recorder client (stop, or disabled). */
    clear() {
      for (const id of clients.keys()) {
        try {
          hub.dropClient(id);
        } catch {
          /* hub gone */
        }
      }
      clients.clear();
      owner.clear();
      rejected = [];
    },
  };
}
