/**
 * HTTP helpers shared by the pipeline and handlers: bounded body reading, typed replies, JSON/text/CSV/problem
 * senders. Handlers normally just `return data` (sent as 200 JSON); they return a Reply from json()/text()/csv()
 * when they need a status, headers or another content type, or write to ctx.res directly for streams (SSE).
 */
import { BridgeError } from "./errors.mjs";

/** A typed response a handler can return. */
export class Reply {
  /** @param {number} status @param {string | Buffer} body @param {Record<string, string>} headers */
  constructor(status, body, headers) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** JSON reply. @param {unknown} body @param {{ status?: number, headers?: Record<string, string> }} [opts] */
export function json(body, { status = 200, headers = {} } = {}) {
  return new Reply(status, JSON.stringify(body), { "Content-Type": "application/json; charset=utf-8", ...headers });
}

/** Plain-text reply (Excel WEBSERVICE, AmiBroker AFL, UDF /time). */
export function text(body, { status = 200, headers = {} } = {}) {
  return new Reply(status, String(body), { "Content-Type": "text/plain; charset=utf-8", ...headers });
}

/** CSV reply. `rows` is an array of arrays (first row = header) or a ready string. Cells are quoted when needed. */
export function csv(rows, { status = 200, headers = {}, filename } = {}) {
  const body = typeof rows === "string" ? rows : toCsv(rows);
  const h = { "Content-Type": "text/csv; charset=utf-8", ...headers };
  if (filename) h["Content-Disposition"] = `attachment; filename="${String(filename).replace(/[^A-Za-z0-9._-]/g, "_")}"`;
  return new Reply(status, body, h);
}

/** 204 No Content. */
export function noContent(headers = {}) {
  return new Reply(204, "", headers);
}

/** RFC 4180 CSV with formula-injection guarding (=, +, -, @ at the start of a text cell get a leading quote). */
export function toCsv(rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    let s = typeof v === "number" ? String(v) : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Read the request body with a hard size cap.
 * @param {import("node:http").IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BridgeError("PAYLOAD_TOO_LARGE", `The body is larger than ${limit} bytes.`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new BridgeError("PAYLOAD_TOO_LARGE", `The body is larger than ${limit} bytes.`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/**
 * Parse a body according to the route's `body` option.
 * @param {Buffer} raw
 * @param {string | undefined} contentType
 * @param {"json" | "json-or-text" | "raw" | "none"} mode
 */
export function parseBody(raw, contentType, mode) {
  if (mode === "none" || mode === "raw") return undefined;
  if (raw.length === 0) return undefined;
  const ct = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  const isJson = ct === "application/json" || ct.endsWith("+json");
  const isText = ct === "text/plain" || ct === "";
  if (!isJson && !(mode === "json-or-text" && isText)) {
    throw new BridgeError("UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.");
  }
  const s = raw.toString("utf8");
  try {
    return JSON.parse(s);
  } catch {
    if (mode === "json-or-text" && isText) return s; // e.g. a TradingView alert that is not JSON
    throw new BridgeError("INVALID_JSON", "The body could not be parsed as JSON.");
  }
}

/** Write a Reply (or JSON for any other value). Safe to call once; ignores calls after headers were sent. */
export function send(res, value, baseHeaders = {}, { head = false } = {}) {
  if (res.headersSent || res.writableEnded) return;
  const reply = value instanceof Reply ? value : json(value);
  const headers = { ...baseHeaders, ...reply.headers };
  const body = reply.status === 204 || reply.status === 304 ? "" : reply.body;
  headers["Content-Length"] = String(Buffer.byteLength(body));
  res.writeHead(reply.status, headers);
  res.end(head ? undefined : body);
}

/** Send RFC 9457 problem+json. */
export function sendProblem(res, problem, headers = {}) {
  send(res, new Reply(problem.status, JSON.stringify(problem), { "Content-Type": "application/problem+json; charset=utf-8" }), headers);
}
