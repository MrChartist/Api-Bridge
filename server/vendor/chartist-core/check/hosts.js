const set = (...c) => new Set(c);
export const HOSTS = {
    'server-screener': {
        id: 'server-screener',
        runsAs: 'as a screener',
        caps: set('ohlcv:daily', 'ohlcv:weekly', 'ohlcv:monthly', 'snapshot:levels', 'snapshot:info', 'snapshot:fundamental-current', 'xs', 'bench', 'screener-output'),
        kinds: ['bare-screener', 'screener'],
        xs: 'latest',
        allowNoncausal: false,
    },
    'client-chart': {
        id: 'client-chart',
        runsAs: 'on the chart',
        caps: set('ohlcv:daily', 'ohlcv:weekly', 'ohlcv:monthly', 'ohlcv:intraday', 'bench', 'chart-output', 'alert-output'),
        kinds: ['bare-indicator', 'indicator', 'alert'],
        xs: 'none',
        allowNoncausal: true,
    },
    strategy: {
        id: 'strategy',
        runsAs: 'in a backtest',
        caps: set('ohlcv:daily', 'ohlcv:weekly', 'ohlcv:monthly', 'bench', 'xs', 'strategy-output'),
        kinds: ['strategy'],
        xs: 'panel',
        allowNoncausal: false,
    },
};
/**
 * The host with the data stages that are switched on added to what it has (S31). Only the `deriv:*` capabilities can be
 * added, and never to the chart: its numbers are worked out in the browser, and derivatives data is not sent there.
 * With no stage switched on the host is returned unchanged, so a name that needs derivatives is refused with E-DATA-STAGE.
 */
export function withStages(host, stages) {
    if (host.id === 'client-chart')
        return host;
    const extra = (stages ?? []).filter((c) => c.startsWith('deriv:') && !host.caps.has(c));
    return extra.length === 0 ? host : { ...host, caps: new Set([...host.caps, ...extra]) };
}
export function defaultHostFor(kind) {
    switch (kind) {
        case 'bare-screener':
        case 'screener': return 'server-screener';
        case 'bare-indicator':
        case 'indicator':
        case 'alert': return 'client-chart';
        case 'strategy': return 'strategy';
    }
}
const CAP_WORDS = {
    'ohlcv:daily': 'daily candlesticks',
    'ohlcv:weekly': 'weekly candlesticks',
    'ohlcv:monthly': 'monthly candlesticks',
    'ohlcv:intraday': 'intraday candlesticks',
    'snapshot:levels': 'the nightly support and resistance levels',
    'snapshot:info': 'current stock information such as sector',
    'snapshot:fundamental-current': 'current fundamentals',
    xs: 'a comparison across all stocks',
    bench: 'benchmark and index candlesticks',
    'screener-output': 'result columns',
    'chart-output': 'chart drawing',
    'alert-output': 'alerts',
    'strategy-output': 'backtest entry and exit rules',
    'deriv:live-user-token': 'live options and futures data from your own broker login',
    'deriv:eod': 'end-of-day options and futures data',
    'deriv:vendor': 'a vendor options and futures feed',
};
/** The message for a name that needs data the host does not have. `name` is the user's text, for example `tf("15m")`. */
export function explainMissing(cap, host, name) {
    const need = CAP_WORDS[cap];
    const base = `\`${name}\` needs ${need}, which is not available when the script runs ${host.runsAs}.`;
    switch (cap) {
        case 'ohlcv:intraday':
            return { code: 'E-HOST-INTRADAY', message: base, hint: 'Use daily candlesticks here, or write this as an @indicator and run it on the chart.' };
        case 'screener-output':
            return { code: 'E-HOST-OUTPUT', message: `\`${name}\` adds a result column, but the script runs ${host.runsAs}.`, hint: 'Result columns belong to a screener.' };
        case 'chart-output':
            return { code: 'E-HOST-OUTPUT', message: `\`${name}\` draws on a chart, but the script runs ${host.runsAs}.`, hint: 'Drawing belongs to an @indicator, which runs on the chart.' };
        case 'alert-output':
            return { code: 'E-HOST-OUTPUT', message: `\`${name}\` raises an alert, but the script runs ${host.runsAs}.`, hint: 'Alerts belong to an @alert script.' };
        case 'strategy-output':
            return { code: 'E-HOST-OUTPUT', message: `\`${name}\` sets a backtest rule, but the script runs ${host.runsAs}.`, hint: 'Entry and exit rules belong to an @strategy script.' };
        case 'deriv:live-user-token':
        case 'deriv:eod':
        case 'deriv:vendor':
            return {
                code: 'E-DATA-STAGE',
                message: base,
                hint: host.id === 'client-chart' ? 'Options and futures data is used by screeners and backtests, not on the chart.' : 'Options and futures data is not switched on yet.',
            };
        case 'snapshot:levels':
        case 'snapshot:info':
        case 'snapshot:fundamental-current':
            return {
                code: 'E-HOST-DATA',
                message: `\`${name}\` gives a value for the latest candlestick only, so it cannot be used when the script runs ${host.runsAs}.`,
                hint: 'Past values are not stored, so using it for earlier candlesticks would be a guess.',
            };
        default:
            return { code: 'E-HOST-DATA', message: base, hint: 'Check which data this kind of script can use.' };
    }
}
/** Plain words for the kinds, used in messages. */
export function kindWords(kind) {
    switch (kind) {
        case 'bare-screener':
        case 'screener': return 'a screener';
        case 'bare-indicator':
        case 'indicator': return 'an indicator';
        case 'alert': return 'an alert';
        case 'strategy': return 'a strategy';
    }
}
