/**
 * Book routes — stream S27 (docs/openapi.yaml, tag Book; docs/spec/p1-12-guard-participants.md §4.3). { data, meta }.
 *
 *   GET /v1/book                    read             one book per holder, or the family view; format=csv for the legs
 *   GET /v1/book/holders            read             holders, relationships, family membership, visible accounts
 *   PUT /v1/book/holders/{holder}   admin, loopback  set a holder's relationship and label (409 when set in config)
 *
 * Account visibility follows the key's account list (accountFilter, as the safety and readiness routes do).
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { csv } from "../core/http.mjs";
import { accountFilter } from "../safety/routes.mjs";
import { bookConfig, HOLDER_RE, RELATIONSHIPS, RELATIONSHIP_LABEL, holderTag } from "./config.mjs";
import { holderList } from "./family.mjs";
import { bookCsv } from "./bookService.mjs";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const bookQuery = z
  .object({
    view: z.enum(["holders", "family"]).default("holders"),
    underlying: z.string().regex(/^[A-Z0-9&-]{1,20}$/, "an underlying such as NIFTY").optional(),
    mode: z.enum(["live", "paper", "all"]).default("all"),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .strict();

const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

function parseWith(schema, value, detail) {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw fromValidation(r.error, detail);
  return r.data;
}

/**
 * @param {{ config: any, service: ReturnType<typeof import("./bookService.mjs").createBookService>,
 *   store: ReturnType<typeof import("./holderStore.mjs").createHolderStore>, audit?: any }} deps
 */
export function createBookRoutes({ config, service, store, audit }) {
  return {
    /** GET /v1/book */
    async getBook(ctx) {
      const allowed = ["view", "underlying", "account", "mode", "format"];
      for (const k of new Set(ctx.query.keys())) {
        if (!allowed.includes(k)) throw new BridgeError("VALIDATION_FAILED", `Unknown query parameter ${k}.`, { errors: [{ path: k, message: "not allowed" }] });
        if (k !== "account" && ctx.query.getAll(k).length > 1) throw new BridgeError("VALIDATION_FAILED", `Send ${k} only once.`, { errors: [{ path: k, message: "repeated" }] });
      }
      const q = parseWith(bookQuery, Object.fromEntries([...ctx.query].filter(([k]) => k !== "account")), "view is holders or family; mode is live, paper or all; format is json or csv.");
      const requested = [...new Set(ctx.query.getAll("account"))];
      for (const id of requested) if (!ACCOUNT_ID.test(id)) throw new BridgeError("VALIDATION_FAILED", "account must be an account id.", { errors: [{ path: "account", message: "not an account id" }] });
      if (requested.length > 50) throw new BridgeError("VALIDATION_FAILED", "Name at most 50 accounts.", { errors: [{ path: "account", message: "at most 50" }] });
      const body = await service.read(ctx, { view: q.view, underlying: q.underlying ?? null, accounts: requested, mode: q.mode });
      if (q.format === "csv") return csv(bookCsv(body), { filename: `book-${q.view}.csv` });
      return { data: body, meta: meta(ctx) };
    },

    /** GET /v1/book/holders */
    getHolders(ctx) {
      for (const k of new Set(ctx.query.keys())) throw new BridgeError("VALIDATION_FAILED", `Unknown query parameter ${k}.`, { errors: [{ path: k, message: "not allowed" }] });
      const canSee = accountFilter(ctx);
      const everything = ctx.principal?.kind === "local" || ctx.key?.accounts === "*";
      const book = bookConfig(config);
      const holders = holderList(config, store.tags())
        .map((h) => ({ ...h, accountCount: h.accounts.length, accounts: h.accounts.filter(canSee) }))
        .filter((h) => everything || h.accounts.length > 0);
      return {
        data: {
          family: { name: book.family.name, relationships: [...book.family.relationships] },
          relationships: RELATIONSHIPS.map((r) => ({ value: r, label: RELATIONSHIP_LABEL[r], inFamily: book.family.relationships.includes(r) })),
          untaggedHolder: book.untaggedHolder,
          holders,
          note: "Family = the relationships in book.family.relationships. Guards and alert actions work only on family accounts. Managing money for anyone else needs SEBI registration.",
        },
        meta: meta(ctx),
      };
    },

    /** PUT /v1/book/holders/{holder} (admin, this computer only) */
    async putHolder(ctx) {
      const holder = String(ctx.params.holder ?? "").trim();
      if (!HOLDER_RE.test(holder)) throw new BridgeError("VALIDATION_FAILED", "holder may use letters, digits, spaces and _ . : - (1 to 64 characters).", { errors: [{ path: "holder", message: "not a holder name" }] });
      const tag = parseWith(holderTag, ctx.body ?? {}, `Send { "relationship": "${RELATIONSHIPS.join('" | "')}", "label"?: "…" }.`);
      if (bookConfig(config).holders[holder]) throw new BridgeError("STATE_CONFLICT", `Holder '${holder}' is set in bridge.config.json (book.holders); change it there.`);
      const by = ctx.principal?.kind === "key" ? `key:${ctx.principal.id}` : "local";
      const doc = store.set(holder, { relationship: tag.relationship, label: tag.label || undefined }, by);
      try {
        await audit?.append?.({ type: "book.holder_tagged", actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", accountId: null, requestId: ctx.requestId, data: { holder, relationship: tag.relationship } });
      } catch {
        // the audit log is optional here (a stub in some test apps); the change itself is saved
      }
      const entry = holderList(config, doc.holders).find((h) => h.holder === holder);
      const canSee = accountFilter(ctx);
      return { data: { ...entry, accountCount: entry.accounts.length, accounts: entry.accounts.filter(canSee), updatedAt: doc.updatedAt }, meta: meta(ctx) };
    },
  };
}
