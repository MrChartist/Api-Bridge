/**
 * Collection routes (docs/openapi.yaml, tag "Collections").
 *
 *   GET    /v1/collections                       list (tag, kind, q filters)                          read
 *   POST   /v1/collections                       create                                               paper
 *   POST   /v1/collections/import                CSV or JSON in                                       paper
 *   GET    /v1/collections/{name}                one collection (a name, an id, or an earlier name)   read
 *   PATCH  /v1/collections/{name}                change description, tags, symbols, universe, or rename   paper
 *   DELETE /v1/collections/{name}                delete (refused while a download or recording uses it, unless force=true)   paper
 *   GET    /v1/collections/{name}/resolve        the concrete symbols for now                         read
 *   POST   /v1/collections/{name}/duplicate      copy under a new name                                paper
 *   GET    /v1/collections/{name}/export         CSV or JSON out                                      read
 *   GET    /v1/collections/{name}/usage          the downloads, recordings and datasets that use it   read
 *   GET    /v1/collections/{name}/estimate       rows, bytes and broker calls for intervals x days    read
 *
 * Writing needs the `paper` scope (a read key reads and resolves only). Nothing here reaches an order service.
 */
import { BridgeError } from "../core/errors.mjs";
import { json, noContent, Reply } from "../core/http.mjs";
import { pageParams, paginate } from "../core/paginate.mjs";
import { allowedAccountsFor } from "../market/routes.mjs";
import { parseTagFilter } from "./tags.mjs";

const NAME_PARAM = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$|^col_[a-z0-9]{10}$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

function boolQ(q, name, dflt = false) {
  const v = q.get(name);
  if (v === null || v.trim() === "") return dflt;
  if (/^(true|1)$/i.test(v.trim())) return true;
  if (/^(false|0)$/i.test(v.trim())) return false;
  throw invalid(name, `${name} must be true or false.`);
}

function numQ(q, name) {
  const v = q.get(name);
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) throw invalid(name, `${name} must be a positive number.`);
  return n;
}

/** The ?name path parameter, checked (a name, or an id). */
function nameOf(ctx) {
  const n = ctx.params?.name ?? "";
  if (!NAME_PARAM.test(n)) throw new BridgeError("NOT_FOUND", `There is no collection called "${String(n).slice(0, 64)}".`);
  return n;
}

/** Options a resolve passes to the market reads: the key's accounts, a pinned account, the priority, the caller's abort signal. */
function resolveOptions(ctx) {
  const q = ctx.query;
  const o = { signal: ctx.signal, priority: "interactive" };
  const allowed = allowedAccountsFor(ctx);
  if (allowed) o.allowedAccounts = allowed;
  const account = q.get("account")?.trim();
  if (account) {
    if (!ACCOUNT_RE.test(account)) throw invalid("account", "account is not a valid account id.");
    ctx.requireAccountAccess(account);
    o.accountId = account;
  }
  const p = q.get("priority")?.trim();
  if (p) {
    if (p !== "interactive" && p !== "background") throw invalid("priority", "priority must be interactive or background.");
    o.priority = p;
  }
  const spot = numQ(q, "spot");
  if (spot !== undefined) o.spot = spot;
  if (q.has("allowStale")) o.allowStale = boolQ(q, "allowStale");
  if (boolQ(q, "requireLive")) o.requireLive = true;
  return o;
}

/** @param {{ library: any }} deps  (read lazily) */
export function createLibraryRoutes(deps) {
  const lib = () => deps.library;
  const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });
  const reply = (ctx, data, status = 200, extra = {}) => json({ data, meta: meta(ctx, extra) }, { status, headers: { "Cache-Control": "no-store" } });

  return {
    list(ctx) {
      const q = ctx.query;
      const tag = parseTagFilter(q.getAll("tag"));
      const kind = q.get("kind")?.trim() || undefined;
      if (kind !== undefined && kind !== "static" && kind !== "option-universe") throw invalid("kind", "kind must be static or option-universe.");
      const rows = lib().list({ tag, kind, q: q.get("q")?.trim() || undefined });
      const { limit, cursor } = pageParams(q);
      const { items, nextCursor } = paginate(rows, { limit, cursor, keyOf: (c) => c.name });
      return reply(ctx, items, 200, { count: rows.length, nextCursor });
    },

    create(ctx) {
      return reply(ctx, lib().create(ctx.body ?? {}), 201);
    },

    import(ctx) {
      const q = ctx.query;
      let data = ctx.body;
      let name = q.get("name")?.trim() || undefined;
      let format = q.get("format")?.trim() || undefined;
      let description = q.get("description")?.trim() || undefined;
      let tags = q.has("tags") ? parseTagFilter(q.getAll("tags")) : undefined;
      if (format !== undefined && format !== "csv" && format !== "json") throw invalid("format", "format must be csv or json.");
      // A JSON wrapper for CSV text: { format: "csv", csv: "...", name, tags, description }.
      if (data && typeof data === "object" && !Array.isArray(data) && typeof data.csv === "string") {
        format = "csv";
        name ??= typeof data.name === "string" ? data.name : undefined;
        description ??= typeof data.description === "string" ? data.description : undefined;
        tags ??= Array.isArray(data.tags) ? data.tags : undefined;
        data = data.csv;
      }
      if (data === undefined || data === null || data === "") throw invalid("body", "Send the collection as JSON, or CSV text (Content-Type text/plain) with name=<name>.");
      const result = lib().importData({ data, format, name, description, tags, replace: boolQ(q, "replace"), skipInvalid: boolQ(q, "skipInvalid") });
      return reply(ctx, result, 201);
    },

    get(ctx) {
      return reply(ctx, lib().get(nameOf(ctx)));
    },

    update(ctx) {
      return reply(ctx, lib().update(nameOf(ctx), ctx.body ?? {}));
    },

    async remove(ctx) {
      await lib().remove(nameOf(ctx), { force: boolQ(ctx.query, "force") });
      return noContent({ "Cache-Control": "no-store" });
    },

    async resolve(ctx) {
      const r = await lib().resolve(nameOf(ctx), resolveOptions(ctx));
      return reply(ctx, r, 200, { resolvedAt: r.resolvedAt });
    },

    duplicate(ctx) {
      const body = ctx.body ?? {};
      if (typeof body !== "object" || Array.isArray(body)) throw invalid("body", "Send { name } or nothing.");
      return reply(ctx, lib().duplicate(nameOf(ctx), body.name), 201);
    },

    async export(ctx) {
      const q = ctx.query;
      const format = (q.get("format") ?? "json").trim().toLowerCase();
      const out = await lib().exportData(nameOf(ctx), { format, resolved: boolQ(q, "resolved"), resolve: resolveOptions(ctx) });
      const headers = { "Content-Type": out.contentType, "Content-Disposition": `attachment; filename="${out.filename}"`, "Cache-Control": "no-store" };
      if (out.resolvedAt) headers["X-Resolved-At"] = out.resolvedAt;
      if (out.warnings?.length) headers["X-Collection-Warnings"] = String(out.warnings.length);
      return new Reply(200, out.body, headers);
    },

    async usage(ctx) {
      return reply(ctx, await lib().usage(nameOf(ctx)));
    },

    async estimate(ctx) {
      const q = ctx.query;
      const intervals = q.get("intervals") ?? q.get("interval");
      const days = q.get("days");
      if (intervals === null) throw invalid("intervals", "intervals is required, for example intervals=5m,1d.");
      if (days === null) throw invalid("days", "days is required: how many calendar days back from today.");
      const r = await lib().estimate(nameOf(ctx), intervals, days, resolveOptions(ctx));
      return reply(ctx, r);
    },
  };
}
