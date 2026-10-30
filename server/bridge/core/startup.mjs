/**
 * Startup jobs: work a module begins in start() that some reads must not answer before (the demo book's first-run
 * seed: Home opened a second after the start showed a half-seeded book). Keyed by the app's deps.
 *
 *   startupJob(deps, name, promise)   a module registers a background job from its start()
 *   app.listen()                      arms the gate before it binds, and opens it (in the background) once every
 *                                     module has started and every job settled, or STARTUP_WAIT_MS passed
 *   await startupReady(deps)          a read waits while the gate is armed and not yet open (bounded the same way)
 *
 * Nothing is armed outside listen() (tests that only register modules never wait). A job that fails is logged by its
 * module; the gate opens either way.
 */
export const STARTUP_WAIT_MS = 20_000;

const state = new WeakMap();
const of = (deps) => {
  if (!state.has(deps)) state.set(deps, { armed: false, open: false, jobs: [], waiters: [] });
  return state.get(deps);
};
const settle = (p) => Promise.resolve(p).then(
  () => undefined,
  () => undefined,
);

/** Register a startup job (a promise). Reads gated by startupReady wait for it while the Bridge is starting. */
export function startupJob(deps, name, promise) {
  of(deps).jobs.push({ name, promise: settle(promise) });
  return promise;
}

/** Called by app.listen() before binding. */
export function armStartup(deps) {
  const s = of(deps);
  s.armed = true;
  s.open = false;
}

/** Called by app.listen() after every module started: wait for the jobs (bounded), then let reads through. */
export async function openStartup(deps, { maxMs = STARTUP_WAIT_MS } = {}) {
  const s = of(deps);
  let timer = null;
  const cap = new Promise((r) => {
    timer = setTimeout(r, maxMs);
    timer.unref?.();
  });
  await Promise.race([Promise.all(s.jobs.map((j) => j.promise)), cap]);
  clearTimeout(timer);
  s.open = true;
  for (const w of s.waiters.splice(0)) w();
}

/** Resolve at once unless the Bridge is starting with jobs still running; then when they are done (bounded). */
export function startupReady(deps, { maxMs = STARTUP_WAIT_MS } = {}) {
  const s = state.get(deps);
  if (!s || !s.armed || s.open) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, maxMs);
    t.unref?.();
    s.waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}
