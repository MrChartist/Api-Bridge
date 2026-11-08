/**
 * Test helpers for readiness consumers (automated rules, guards, e2e). Not used by the running Bridge.
 *
 *   const auto = fakeAutomation(deps.readiness, { id: "guard-1", accountId: "stub-live", mode: "live" });
 *   … auto.states  → every onState payload received, in order;  auto.last() → the latest;  auto.remove()
 */

/**
 * @param {{ registerAutomation: Function }} readiness  the readiness service (or its registry)
 * @param {{ id: string, accountId: string, mode?: "paper"|"live", kind?: string, label?: string }} opts
 */
export function fakeAutomation(readiness, { id, accountId, mode = "live", kind = "guard", label }) {
  const states = [];
  const handle = readiness.registerAutomation({ id, kind, accountId, mode, label: label ?? `Test ${kind} ${id}`, onState: (s) => states.push(s) });
  return {
    states,
    last: () => states.at(-1) ?? null,
    update: (patch) => handle.update(patch),
    remove: () => handle.remove(),
  };
}
