/**
 * Recent alerts per hook, for GET /v1/hooks/{id}/signals and the dashboard.
 *
 * Memory only and bounded (`keep` alerts per hook). It holds what the alert ASKED for in short form (symbol, side,
 * id, time) and what happened to it (outcome, reason, order id); never the message body, the URL token, a passphrase
 * or a signature. Failures that carry no alert (wrong passphrase, address not allowed, rate limit) are only counted.
 * The audit log (hook.signal, hook.refused) is the durable record; this is the quick answer to "did my alert work?".
 *
 * Outcomes: queued, processing, placed, awaiting_confirmation, duplicate, stale, rejected (the order or a hook rule said
 * no), refused (the alert itself was not valid: a 400), failed, outcome_unknown, dropped.
 */

/** @typedef {"queued"|"processing"|"placed"|"awaiting_confirmation"|"duplicate"|"stale"|"rejected"|"refused"|"failed"|"outcome_unknown"|"dropped"} Outcome */

const STATUS_TO_OUTCOME = Object.freeze({
  queued: "queued",
  processing: "processing",
  placed: "placed",
  awaiting_confirmation: "awaiting_confirmation",
  duplicate: "duplicate",
  rejected: "rejected",
  failed: "failed",
  outcome_unknown: "outcome_unknown",
  dropped: "dropped",
});

const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : null);

/** One plain sentence for an entry (shown as is in the dashboard and in notifications). */
export function plainSummary(e) {
  const what = [e.side, e.symbol].filter(Boolean).join(" ");
  const why = e.reason ? ` ${e.reason}` : "";
  // How much, and at what price, when the alert said so ("BUY 2 lots NSE:M&M at 2900").
  const size = Number.isFinite(e.lots) ? `${e.lots} ${e.lots === 1 ? "lot" : "lots"}` : Number.isFinite(e.quantity) ? `${e.quantity} shares or units` : "";
  const detail = [e.side, size, e.symbol].filter(Boolean).join(" ") + (Number.isFinite(e.price) ? ` at ${e.price}` : "");
  switch (e.outcome) {
    case "placed":
      return `Placed a ${e.mode ?? "paper"} order${detail ? `: ${detail}` : ""}.`;
    case "queued":
      return e.code === "HOOK_RATE_HELD" ? "Received. This hook is over its alerts-per-minute limit, so it is held until a slot frees up." : "Received. Waiting its turn.";
    case "processing":
      return "Received. Being checked now.";
    case "awaiting_confirmation":
      return "Waiting for you to confirm it in the Bridge (Pending confirmations). Nothing was sent yet.";
    case "duplicate":
      return "Seen before, so it was not placed a second time.";
    case "stale":
      return `Too old, so nothing was placed.${why}`;
    case "refused":
      // `cause` says which kind of refusal: a clock problem and a rule of the hook are not "could not be read".
      if (e.cause === "future") return `Its time is ahead of this computer's clock, so nothing was placed.${why}`;
      if (e.cause === "policy") return `Against this hook's rules, so nothing was placed.${why}`;
      return `The alert could not be read, so nothing was placed.${why}`;
    case "rejected":
      return `Not placed.${why}`;
    case "outcome_unknown":
      return "The broker did not confirm this order. Check the order book before sending it again.";
    case "dropped":
      return "The Bridge stopped before it was processed. Nothing was placed.";
    case "failed":
      return `Could not be processed.${why}`;
    default:
      return why.trim();
  }
}

/** @param {{ keep?: number, now?: () => number }} [opts] */
export function createSignalLog({ keep = 100, now = () => Date.now() } = {}) {
  /** @type {Map<string, { entries: any[], counts: Record<string, number>, byKey: Map<string, any>, lastAuthFailureAt: number | null, since: number }>} */
  const hooks = new Map();

  const slot = (hookId) => {
    let h = hooks.get(hookId);
    if (!h) {
      h = { entries: [], counts: {}, byKey: new Map(), lastAuthFailureAt: null, since: now() };
      hooks.set(hookId, h);
    }
    return h;
  };
  const bump = (h, name) => {
    h.counts[name] = (h.counts[name] ?? 0) + 1;
  };
  const push = (h, e) => {
    h.entries.push(e);
    if (e.signalId) h.byKey.set(`${e.signalId}#${e.index}`, e);
    while (h.entries.length > keep) {
      const old = h.entries.shift();
      if (old?.signalId) h.byKey.delete(`${old.signalId}#${old.index}`);
    }
  };
  const finish = (e) => {
    e.summary = plainSummary(e);
    return e;
  };

  return {
    /**
     * An alert passed the receive checks and was queued (one entry per order it holds).
     * @param {string} hookId @param {{ signalId: string, index: number, at: number, symbol?: string, side?: string | null, id?: string | null, time?: string | null, mode?: string | null, test?: boolean, lots?: number | null, quantity?: number | null, price?: number | null, code?: string | null, reason?: string | null }} s
     */
    accepted(hookId, s) {
      const h = slot(hookId);
      bump(h, "received");
      if (s.index === 0) bump(h, "accepted");
      push(h, finish({ signalId: s.signalId, index: s.index, at: s.at, outcome: "queued", code: clip(s.code ?? null, 40), reason: clip(s.reason ?? null, 300), symbol: clip(s.symbol, 64), side: s.side ?? null, id: clip(s.id, 128), time: clip(s.time, 40), mode: s.mode ?? null, orderId: null, ticketId: null, test: s.test === true, finishedAt: null, lots: s.lots ?? null, quantity: s.quantity ?? null, price: s.price ?? null }));
    },

    /** A repeat of an alert already seen (same identity). @param {string} hookId @param {{ signalId: string, at: number, symbol?: string, side?: string | null, id?: string | null, time?: string | null, test?: boolean }} s */
    duplicate(hookId, s) {
      const h = slot(hookId);
      bump(h, "received");
      bump(h, "duplicate");
      push(h, finish({ signalId: s.signalId, index: 0, at: s.at, outcome: "duplicate", code: null, reason: null, symbol: clip(s.symbol, 64), side: s.side ?? null, id: clip(s.id, 128), time: clip(s.time, 40), mode: null, orderId: null, ticketId: null, test: s.test === true, finishedAt: s.at, duplicateOf: true }));
    },

    /**
     * An alert that was refused at the door. kind: stale | bad_request | queue_full | rate | auth | address | key_revoked.
     * Only stale, bad_request and queue_full make a list entry (they carry an alert the person can fix); the others are counts.
     * `cause` (optional) tells a refusal for the alert's time ("future") or a rule of the hook ("policy") from one that could not be read.
     * @param {string} hookId @param {string} kind @param {{ at: number, code?: string | null, reason?: string | null, symbol?: string | null, side?: string | null, id?: string | null, time?: string | null, test?: boolean, cause?: string | null }} s
     */
    refused(hookId, kind, s) {
      const h = slot(hookId);
      if (kind === "auth") {
        bump(h, "authFailed");
        h.lastAuthFailureAt = s.at;
        return;
      }
      if (kind === "address") return void bump(h, "addressRefused");
      if (kind === "rate") return void bump(h, "rateLimited");
      if (kind === "key_revoked") return void bump(h, "keyRevoked");
      bump(h, "received");
      const outcome = kind === "stale" ? "stale" : kind === "queue_full" ? "rejected" : "refused";
      bump(h, kind === "stale" ? "stale" : kind === "queue_full" ? "queueFull" : "badRequest");
      push(h, finish({ signalId: null, index: 0, at: s.at, outcome, code: clip(s.code ?? null, 40), reason: clip(s.reason ?? null, 300), symbol: clip(s.symbol, 64), side: s.side ?? null, id: clip(s.id, 128), time: clip(s.time, 40), mode: null, orderId: null, ticketId: null, test: s.test === true, finishedAt: s.at, ...(s.cause ? { cause: s.cause } : {}) }));
    },

    /**
     * The worker changed a signal (queued -> placed / rejected ...). Called with the worker's SignalRecord.
     * @param {any} rec
     */
    update(rec) {
      const h = hooks.get(rec.hookId);
      const e = h?.byKey.get(`${rec.signalId}#${rec.index}`);
      if (!e) return;
      const outcome = rec.code === "ALERT_STALE" ? "stale" : (STATUS_TO_OUTCOME[rec.status] ?? "failed");
      const terminal = outcome !== "queued" && outcome !== "processing";
      if (terminal && !e.counted) {
        e.counted = true;
        bump(h, { placed: "placed", awaiting_confirmation: "awaitingConfirmation", rejected: "rejected", stale: "stale", failed: "failed", outcome_unknown: "outcomeUnknown", dropped: "dropped" }[outcome] ?? "other");
      }
      Object.assign(e, { outcome, code: clip(rec.code ?? null, 40), reason: clip(rec.reason ?? null, 300), symbol: clip(rec.symbol, 64) ?? e.symbol, side: rec.side ?? e.side, mode: rec.mode ?? e.mode, orderId: rec.orderId ?? null, ticketId: rec.ticketId ?? null, finishedAt: rec.finishedAt ?? null });
      finish(e);
    },

    /**
     * @param {string} hookId @param {{ limit?: number, outcome?: string | null }} [f]
     * @returns {{ signals: any[], counts: Record<string, number>, since: number, lastAuthFailureAt: number | null }}
     */
    list(hookId, { limit = 50, outcome = null } = {}) {
      const h = hooks.get(hookId);
      if (!h) return { signals: [], counts: {}, since: now(), lastAuthFailureAt: null };
      let rows = [...h.entries].reverse();
      if (outcome) rows = rows.filter((e) => e.outcome === outcome);
      return { signals: rows.slice(0, limit).map(({ counted, ...e }) => ({ ...e })), counts: { ...h.counts }, since: h.since, lastAuthFailureAt: h.lastAuthFailureAt };
    },

    /** The entries of one signal (one per order the alert held). @param {string} hookId @param {string} signalId */
    byId(hookId, signalId) {
      const h = hooks.get(hookId);
      return (h?.entries ?? []).filter((e) => e.signalId === signalId).map(({ counted, ...e }) => ({ ...e }));
    },

    remove(hookId) {
      hooks.delete(hookId);
    },
  };
}
