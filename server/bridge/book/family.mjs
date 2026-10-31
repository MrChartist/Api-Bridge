/**
 * The family gate (stream S27, F11; docs/spec/p1-12-guard-participants.md §7.12). Pure: config and holder tags come in
 * as arguments, nothing is read or written here.
 *
 *   holder = account.holder ?? book.untaggedHolder                         ("self" by default)
 *   rel    = book.holders[holder]?.relationship  (config lock)
 *         ?? tags[holder]?.relationship          (holders.json, set on the Accounts page)
 *         ?? (holder === book.untaggedHolder ? "self" : null)
 *   ok     = rel !== null && book.family.relationships.includes(rel)
 *
 * Guards (P1-12) and alert actions (P1-11) call automationAllowed() before they may act on an account. The book uses
 * the same functions to decide who is in the family view. Nothing here ever pools data or orders across holders.
 */
import { bookConfig } from "./config.mjs";

/** @typedef {{ relationship: string, label?: string }} HolderTag */
/** @typedef {Record<string, HolderTag>} HolderTags */

const accountOf = (config, accountId) => (config?.accounts ?? []).find((a) => a.id === accountId) ?? null;

/** The holder an account belongs to (its `holder`, else book.untaggedHolder). */
export function holderOf(config, account) {
  const a = typeof account === "string" ? accountOf(config, account) : account;
  const h = typeof a?.holder === "string" && a.holder.trim() ? a.holder.trim() : null;
  return h ?? bookConfig(config).untaggedHolder;
}

/**
 * A holder's tag and where it came from: "config" (locked in bridge.config.json), "file" (holders.json), "default"
 * (the untagged holder counts as self) or null (no tag).
 * @param {object} config @param {HolderTags} tags @param {string} holder
 * @returns {{ relationship: string|null, label: string|null, source: "config"|"file"|"default"|null }}
 */
export function tagOf(config, tags, holder) {
  const book = bookConfig(config);
  const lock = book.holders[holder];
  if (lock) return { relationship: lock.relationship, label: lock.label ?? tags?.[holder]?.label ?? null, source: "config" };
  const t = tags?.[holder];
  if (t?.relationship) return { relationship: t.relationship, label: t.label ?? null, source: "file" };
  if (holder === book.untaggedHolder) return { relationship: "self", label: t?.label ?? null, source: "default" };
  return { relationship: null, label: t?.label ?? null, source: null };
}

/** A holder's relationship, or null when it has none. */
export const relationshipOf = (config, tags, holder) => tagOf(config, tags, holder).relationship;

/** Whether a relationship is inside the configured family definition. */
export function inFamily(config, rel) {
  return rel !== null && rel !== undefined && bookConfig(config).family.relationships.includes(rel);
}

/**
 * May automation (guards, alert actions) act on this account? §7.12.
 * @param {object} config  the Bridge config (accounts + book section)
 * @param {HolderTags} tags  holders.json tags
 * @param {string} accountId
 * @returns {{ ok: boolean, code: string|null, reason: string|null, holder: string|null, relationship: string|null }}
 */
export function automationAllowed(config, tags, accountId) {
  const account = accountOf(config, accountId);
  if (!account) return { ok: false, code: "ACCOUNT_NOT_FOUND", reason: `There is no account "${accountId}" in bridge.config.json.`, holder: null, relationship: null };
  const holder = holderOf(config, account);
  const rel = relationshipOf(config, tags, holder);
  const ok = inFamily(config, rel);
  const reason =
    rel === null
      ? `Holder '${holder}' has no relationship tag. Set it on the Accounts page.`
      : !ok
        ? `Holder '${holder}' is tagged '${rel}', which is outside the family definition (book.family.relationships).`
        : null;
  return { ok, code: ok ? null : "AUTOMATION_NOT_ALLOWED", reason, holder, relationship: rel };
}

/**
 * Every holder with its accounts, relationship and family membership (config order of first account; tagged holders
 * without accounts after them).
 * @param {object} config @param {HolderTags} tags
 * @returns {Array<{ holder: string, label: string, relationship: string|null, inFamily: boolean, source: string|null, locked: boolean, accounts: string[] }>}
 */
export function holderList(config, tags) {
  const by = new Map();
  for (const a of config?.accounts ?? []) {
    const h = holderOf(config, a);
    if (!by.has(h)) by.set(h, []);
    by.get(h).push(a.id);
  }
  for (const h of [...Object.keys(bookConfig(config).holders), ...Object.keys(tags ?? {})]) if (!by.has(h)) by.set(h, []);
  return [...by.entries()].map(([holder, accounts]) => {
    const t = tagOf(config, tags, holder);
    return { holder, label: t.label ?? defaultLabel(holder, t.relationship), relationship: t.relationship, inFamily: inFamily(config, t.relationship), source: t.source, locked: t.source === "config", accounts };
  });
}

/** "Me" for the self holder without a label, else the holder name. */
export const defaultLabel = (holder, rel) => (rel === "self" && (holder === "self" || !holder) ? "Me" : holder);
