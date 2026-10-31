import { headlinesAllowed } from './labels.js';
/** Views a result offers. */
export const RESULT_VIEWS = ['summary', 'risk', 'trades', 'trades_page', 'yearly', 'monthly', 'drawdowns', 'costs', 'exposure', 'benchmark', 'equity', 'trials', 'surface', 'windows'];
/** Views that show absolute return, so they wait for a point-in-time universe (no survivors-only label). */
const HEADLINE_VIEWS = new Set(['yearly', 'monthly', 'equity']);
/** What people ask for that the platform will not show, and why (so a refusal can say it). */
export const FORBIDDEN_VIEWS = {
    leaderboard: 'Ranking strategies against each other invites picking the best of many tries; every run is shown with its trial count instead.',
    best_trades: 'Showing only the largest gains says nothing about the rest; trades are shown as a whole, in order.',
    worst_trades: 'Showing only the largest losses says nothing about the rest; trades are shown as a whole, in order.',
    win_rate: 'The share of winning trades alone hides how large wins and losses are; see expectancy and profit factor with the trade counts.',
    best_window: 'A single chosen window is a pick, not evidence; all walk-forward windows are shown together.',
    best_params: 'A single top-scoring setting is the most overfit one; the whole robustness surface is shown instead.',
    projection: 'A result describes the past under stated assumptions and says nothing about the future.',
};
export function viewAllowed(view, labels) {
    if (Object.hasOwn(FORBIDDEN_VIEWS, view))
        return { ok: false, reason: FORBIDDEN_VIEWS[view] };
    if (!RESULT_VIEWS.includes(view))
        return { ok: false, reason: `there is no view called ${view}` };
    if (HEADLINE_VIEWS.has(view) && !headlinesAllowed(labels))
        return { ok: false, reason: 'Absolute return is not shown while the data holds survivors only (SURVIVORS_ONLY).' };
    return { ok: true };
}
/**
 * Words a result must never contain: a past simulation is not a promise, a forecast, an instruction or a boast. This list is a superset of the
 * app's (`src/domains/learn/examples/stats.ts` FORBIDDEN_WORDING), and a bridge test keeps it so.
 */
export const FORBIDDEN_WORDING = /win[\s_-]?rate|accuracy|guarantee|sure[\s-]?shot|risk[\s-]?free|you would have (made|earned|gained)|will (go|rise|fall|rally)|\bbest (trade|strategy|setting)|beat the market|can'?t lose|easy money/i;
/** The first forbidden phrase in `text`, or null. */
export const forbiddenIn = (text) => FORBIDDEN_WORDING.exec(text)?.[0] ?? null;
