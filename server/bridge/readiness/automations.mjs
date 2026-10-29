/**
 * Automation registry (docs/spec/p1-05-readiness.md §3.8). In memory only: automations re-register at boot (the hooks
 * module walks its store; P1-11/12 rules register when they load).
 *
 *  register({ id, kind, accountId, mode, label, onState? }) -> { update(patch), remove() }   duplicate id → VALIDATION_FAILED
 *  byAccount(accountId) -> entries                     list(), get(id), count()
 *  notify({ accountId, state, reasons, at })           calls onState of that account's automations, each in its own
 *                                                      microtask with a try/catch (one consumer cannot block another)
 *
 * An automation with mode "paper" is listed, but its state is always "ready": paper never needs the broker session.
 */
import { BridgeError } from "../core/errors.mjs";

export const AUTOMATION_KINDS = Object.freeze(["webhook", "guard", "alert", "sample"]);
const MAX_AUTOMATIONS = 500;

/**
 * @param {{ logger?: any }} [opts]
 */
export function createAutomationRegistry({ logger } = {}) {
  /** @type {Map<string, { id: string, kind: string, accountId: string, mode: "paper"|"live", label: string, onState: Function | null }>} */
  const items = new Map();

  const validate = (a) => {
    const errors = [];
    if (typeof a?.id !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(a.id)) errors.push({ path: "id", message: "1-80 letters, digits or _ . : -" });
    if (!AUTOMATION_KINDS.includes(a?.kind)) errors.push({ path: "kind", message: `one of ${AUTOMATION_KINDS.join(", ")}` });
    if (typeof a?.accountId !== "string" || !a.accountId) errors.push({ path: "accountId", message: "required" });
    if (a?.mode !== "paper" && a?.mode !== "live") errors.push({ path: "mode", message: '"paper" or "live"' });
    if (a?.onState !== undefined && a?.onState !== null && typeof a.onState !== "function") errors.push({ path: "onState", message: "a function" });
    if (errors.length) throw new BridgeError("VALIDATION_FAILED", "This automation cannot be registered with readiness.", { errors });
  };

  return {
    register(input) {
      validate(input);
      if (items.has(input.id)) throw new BridgeError("VALIDATION_FAILED", `An automation with id ${input.id} is already registered.`, { errors: [{ path: "id", message: "duplicate" }] });
      if (items.size >= MAX_AUTOMATIONS) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_AUTOMATIONS} automations can be registered.`);
      const entry = { id: input.id, kind: input.kind, accountId: input.accountId, mode: input.mode, label: String(input.label ?? input.id).slice(0, 120), onState: input.onState ?? null };
      items.set(entry.id, entry);
      return {
        update(patch = {}) {
          if (!items.has(entry.id)) return;
          const next = { ...entry, ...Object.fromEntries(Object.entries(patch).filter(([k]) => ["mode", "accountId", "label"].includes(k))) };
          validate(next);
          Object.assign(entry, next);
        },
        remove() {
          items.delete(entry.id);
        },
      };
    },
    get: (id) => items.get(id) ?? null,
    list: () => [...items.values()],
    byAccount: (accountId) => [...items.values()].filter((a) => a.accountId === accountId),
    count: () => items.size,
    /** Tell every automation on this account about its new state (paper ones always see "ready"). */
    notify({ accountId, state, reasons, at }) {
      for (const a of [...items.values()]) {
        if (a.accountId !== accountId || !a.onState) continue;
        const payload = { accountId, state: a.mode === "paper" ? "ready" : state, reasons: reasons ?? [], at, automationId: a.id };
        queueMicrotask(() => {
          try {
            const r = a.onState(payload);
            if (r && typeof r.catch === "function") r.catch((err) => logger?.warn?.("automation onState failed", { automationId: a.id, err: err?.message }));
          } catch (err) {
            logger?.warn?.("automation onState failed", { automationId: a.id, err: err?.message });
          }
        });
      }
    },
  };
}
