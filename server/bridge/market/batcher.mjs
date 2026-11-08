/**
 * Micro-batcher. Requests that arrive within a short window (default 25 ms) for the same group (one
 * account and one kind of read) are handed to `run` together, so twenty clients asking for overlapping symbols at
 * the same moment cost one broker call per account instead of twenty. Items with the same id inside one window are
 * merged: every waiter gets the same result.
 *
 * `run(group, ids)` must resolve to a Map id -> { value } | { error } covering every id; a missing id rejects that
 * item's waiters with `missingError(id)`. A thrown error rejects every waiter in the batch.
 */

/**
 * @param {{ windowMs?: number, maxSize?: number, run: (group: string, ids: string[]) => Promise<Map<string, { value?: any, error?: any }>>,
 *   setTimer?: (fn: Function, ms: number) => any, clearTimer?: (h: any) => void,
 *   missingError?: (id: string) => Error, onMerged?: (count: number) => void }} opts
 */
export function createBatcher({ windowMs = 25, maxSize = 1000, run, setTimer, clearTimer, missingError, onMerged }) {
  if (typeof run !== "function") throw new TypeError("batcher needs run()");
  const set = setTimer ?? ((fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  });
  const clear = clearTimer ?? ((h) => clearTimeout(h));
  const missing = missingError ?? ((id) => new Error(`No result for ${id}`));
  /** @type {Map<string, { waiters: Map<string, Array<{ resolve: Function, reject: Function }>>, timer: any }>} */
  const groups = new Map();

  function flush(group) {
    const g = groups.get(group);
    if (!g) return;
    groups.delete(group);
    if (g.timer) clear(g.timer);
    const waiters = g.waiters;
    const ids = [...waiters.keys()];
    Promise.resolve()
      .then(() => run(group, ids))
      .then(
        (results) => {
          for (const [id, list] of waiters) {
            const r = results?.get(id);
            for (const w of list) {
              if (!r) w.reject(missing(id));
              else if (r.error) w.reject(r.error);
              else w.resolve(r.value);
            }
          }
        },
        (err) => {
          for (const list of waiters.values()) for (const w of list) w.reject(err);
        },
      );
  }

  return {
    /**
     * Queue one id in a group.
     * @param {string} group
     * @param {string} id
     * @returns {Promise<any>}
     */
    add(group, id) {
      return new Promise((resolve, reject) => {
        let g = groups.get(group);
        if (!g) {
          g = { waiters: new Map(), timer: null };
          groups.set(group, g);
        }
        const list = g.waiters.get(id);
        if (list) {
          list.push({ resolve, reject });
          onMerged?.(1);
        } else g.waiters.set(id, [{ resolve, reject }]);
        if (g.waiters.size >= maxSize) flush(group);
        else if (!g.timer) g.timer = set(() => flush(group), windowMs);
      });
    },
    /** Flush every open group now (shutdown, tests). */
    flushAll() {
      for (const group of [...groups.keys()]) flush(group);
    },
    /** Number of open groups. */
    get pending() {
      return groups.size;
    },
  };
}
