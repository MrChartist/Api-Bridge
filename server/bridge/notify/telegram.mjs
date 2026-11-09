/**
 * A small client for the Telegram Bot API (https://core.telegram.org/bots/api). Outbound HTTPS only, to ONE fixed host.
 * `fetch` is injected, so tests and the demo never touch the network.
 *
 * What is documented by Telegram (and what is not) is in docs/guides/telegram.md. In short: a request is
 * POST https://api.telegram.org/bot<token>/<method> with a JSON body; an answer is { ok, result } or
 * { ok: false, error_code, description, parameters? }; `parameters.retry_after` (seconds) says how long to wait after
 * exceeding flood control; `parameters.migrate_to_chat_id` says a group became a supergroup. The error_code values and
 * description texts beyond that are NOT promised by Telegram ("its contents are subject to change"), so this client
 * reads error_code and the description only as hints and maps them to a small set of kinds.
 *
 * The token is in the URL, so nothing here ever puts a URL, a request or a raw error into a message or a log: errors
 * carry a kind, a status, an optional retryAfterSeconds and a short description that is scrubbed of the token.
 */

export const TELEGRAM_HOST = "https://api.telegram.org";
/** Documented limit of sendMessage text: 1-4096 characters after entity parsing. Kept a little under, in UTF-16 units. */
export const MAX_TEXT = 4000;

/** @typedef {"network"|"timeout"|"server"|"rate_limited"|"token_invalid"|"blocked"|"forbidden"|"chat_not_found"|"migrated"|"too_long"|"conflict"|"bad_request"|"unknown"} TelegramErrorKind */

/** Kinds worth retrying later. */
export const RETRYABLE = Object.freeze(new Set(["network", "timeout", "server", "rate_limited", "unknown"]));

export class TelegramError extends Error {
  /**
   * @param {TelegramErrorKind} kind @param {{ status?: number, code?: number, retryAfterSeconds?: number, migrateTo?: string, description?: string }} [extra]
   */
  constructor(kind, { status, code, retryAfterSeconds, migrateTo, description } = {}) {
    super(PLAIN[kind] ?? PLAIN.unknown);
    this.name = "TelegramError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.migrateTo = migrateTo;
    this.description = description;
  }
  get retryable() {
    return RETRYABLE.has(this.kind);
  }
}

/** What each failure means, in words for a person (shown in the dashboard, the CLI and `doctor`). */
export const PLAIN = Object.freeze({
  network: "Could not reach Telegram. Check this computer's internet connection.",
  timeout: "Telegram did not answer in time.",
  server: "Telegram had a problem on its side. The Bridge will try again.",
  rate_limited: "Telegram asked the Bridge to slow down. It waits and tries again.",
  token_invalid: "Telegram does not accept this bot token. Check it with BotFather (the /token command) and enter it again.",
  blocked: "This chat has blocked the bot, or the bot was removed from it. Open the chat, press Start (or add the bot back), then send a test.",
  forbidden: "The bot is not allowed to write in this chat. In a group, make sure the bot is a member and may send messages.",
  chat_not_found: "Telegram cannot find this chat. Send the bot a message first, then use Find my chat.",
  migrated: "This group became a supergroup. The Bridge updated the chat; try again.",
  too_long: "The message was too long for Telegram.",
  conflict: "Another program is already reading this bot's messages (or a webhook is set). Only one can. Stop the other one, or use a separate bot for the Bridge.",
  bad_request: "Telegram refused the request.",
  unknown: "Telegram answered in a way the Bridge did not expect.",
});

const scrub = (text, token) => {
  let t = String(text ?? "").slice(0, 160);
  if (token) t = t.split(token).join("[token]");
  return t.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[token]");
};

/** Map an HTTP status and a Telegram error body to a kind. Exported for tests. */
export function classify(status, body) {
  const code = Number.isInteger(body?.error_code) ? body.error_code : status;
  const desc = String(body?.description ?? "").toLowerCase();
  const params = body?.parameters ?? {};
  if (Number.isFinite(params.migrate_to_chat_id)) return "migrated";
  if (code === 429 || Number.isFinite(params.retry_after)) return "rate_limited";
  if (code === 401 || code === 404) return "token_invalid";
  if (code === 403) return /blocked|deactivated|kicked|not a member|removed|was kicked/.test(desc) ? "blocked" : "forbidden";
  if (code === 409) return "conflict";
  if (code === 400) {
    if (/chat not found|user not found|peer_id_invalid|chat_id is empty/.test(desc)) return "chat_not_found";
    if (/too long/.test(desc)) return "too_long";
    return "bad_request";
  }
  if (code >= 500) return "server";
  return "unknown";
}

/**
 * @param {{ token: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function createTelegramClient({ token, fetchImpl, timeoutMs = 15_000 }) {
  if (typeof token !== "string" || !token) throw new TypeError("token is required");
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
   * @returns {Promise<any>} the `result`
   */
  async function call(method, params = {}, opts = {}) {
    if (!/^[A-Za-z]{3,40}$/.test(method)) throw new TypeError("bad method");
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    let res;
    try {
      res = await doFetch(`${TELEGRAM_HOST}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.any(signals),
        redirect: "error",
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new TelegramError("network", { description: "stopped" });
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new TelegramError(timedOut ? "timeout" : "network");
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok && body?.ok === true) return body.result;
    const kind = body ? classify(res.status, body) : res.status >= 500 ? "server" : classify(res.status, {});
    const header = Number(res.headers?.get?.("retry-after"));
    const retryAfterSeconds = Number.isFinite(body?.parameters?.retry_after) ? body.parameters.retry_after : Number.isFinite(header) && header > 0 ? header : undefined;
    const migrateTo = Number.isFinite(body?.parameters?.migrate_to_chat_id) ? String(body.parameters.migrate_to_chat_id) : undefined;
    throw new TelegramError(kind, { status: res.status, code: body?.error_code, retryAfterSeconds: kind === "rate_limited" ? (retryAfterSeconds ?? 5) : retryAfterSeconds, migrateTo, description: scrub(body?.description, token) });
  }
  return {
    call,
    /** Test the token. @returns {Promise<{ id: number, username: string, firstName: string }>} */
    async getMe() {
      const me = await call("getMe");
      return { id: me.id, username: String(me.username ?? ""), firstName: String(me.first_name ?? "") };
    },
    /** Plain text, no parse mode (so no character needs escaping), no link preview. */
    sendMessage(chatId, text, { silent = false } = {}) {
      return call("sendMessage", { chat_id: chatId, text: String(text).slice(0, MAX_TEXT), link_preview_options: { is_disabled: true }, ...(silent ? { disable_notification: true } : {}) });
    },
    /** Long polling: Telegram holds the request open up to `timeout` seconds. Only message updates are asked for. */
    getUpdates({ offset, timeout = 25, limit = 20, signal } = {}) {
      return call("getUpdates", { ...(offset !== undefined ? { offset } : {}), timeout, limit, allowed_updates: ["message"] }, { timeoutMs: (timeout + 15) * 1000, signal });
    },
  };
}

/** "…6789" style hint of an id, for screens. */
export const maskId = (id) => {
  const s = String(id);
  return s.length <= 4 ? "••••" : `••••${s.slice(-4)}`;
};

/** "123456789:AAH…" -> "••••" + last 4. Never more. */
export const maskToken = (token) => (typeof token === "string" && token.length >= 8 ? `••••${token.slice(-4)}` : "••••");

/** Shape check for a bot token. Telegram documents the token only as what BotFather gives you; the usual form is digits:letters. */
export const looksLikeToken = (t) => typeof t === "string" && /^\d{5,16}:[A-Za-z0-9_-]{20,64}$/.test(t.trim());

/** A chat id as Telegram accepts it: a whole number (negative for groups), or @channelusername. */
export const isChatRef = (s) => /^-?\d{1,16}$/.test(String(s)) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(String(s));
