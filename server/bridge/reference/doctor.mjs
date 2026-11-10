/**
 * Doctor lines for the shipped reference data: warns when the holiday calendar has no rows for next year, or when a dataset's
 * asOf is older than six months (reference/freshness.mjs). Read from the files shipped with the Bridge; creates nothing. A
 * warning never fails `doctor --strict`: old reference data is shown, never enforced.
 */
import { referenceFreshness } from "./freshness.mjs";

/** @returns {Array<{ level: "ok"|"warn", check: string, message: string, fix?: string }>} */
export function referenceDoctorChecks({ now = Date.now(), data } = {}) {
  const r = referenceFreshness({ now, data });
  const warns = r.items.filter((i) => i.level === "warn");
  if (!warns.length) return [{ level: "ok", check: "reference-data", message: `Reference data is current (${r.items.length} items checked).` }];
  return warns.map((i) => ({ level: "warn", check: `reference-data:${i.id}`, message: i.message, ...(i.fix ? { fix: i.fix } : {}) }));
}
