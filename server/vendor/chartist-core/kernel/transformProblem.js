/** A rejected chart transform is distinct from missing market data. Never return partial history. */
export const MAX_RENKO_BRICKS = 100000;
const TRANSFORM_PROBLEMS = {
    limit: `This brick size would create more than ${MAX_RENKO_BRICKS} Renko bricks. Increase the brick size or choose Candle.`,
    precision: 'This brick size is too small for the price precision. Increase the brick size or choose Candle.',
    // A Renko brick needs the close to move one full brick; a brick larger than every move leaves nothing to draw.
    empty: 'This brick size is larger than every price move on this chart, so there are no Renko bricks to draw. Choose a smaller brick size or Auto (ATR) brick size, or choose Candle.',
};
export class ChartTransformError extends Error {
    reason;
    constructor(reason) {
        super(TRANSFORM_PROBLEMS[reason]);
        this.reason = reason;
        this.name = 'ChartTransformError';
    }
}
