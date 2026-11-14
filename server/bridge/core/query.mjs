/**
 * Unknown query parameters on the routes where ignoring a typo changes the answer.
 *
 * `GET /v1/quotes?symbols=NSE:TCS&maxAge=0` used to answer 200 as if `maxAge` were not there, while the caller thought it had
 * asked for a fresh quote (the name is `maxAgeMs`). On the market-data reads (quotes, ltp, depth, history, expiries, option
 * chain) a parameter the route does not know is now reported:
 *   - by default the read goes ahead and the answer carries `X-MCB-Ignored-Params: maxAge` and, where the name is close to a
 *     real one, `X-MCB-Param-Hint: maxAge: did you mean maxAgeMs`;
 *   - with `?strict=true` (or `1`) it is refused with 400 VALIDATION_FAILED and an `errors` entry per parameter, so a script
 *     can ask for the strict behaviour once and never be silently ignored again.
 * Other routes keep ignoring what they do not know; bodies are always strict.
 */
import { BridgeError } from "./errors.mjs";

/** Parameters the pipeline itself reads on any route (the `?key=` form of the API key on routes that allow it). */
const ALWAYS_KNOWN = Object.freeze(["strict", "key"]);

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** The known name a mistyped one most likely meant: the same word in another case, a prefix of it, or one or two letters off. */
export function suggest(name, known) {
  const lower = name.toLowerCase();
  let best = null;
  for (const k of known) {
    const kl = k.toLowerCase();
    const d = kl === lower ? 0 : kl.startsWith(lower) || lower.startsWith(kl) ? 1 : distance(lower, kl);
    if (d <= 2 && (best === null || d < best.d)) best = { k, d };
  }
  return best?.k ?? null;
}

/**
 * Report (or refuse) the query parameters a route does not know.
 * @param {{ query: URLSearchParams, setHeader?: (name: string, value: string) => void }} ctx
 * @param {readonly string[]} known  every parameter the route reads
 * @returns {string[]} the ignored names (empty when all are known)
 */
export function checkQuery(ctx, known) {
  const ok = new Set([...known, ...ALWAYS_KNOWN]);
  const ignored = [...new Set([...ctx.query.keys()].filter((k) => !ok.has(k)))];
  if (!ignored.length) return [];
  const hints = ignored.map((k) => ({ name: k, meant: suggest(k, known) }));
  const strict = ["true", "1"].includes(String(ctx.query.get("strict") ?? "").toLowerCase());
  if (strict) {
    throw new BridgeError("VALIDATION_FAILED", `This route does not take: ${ignored.slice(0, 8).join(", ")}.${hints.some((h) => h.meant) ? ` ${hints.filter((h) => h.meant).map((h) => `${h.name}: did you mean ${h.meant}?`).join(" ")}` : ""}`, {
      errors: hints.slice(0, 20).map((h) => ({ path: h.name.slice(0, 40), message: h.meant ? `unknown parameter, did you mean ${h.meant}?` : "unknown parameter" })),
    });
  }
  ctx.setHeader?.("X-MCB-Ignored-Params", ignored.slice(0, 20).map((k) => k.replace(/[^\x21-\x7e]/g, "?").slice(0, 40)).join(","));
  const meant = hints.filter((h) => h.meant);
  if (meant.length) ctx.setHeader?.("X-MCB-Param-Hint", meant.slice(0, 5).map((h) => `${h.name.replace(/[^\x21-\x7e]/g, "?").slice(0, 40)}: did you mean ${h.meant}`).join("; "));
  return ignored;
}

/** The parameters every market read takes (readOptionsBase). `maxAgeMs` is left out where a route ignores it. */
export const READ_OPTION_PARAMS = Object.freeze(["account", "backup", "purpose", "swr", "priority"]);
