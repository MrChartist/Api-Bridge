/** deps -> storage monitor, so start() and the health route find what register() built. */
export const monitors = new WeakMap();

/** The storage monitor of an app (undefined before register, or in an app without the module). */
export const storageMonitorOf = (deps) => monitors.get(deps);
