// Pure helpers for the Morning login sheet and the broker verification badge. No DOM, no network: unit-tested in node.
//
// Morning login: which accounts need a login today, how each one logs in, in what order, and how far along the person is.
// The Bridge never logs in by itself and never stores a one-time code, so this only describes what the person has to do.

/** How an account logs in, in the words the sheet shows. Keys are the adapters' auth kinds. */
export const METHOD = Object.freeze({
  sessionLogin: { label: "Session login", hint: "Your password or PIN and the current 6-digit code, typed now" },
  requestTokenExchange: { label: "One-time code", hint: "Log in on the broker's page, then paste the code it gives you" },
  oauthRedirect: { label: "OAuth link", hint: "Log in on the broker's page, then paste the token it gives you" },
  apiKeyToken: { label: "Access token", hint: "Paste today's access token from the broker" },
});

const IST_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;

/** The end of today in IST (the next midnight), as an epoch ms. A normal session ends the next morning, after this. */
export const endOfDay = (nowMs) => (Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - IST_OFFSET_MS;

/** The method entry for a broker (its auth kind), with a safe fallback. */
export const methodOf = (broker) => METHOD[broker?.authKind] ?? METHOD.apiKeyToken;

/**
 * What the person has to do for one account today, or null when nothing.
 *   missing / expired / error  the session is not usable: a login is needed now
 *   ends-early                 the session works but the broker ends it later today
 */
export function loginNeed(account, nowMs) {
  if (!account || account.broker === "paper" || account.broker === "demo" || account.enabled === false) return null;
  const s = account.session?.state;
  if (s === "connecting") return null;
  if (s !== "connected") return s === "expired" ? "expired" : s === "error" ? "error" : "missing";
  const ends = account.session?.expiresAt ? Date.parse(account.session.expiresAt) : NaN;
  if (Number.isFinite(ends) && ends > nowMs && ends < endOfDay(nowMs)) return "ends-early";
  return null;
}

const NEED_TEXT = Object.freeze({ missing: "Not logged in", expired: "Session ended", error: "Login failed", "ends-early": "Ends today" });
const NEED_TONE = Object.freeze({ missing: "warn", expired: "bad", error: "bad", "ends-early": "warn" });
const NEED_ORDER = Object.freeze({ expired: 0, missing: 1, error: 2, "ends-early": 3 });

/**
 * The accounts that need a login now, most urgent first, each with the method it uses. Accounts that are fine are left out.
 * @param {object[]} accounts  GET /v1/accounts rows  @param {object[]} brokers  GET /v1/brokers rows  @param {number} nowMs
 */
export function loginPlan(accounts, brokers, nowMs) {
  const out = [];
  for (const a of accounts ?? []) {
    const need = loginNeed(a, nowMs);
    if (!need) continue;
    const broker = (brokers ?? []).find((b) => b.id === a.broker) ?? null;
    out.push({ account: a, broker, need, needText: NEED_TEXT[need], tone: NEED_TONE[need], method: methodOf(broker ?? { authKind: a.authKind }), singleSession: broker?.singleSession === true, endsAt: need === "ends-early" ? a.session?.expiresAt ?? null : null });
  }
  return out.sort((x, y) => NEED_ORDER[x.need] - NEED_ORDER[y.need] || String(x.account.label).localeCompare(String(y.account.label)));
}

/**
 * Progress through one morning's run. `startIds` are the accounts that needed a login when the person began; `plan` is the
 * plan now. An account is done once it no longer needs a login, skipped when the person chose to leave it.
 * @returns {{ total: number, done: number, skipped: number, left: number, current: object | null, finished: boolean }}
 */
export function progress(startIds, plan, skippedIds = new Set()) {
  const stillNeeds = new Set(plan.map((p) => p.account.id));
  const total = startIds.length;
  const skipped = startIds.filter((id) => stillNeeds.has(id) && skippedIds.has(id)).length;
  const done = startIds.filter((id) => !stillNeeds.has(id)).length;
  const next = plan.find((p) => startIds.includes(p.account.id) && !skippedIds.has(p.account.id)) ?? null;
  return { total, done, skipped, left: total - done - skipped, current: next, finished: next === null };
}

/** "2 of 4 logged in" style headline for the sheet. */
export function progressText(p) {
  if (p.total === 0) return "Nothing to log in to";
  if (p.finished && p.skipped === 0) return p.total === 1 ? "Logged in" : `All ${p.total} logged in`;
  if (p.finished) return `${p.done} of ${p.total} logged in, ${p.skipped} left for later`;
  return `${p.done} of ${p.total} logged in`;
}

// ── Broker verification badge (server/brokers/verification.json, as GET /v1/brokers returns it) ──

export const LEVEL_ORDER = Object.freeze(["live-verified", "sandbox", "contract", "beta"]);
const LEVEL_SHORT = Object.freeze({ "live-verified": "Verified", sandbox: "Sandbox", contract: "Contract-tested", beta: "Beta" });
const LEVEL_TONE = Object.freeze({ "live-verified": "ok", sandbox: "info", contract: "info", beta: "" });

/** The ladder level of a broker row; an older Bridge that sends only `verified` still works. */
export const levelOf = (b) => b?.verification?.level ?? (b?.verified ? "live-verified" : "beta");
export const levelText = (b) => LEVEL_SHORT[levelOf(b)] ?? "Beta";
export const levelTone = (b) => LEVEL_TONE[levelOf(b)] ?? "";
/** Higher is better, for sorting a catalogue. */
export const levelRank = (b) => LEVEL_ORDER.length - LEVEL_ORDER.indexOf(levelOf(b));

/** How many brokers sit at each level, in ladder order, only the levels that have any (counts come from the data). */
export function levelCounts(brokers) {
  const counts = new Map();
  for (const b of brokers) counts.set(levelOf(b), (counts.get(levelOf(b)) ?? 0) + 1);
  return LEVEL_ORDER.filter((l) => counts.has(l)).map((l) => ({ level: l, text: LEVEL_SHORT[l], n: counts.get(l) }));
}

/** The catalogue's one-line summary, generated from the counts: "1 verified with a live account, 36 contract-tested, 4 in beta". */
export function ladderSummary(brokers) {
  const parts = levelCounts(brokers).map(({ level, n }) => `${n} ${{ "live-verified": "verified with a live account", sandbox: "checked in a sandbox", contract: "contract-tested", beta: "in beta" }[level]}`);
  return parts.length ? `${parts.join(", ")}. Beta means recorded samples only; contract-tested means every contract case passes on recorded replies. None of these touched a real broker until it is marked verified.` : "";
}
