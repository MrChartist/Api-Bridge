/**
 * Human confirmation tickets (docs/ARCHITECTURE.md §4 "AI", §8 "AI confirmation").
 *
 *  1. preview() of an order that needs a human (AI assistant, or a hook set to require it) opens a ticket holding
 *     the exact order body, who prepared it and its checks. Tickets expire after orders.ticketTtlMs (60 s).
 *  2. The dashboard's Pending confirmations panel lists open tickets (GET /v1/tickets, admin key, this computer only).
 *  3. The human confirms (POST /v1/tickets/{id}/confirm). That yields a single-use confirmToken, valid for
 *     orders.confirmTokenTtlMs (60 s), bound to the exact order body (fingerprint), the account and the principal
 *     that prepared the ticket. The ticket leaves the pending list.
 *  4. place() checks the token (verify) early and burns it (consume) synchronously right before the order is sent,
 *     so two concurrent requests can never both use one token.
 *  5. Or the human declines (POST /v1/tickets/{id}/reject). A declined ticket leaves the open book at once, so a
 *     confirmation (and so a token) can never follow; only an open ticket can be declined, a confirmed one cannot.
 *
 * A short trail (in memory, like the tickets) remembers how recent tickets ended (declined, expired, used) for
 * orders.ticketTrailMs, so a client that asks about a ticket later gets a clear answer and the dashboard can show
 * "Declined" for a while.
 *
 * Only a hash of each token is kept. Client-side approval prompts and MCP annotations never count as confirmation.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BridgeError } from "../core/errors.mjs";
import { istIso } from "./time.mjs";

const hashToken = (t) => createHash("sha256").update(String(t)).digest();

/**
 * @typedef {{ ticketId: string, order: object, accountId: string, fingerprint: string, source: string, client: string,
 *   principalId: string, checks: object[], estimatedValue: number | null, createdAt: number, expiresAt: number,
 *   confirmed: null | { by: string, at: number, tokenHash: Buffer, tokenExpiresAt: number, used: boolean } }} TicketRecord
 */

/** Longest reason a person can give when declining (characters). */
export const REJECT_REASON_MAX = 200;

/** Control characters out, spaces collapsed, cut at the limit; empty means no reason. */
export function cleanReason(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, REJECT_REASON_MAX) : null;
}

/** A ticket that is not open any more: 409 with its state (clients read `state`, never the words). */
const notOpen = (ticketId, state) => {
  const words = {
    confirmed: "was already confirmed by a person, so it cannot be declined",
    consumed: "was already confirmed and used to send its order, so it cannot be declined",
    expired: "has expired",
  };
  return new BridgeError("STATE_CONFLICT", `Ticket ${ticketId} ${words[state] ?? `is ${state}`}.`, { retryable: false, fields: { ticketId, state } });
};

/**
 * @param {{ now: () => number, ticketTtlMs: number, confirmTokenTtlMs: number, maxOpen?: number, trailTtlMs?: number, trailMax?: number }} opts
 */
export function createTicketBook({ now, ticketTtlMs, confirmTokenTtlMs, maxOpen = 200, trailTtlMs = 15 * 60_000, trailMax = 100 }) {
  /** @type {Map<string, TicketRecord>} */
  const tickets = new Map();
  /**
   * How recent tickets ended, newest last: declined (with the person's reason and the ticket as shown), expired, or
   * confirmed and used. Bounded by age and count.
   * @type {Map<string, { ticketId: string, state: "rejected"|"expired"|"consumed", at: number, reason: string | null, by: string | null, principalId: string, accountId: string, ticket: object | null }>}
   */
  const trail = new Map();

  const remember = (entry) => {
    trail.delete(entry.ticketId);
    trail.set(entry.ticketId, entry);
    while (trail.size > trailMax) trail.delete(trail.keys().next().value);
  };

  const sweep = () => {
    const t = now();
    for (const [id, tk] of tickets) {
      const end = tk.confirmed ? (tk.confirmed.used ? t - 1 : tk.confirmed.tokenExpiresAt) : tk.expiresAt;
      if (end > t) continue;
      tickets.delete(id);
      remember({ ticketId: id, state: tk.confirmed?.used ? "consumed" : "expired", at: tk.confirmed?.used ? tk.confirmed.at : end, reason: null, by: null, principalId: tk.principalId, accountId: tk.accountId, ticket: null });
    }
    for (const [id, e] of trail) if (e.at + trailTtlMs <= t) trail.delete(id);
  };

  const publicTicket = (tk) => ({
    ticketId: tk.ticketId,
    status: "open",
    order: structuredClone(tk.order),
    source: tk.source,
    client: tk.client,
    checks: structuredClone(tk.checks),
    estimatedValue: tk.estimatedValue,
    createdAt: istIso(tk.createdAt),
    expiresAt: istIso(tk.expiresAt),
  });

  /** Find the record a token belongs to (constant-time compare against each candidate hash). */
  const byToken = (token) => {
    if (typeof token !== "string" || token.length < 16) return null;
    const h = hashToken(token);
    for (const tk of tickets.values()) {
      if (tk.confirmed && timingSafeEqual(tk.confirmed.tokenHash, h)) return tk;
    }
    return null;
  };

  /** @returns {{ ok: true, ticketId: string } | { ok: false, message: string }} */
  const verify = (token, { fingerprint, accountId, principalId }) => {
    sweep();
    const tk = byToken(token);
    if (!tk || tk.confirmed.used) return { ok: false, message: "The confirmToken is not valid, has expired or was already used. Prepare the order again and confirm it in the Bridge." };
    if (tk.accountId !== accountId || tk.fingerprint !== fingerprint) {
      return { ok: false, message: "The confirmToken was issued for a different order. A confirmation covers exactly the order that was shown." };
    }
    if (tk.principalId !== principalId) return { ok: false, message: "The confirmToken belongs to a different client." };
    return { ok: true, ticketId: tk.ticketId };
  };

  /**
   * Check a confirmed ticket by id (no token): for the client that prepared it, e.g. a webhook whose hook requires
   * confirmation and that never sees the token. Same binding rules as a token: order, account and principal.
   * @returns {{ ok: true, ticketId: string } | { ok: false, message: string }}
   */
  const verifyTicket = (ticketId, { fingerprint, accountId, principalId }) => {
    sweep();
    const tk = tickets.get(String(ticketId ?? ""));
    if (!tk && trail.get(String(ticketId ?? ""))?.state === "rejected") return { ok: false, message: "A person declined this ticket in the Bridge. Nothing was sent. Do not try it again; ask them what they would like instead." };
    if (!tk || !tk.confirmed || tk.confirmed.used) return { ok: false, message: "This ticket has not been confirmed, has expired or was already used." };
    if (tk.accountId !== accountId || tk.fingerprint !== fingerprint) return { ok: false, message: "The ticket was confirmed for a different order." };
    if (tk.principalId !== principalId) return { ok: false, message: "The ticket belongs to a different client." };
    return { ok: true, ticketId: tk.ticketId };
  };

  return {
    /**
     * Open a ticket.
     * @param {{ order: object, accountId: string, fingerprint: string, source: string, client: string, principalId: string,
     *   checks: object[], estimatedValue: number | null }} input
     * @returns {object} OpenAPI Ticket
     */
    open(input) {
      sweep();
      const pending = [...tickets.values()].filter((t) => !t.confirmed);
      if (pending.length >= maxOpen) {
        throw new BridgeError("RATE_LIMITED", "Too many orders are waiting for confirmation. Confirm or let some expire first.", { retryAfterMs: ticketTtlMs });
      }
      const t = now();
      const tk = { ...input, ticketId: `tkt_${randomBytes(9).toString("base64url")}`, createdAt: t, expiresAt: t + ticketTtlMs, confirmed: null };
      tickets.set(tk.ticketId, tk);
      return publicTicket(tk);
    },
    /** Pending (unconfirmed, unexpired) tickets, oldest first, OpenAPI Ticket shape. */
    list() {
      sweep();
      return [...tickets.values()].filter((t) => !t.confirmed).sort((a, b) => a.createdAt - b.createdAt).map(publicTicket);
    },
    /**
     * Human confirmation. @returns {{ confirmToken: string, expiresAt: string, ticket: object }}
     * @param {string} ticketId
     * @param {string} by  who confirmed (principal id), for the audit log
     */
    confirm(ticketId, by) {
      sweep();
      const tk = tickets.get(ticketId);
      if (!tk && trail.get(String(ticketId))?.state === "rejected") throw notOpen(String(ticketId), "rejected");
      if (!tk || tk.confirmed) throw new BridgeError("NOT_FOUND", "No pending ticket with this id. It may have expired (tickets last about a minute) or been confirmed already.");
      const token = `mct_${randomBytes(32).toString("base64url")}`;
      const t = now();
      tk.confirmed = { by, at: t, tokenHash: hashToken(token), tokenExpiresAt: t + confirmTokenTtlMs, used: false };
      return { confirmToken: token, expiresAt: istIso(tk.confirmed.tokenExpiresAt), ticket: publicTicket(tk), accountId: tk.accountId, principalId: tk.principalId };
    },
    /**
     * Human decline. Only an open ticket can be declined; declining a declined ticket answers the same again (the
     * first reason stays); a confirmed, used or expired ticket is a 409 naming its state. Synchronous, so a
     * decline and a confirmation of the same ticket can never both win.
     * @param {string} ticketId
     * @param {string} by  who declined (principal id), for the audit log
     * @param {string | null} [reason]
     * @returns {{ ticket: object, accountId: string, principalId: string, alreadyRejected: boolean }}
     */
    reject(ticketId, by, reason = null) {
      sweep();
      const id = String(ticketId ?? "");
      const tk = tickets.get(id);
      if (tk) {
        if (tk.confirmed) throw notOpen(id, tk.confirmed.used ? "consumed" : "confirmed");
        tickets.delete(id);
        const at = now();
        const cleaned = cleanReason(reason);
        const ticket = { ...publicTicket(tk), status: "rejected", rejectedAt: istIso(at), reason: cleaned };
        remember({ ticketId: id, state: "rejected", at, reason: cleaned, by, principalId: tk.principalId, accountId: tk.accountId, ticket });
        return { ticket, accountId: tk.accountId, principalId: tk.principalId, alreadyRejected: false };
      }
      const e = trail.get(id);
      if (!e) throw new BridgeError("NOT_FOUND", "No ticket with this id. It may have expired a while ago (tickets last about a minute).");
      if (e.state !== "rejected") throw notOpen(id, e.state);
      return { ticket: e.ticket, accountId: e.accountId, principalId: e.principalId, alreadyRejected: true };
    },
    /** Recently declined tickets, newest first (OpenAPI Ticket shape with status "rejected", rejectedAt and reason). */
    listRejected() {
      sweep();
      return [...trail.values()].filter((e) => e.state === "rejected").reverse().map((e) => structuredClone(e.ticket));
    },
    /**
     * Where a ticket stands, for the client that prepared it. status: open, confirmed (a person confirmed it and the
     * code is not used yet), consumed (its order was sent), rejected, expired; null when the Bridge does not know it.
     */
    statusOf(ticketId) {
      sweep();
      const id = String(ticketId ?? "");
      const tk = tickets.get(id);
      if (tk) return { ticketId: id, status: tk.confirmed ? (tk.confirmed.used ? "consumed" : "confirmed") : "open", reason: null, expiresAt: istIso(tk.confirmed ? tk.confirmed.tokenExpiresAt : tk.expiresAt), principalId: tk.principalId, accountId: tk.accountId };
      const e = trail.get(id);
      return e ? { ticketId: id, status: e.state, reason: e.reason, expiresAt: null, principalId: e.principalId, accountId: e.accountId } : null;
    },
    /** Check a token against an order without using it. */
    verify,
    /**
     * Burn a token. Synchronous: of two concurrent callers only one gets true.
     * @returns {boolean}
     */
    consume(token, expect) {
      const v = verify(token, expect);
      if (!v.ok) return false;
      const tk = tickets.get(v.ticketId);
      tk.confirmed.used = true;
      return true;
    },
    verifyTicket,
    /** Burn a confirmed ticket by id (see verifyTicket). Synchronous. @returns {boolean} */
    consumeTicket(ticketId, expect) {
      const v = verifyTicket(ticketId, expect);
      if (!v.ok) return false;
      tickets.get(v.ticketId).confirmed.used = true;
      return true;
    },
    /** Principal that prepared a ticket (null when unknown). */
    principalOf(ticketId) {
      return tickets.get(String(ticketId))?.principalId ?? trail.get(String(ticketId))?.principalId ?? null;
    },
    /** Pending + confirmed-unused counts (tests). */
    size() {
      sweep();
      return tickets.size;
    },
  };
}
