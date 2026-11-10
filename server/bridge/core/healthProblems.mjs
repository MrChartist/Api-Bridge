/**
 * What is wrong right now, in plain words, for GET /v1/health (`status: "degraded"` and `problems`) and
 * GET /v1/ready. One list: the dashboard, `mc-bridge doctor` and a Docker health check read the same facts.
 *
 *   storage_low / storage_critical   little free space on the data folder's disk (storage/monitor.mjs)
 *   write_errors                     a state file could not be written and has not been written since
 *   data_quarantined                 a damaged file was moved aside at start (the store began empty)
 *   order_state_damaged              the record of sent orders was damaged: live orders are refused (orders/stateFile.mjs)
 *   kill_switch_on                   no orders are being sent
 *
 * Never throws: a part that cannot answer is left out. Readers on this computer only; the public answer carries just
 * the word "ok" or "degraded".
 */
import { quarantined } from "../../lib/storageHealth.mjs";
import { isStub } from "./contracts.mjs";
import { storageMonitorOf } from "../storage/registry.mjs";

/** @returns {Array<{ code: string, message: string }>} */
export function healthProblems(deps) {
  const out = [];
  try {
    out.push(...(storageMonitorOf(deps)?.problems() ?? []));
  } catch {
    /* the monitor is not available */
  }
  try {
    const q = quarantined({ under: deps.paths.dataDir });
    for (const e of q.slice(-5)) out.push({ code: "data_quarantined", message: `${e.what} ${e.reason}; the file was moved aside${e.movedTo ? ` (${e.movedTo})` : ""} and the Bridge started without it.` });
    if (q.length > 5) out.push({ code: "data_quarantined", message: `${q.length - 5} more files were moved aside. See the log, or run: mc-bridge doctor.` });
  } catch {
    /* not available */
  }
  try {
    if (deps.orders && !isStub(deps.orders)) {
      const d = deps.orders.stateDamage?.();
      if (d) out.push({ code: "order_state_damaged", message: "The record of sent orders was damaged and set aside. Paper orders work; live orders are refused until you check your broker's order book and run: mc-bridge orders acknowledge-state." });
    }
  } catch {
    /* not available */
  }
  try {
    if (deps.safety && !isStub(deps.safety) && deps.safety.killSwitchStatus?.().engaged) out.push({ code: "kill_switch_on", message: "The kill switch is on: no orders are being sent." });
  } catch {
    /* not available */
  }
  return out;
}

/**
 * Reasons the Bridge should not be sent work yet (GET /v1/ready answers 503 with them): still starting, or no room to save.
 * @param {object} deps
 * @param {{ startup: object | null }} o  startup: startupStatus(deps)
 */
export function notReadyReasons(deps, { startup }) {
  const reasons = [];
  if (startup) reasons.push({ code: "starting", message: "The Bridge is still starting.", jobs: startup.jobs });
  try {
    const st = storageMonitorOf(deps)?.status();
    if (st?.level === "critical") reasons.push({ code: "storage_critical", message: "The disk holding the Bridge's data is full or nearly full, so changes cannot be saved safely." });
  } catch {
    /* not available */
  }
  return reasons;
}
