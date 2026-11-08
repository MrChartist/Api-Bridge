/**
 * Test fixture: a stub broker adapter whose createFeed() records every call and lets a test drive ticks and status.
 * No network. Used by the stream module's unit and endpoint tests.
 *
 *   const a = stubAdapter();                 // a.adapter goes into createFakeAccountManager({ accounts: [{ adapter }] })
 *   a.last().status(true); a.last().tick("13", "NSE", 25000);
 */

/** A stub broker adapter whose createFeed records everything and lets the test drive ticks and status. */
export function stubAdapter({ setMode = false, throwOnCreate = 0 } = {}) {
  const feeds = [];
  let failures = throwOnCreate;
  const adapter = {
    createFeed(creds, handlers) {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("boom with token secret-token-123"), { code: "UPSTREAM_ERROR" });
      }
      const feed = {
        creds: { ...creds },
        handlers,
        subs: new Map(),
        subscribeCalls: [],
        unsubscribeCalls: [],
        modeCalls: [],
        closed: false,
        subscribe(refs) {
          this.subscribeCalls.push(refs.map((r) => r.token));
          for (const r of refs) this.subs.set(`${r.exchange}:${r.token}`, r);
        },
        unsubscribe(refs) {
          this.unsubscribeCalls.push(refs.map((r) => r.token));
          for (const r of refs) this.subs.delete(`${r.exchange}:${r.token}`);
        },
        close() {
          this.closed = true;
        },
        tick(token, exchange, ltp, extra = {}) {
          handlers.onTick({ token, exchange, ltp, open: null, high: null, low: null, close: null, volume: null, oi: null, bid: null, ask: null, ...extra });
        },
        status(connected, reason) {
          handlers.onStatus({ connected, reason });
        },
      };
      if (setMode) feed.setMode = (refs, mode) => feed.modeCalls.push([refs.map((r) => r.token), mode]);
      feeds.push(feed);
      return feed;
    },
  };
  return { adapter, feeds, last: () => feeds.at(-1) };
}
