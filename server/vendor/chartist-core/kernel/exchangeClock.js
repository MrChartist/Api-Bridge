// Which exchange's clock the time maths reads. The kernel cannot ask the host which market is active, so the host
// registers a provider once; until it does, the clock is the Indian cash session. The provider is read on every
// call, so a market switch changes every bucket boundary at once.
/** The Indian cash session, used until a host registers a provider. */
export const DEFAULT_EXCHANGE_CLOCK = {
    timeZone: 'Asia/Kolkata',
    zoneLabel: 'IST',
    sessionOpenMinute: 9 * 60 + 15,
    sessionCloseMinute: 15 * 60 + 30,
    dailyBarAtOpen: false,
};
let provider = () => DEFAULT_EXCHANGE_CLOCK;
/** Register where the active exchange's clock comes from. Pass nothing to go back to the default. */
export function setExchangeClockProvider(next) {
    provider = next ?? (() => DEFAULT_EXCHANGE_CLOCK);
}
export function exchangeClock() {
    return provider();
}
