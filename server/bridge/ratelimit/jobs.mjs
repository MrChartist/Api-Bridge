/**
 * Background jobs that spend broker budget, with their progress, for the API budget panel ("Preparing scans 34/200").
 * A job registers itself, updates `done`, and ends; the budget summary (budget.mjs) lists the running ones. Labels are
 * plain words, never a symbol list or anything secret. One registry per process (like recordSaving in scheduler.mjs).
 */

/** id -> { id, label, done, total, startedAt, paused } */
const running = new Map();

/** Start or update a job. */
export function setJob(id, { label, done = 0, total = 0, paused = false } = {}) {
  const prev = running.get(id);
  running.set(id, { id, label: String(label ?? prev?.label ?? id).slice(0, 60), done: Math.max(0, Math.floor(done)), total: Math.max(0, Math.floor(total)), paused: Boolean(paused), startedAt: prev?.startedAt ?? Date.now() });
}

/** The job is finished (or stopped). */
export function endJob(id) {
  running.delete(id);
}

/** Running jobs, oldest first, as the budget summary shows them. */
export function listJobs() {
  return [...running.values()].map(({ id, label, done, total, paused }) => ({ id, label, done, total, paused }));
}
