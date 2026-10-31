/**
 * Startup jobs: work a module begins in start() that some reads must not answer before (the demo book's first-run
 * seed: Home opened a second after the start showed a half-seeded book). Keyed by the app's deps.
 *
 *   startupJob(deps, name, promise)   a module registers a background job from its start()
 *   app.listen()                      arms the gate before it binds, and opens it (in the background) once every
 *                                     module has started and every job settled, or STARTUP_WAIT_MS passed
 *   await startupReady(deps)          a read waits while the gate is armed and not yet open (bounded the same way)
 *   startupProgress(deps, name, p)    a job reports how far it is ({ done, total }, either may be null)
 *   startupStatus(deps)               null when nothing waits; else { ready: false, jobs: [{ name, done, total }] }
 *                                     (GET /v1/health carries it, so a page can show progress instead of a silent wait)
 *
 * Nothing is armed outside listen() (tests that only register modules never wait). A job that fails is logged by its
 * module; the gate opens either way.
 */
export const STARTUP_WAIT_MS = 20_000;

const state = new WeakMap();
const of = (deps) => {
  if (!state.has(deps)) state.set(deps, { armed: false, open: false, jobs: [], waiters: [], progress: new Map() });
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

/** A job's progress so far ({ done, total }: counts, or null while unknown). Kept until the gate opens. */
export function startupProgress(deps, name, { done = null, total = null } = {}) {
  const fin = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  of(deps).progress.set(name, { done: fin(done), total: fin(total) });
}

/**
 * What the Bridge is still doing before it answers gated reads: null once open (or outside listen()), else
 * { ready: false, jobs: [{ name, done, total }] } with each job's last reported progress (null counts until it reports).
 */
export function startupStatus(deps) {
  const s = state.get(deps);
  if (!s || !s.armed || s.open) return null;
  return { ready: false, jobs: s.jobs.map((j) => ({ name: j.name, done: s.progress.get(j.name)?.done ?? null, total: s.progress.get(j.name)?.total ?? null })) };
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
