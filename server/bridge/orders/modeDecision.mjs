/**
 * Paper or live?
 *
 * An order is live only when EVERY one of these holds (docs/ARCHITECTURE.md §4, §8):
 *   1. config.safety.liveTrading is true (config file only; MCB_PAPER_ONLY forces it off)
 *   2. the account's `live.enabled` is true, it is enabled and not a paper account   (liveAllowedByConfig)
 *   3. the API key has the "live" scope
 *   4. the request's source (rest | webhook | mcp | cli) is in the account's `live.allowedSources`
 *   5. the request says `mode: "live"` explicitly (the default is paper)
 *   6. for orders prepared by an AI assistant or by a hook set to require it: a human-confirmed ticket
 *
 * "AI assistant" is decided by the KEY, not the transport: a key made for an AI assistant (clientKind "mcp") counts
 * as source "mcp" on every route, REST included. Otherwise a prompt-injected agent with a shell or fetch tool could
 * call POST /v1/orders directly and skip the human ticket (and match a "rest" entry in live.allowedSources).
 *
 * A request that asks for live and misses any of these is REFUSED (never silently downgraded to paper):
 *   1, 2, 4 -> PAPER_ONLY · 3 -> SCOPE_REQUIRED · 6 -> CONFIRMATION_REQUIRED.
 * A paper request needs no live opt-in. AI-prepared paper orders also need a confirmation unless
 * orders.confirmPaperFromMcp is false.
 */
import { liveAllowedByConfig } from "../core/config.mjs";

/**
 * Sources whose LIVE orders the readiness gate refuses while their account cannot trade: nobody is watching the
 * order go out. "guard" and "alert" are reserved sources for automated rules. Orders a person
 * sends (rest, cli, a confirmed MCP ticket) get a readiness warning instead.
 */
export const AUTOMATED_SOURCES = Object.freeze(["webhook", "system", "guard", "alert"]);

/**
 * @typedef {{ mode: "paper"|"live", requested: "paper"|"live", needsConfirmation: boolean,
 *   refusals: Array<{ code: string, message: string, severity: "block" }> }} ModeDecision
 */

/**
 * Whether this caller's orders need a human confirmation (before the mode is known).
 * Hooks mark themselves with ctx.confirmationRequired = true (set by the hook worker, hooks).
 * @param {import("../core/context.mjs").RequestContext} ctx
 */
export function sourceNeedsConfirmation(ctx) {
  return effectiveSource(ctx) === "mcp" || ctx.confirmationRequired === true;
}

/**
 * The source an order counts as. A key whose clientKind is "mcp" is always "mcp", whichever route it calls.
 * @param {import("../core/context.mjs").RequestContext} ctx
 * @returns {string}
 */
export function effectiveSource(ctx) {
  return ctx?.key?.clientKind === "mcp" ? "mcp" : ctx?.source;
}

/**
 * @param {{ config: any, accountCfg: any | undefined, summary: { id: string, broker: string, enabled: boolean },
 *   requested: "paper"|"live" | undefined, ctx: import("../core/context.mjs").RequestContext,
 *   confirmPaperFromMcp: boolean }} input
 * @returns {ModeDecision}
 */
export function decideMode({ config, accountCfg, summary, requested, ctx, confirmPaperFromMcp }) {
  const want = requested === "live" ? "live" : "paper";
  const refusals = [];
  const refuse = (code, message) => refusals.push({ code, message, severity: "block" });
  const needsHuman = sourceNeedsConfirmation(ctx);
  const source = effectiveSource(ctx);

  if (want === "paper") {
    const needsConfirmation = needsHuman && (source !== "mcp" || confirmPaperFromMcp);
    return { mode: "paper", requested: want, needsConfirmation, refusals };
  }

  const id = summary.id;
  if (summary.broker === "paper") {
    refuse("PAPER_ONLY", `${id} is a paper account; it cannot place live orders.`);
  } else {
    // liveAllowedByConfig needs the config entry; an account that is not in the config can never be live.
    const cfgAccount = accountCfg ?? { broker: summary.broker, enabled: summary.enabled, live: { enabled: false } };
    if (!config?.safety?.liveTrading) refuse("PAPER_ONLY", "Live trading is off for the Bridge (safety.liveTrading in the config file). The order was not sent.");
    else if (!liveAllowedByConfig(config, { ...cfgAccount, enabled: cfgAccount.enabled !== false && summary.enabled !== false })) {
      refuse("PAPER_ONLY", `Live trading is not enabled for ${id} (accounts[].live.enabled in the config file). The order was not sent.`);
    }
  }
  if (!ctx.scopes?.has("live")) refuse("SCOPE_REQUIRED", 'This API key does not have the "live" scope, so it can only place paper orders.');
  const allowed = accountCfg?.live?.allowedSources ?? [];
  if (summary.broker !== "paper" && !allowed.includes(source)) {
    refuse("PAPER_ONLY", `Live orders from ${sourceLabel(source)} are not allowed for ${id} (accounts[].live.allowedSources).`);
  }
  return { mode: refusals.length ? "paper" : "live", requested: want, needsConfirmation: needsHuman, refusals };
}

/** Human label for a source, for messages. */
export function sourceLabel(source) {
  return (
    { rest: "scripts and apps (REST)", webhook: "webhooks", mcp: "AI assistants", cli: "the command line", system: "the Bridge itself", stream: "the stream", guard: "strategy guards", alert: "alert actions" }[source] ??
    String(source)
  );
}
