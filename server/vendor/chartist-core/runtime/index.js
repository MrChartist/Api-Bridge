// The vector runtime (S08): works a compiled script out over one instrument's daily candlesticks.
export { run, resolveInputs } from './run.js';
export { Budget, DEFAULT_MAX_ELEMENTS } from './budget.js';
export { BadInput, BudgetExceeded, MissingData, NotYetSupported, RuntimeError } from './errors.js';
export { CORE_FUNCTIONS } from './functions.js';
export { aggregateBars, alignIndex, buildCalendar, dailyBars, monthKey, nextWeekday, rulesFromHolidays, weekKey } from './data.js';
export * as kernels from './kernels.js';
export { runPanel, createPanelCache, averageRanks, percentRanks, descendingRanks, zscores, median } from './panel.js';
