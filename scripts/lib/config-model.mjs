/**
 * Reads the real configuration schema (core sections plus every module's section) and lists each key with its type,
 * default and limits. docs/guides/config.md is generated from this and from scripts/lib/config-descriptions.mjs.
 * Nothing here is typed by hand: a new key in a zod schema shows up in the list, and a test fails until it has a description.
 */
import { coreSchema } from "../../server/bridge/core/config.mjs";
import { BUILTIN_MODULES } from "../../server/bridge/core/builtinModules.mjs";

/** @typedef {{ path: string, type: string, default: unknown, hasDefault: boolean, optional: boolean, nullable: boolean, limits: string[], values: string[] | null, section: string }} ConfigKey */

const defOf = (s) => s._zod.def;

/** Strip optional / nullable / default / prefault wrappers, remembering what they said. */
function unwrap(schema) {
  let s = schema;
  const info = { optional: false, nullable: false, hasDefault: false, default: undefined };
  for (;;) {
    const d = defOf(s);
    if (d.type === "optional") info.optional = true;
    else if (d.type === "nullable") info.nullable = true;
    else if (d.type === "default" || d.type === "prefault") {
      if (!info.hasDefault) {
        info.hasDefault = true;
        info.default = d.defaultValue;
        if (d.type === "prefault" && defOf(d.innerType).type === "object") info.default = undefined;
      }
    } else if (d.type === "pipe") {
      s = d.in;
      continue;
    } else break;
    s = d.innerType;
  }
  return { schema: s, ...info };
}

/** The tightest bounds of a number schema: { integer, min, minExclusive, max }. */
function numberBounds(def) {
  const b = { integer: false, min: null, minExclusive: false, max: null };
  for (const c of def.checks ?? []) {
    const cd = c._zod.def;
    if (cd.check === "number_format" && /int/.test(cd.format)) b.integer = true;
    else if (cd.check === "greater_than") {
      const exclusive = !cd.inclusive;
      if (b.min === null || cd.value > b.min || (cd.value === b.min && exclusive)) {
        b.min = cd.value;
        b.minExclusive = exclusive;
      }
    } else if (cd.check === "less_than") {
      if (b.max === null || cd.value < b.max) b.max = cd.value;
    }
  }
  return b;
}

/** "whole number, 1 to 65535", "number above 0, up to 10". */
export function describeBounds(b) {
  const kind = b.integer ? "whole number" : "number";
  if (b.min !== null && b.max !== null && !b.minExclusive) return `${kind}, ${b.min} to ${b.max}`;
  const parts = [];
  if (b.min !== null) parts.push(b.minExclusive ? `above ${b.min}` : `at least ${b.min}`);
  if (b.max !== null) parts.push(`up to ${b.max}`);
  return parts.length ? `${kind}, ${parts.join(", ")}` : kind;
}

function stringLimits(def) {
  const out = [];
  for (const c of def.checks ?? []) {
    const cd = c._zod.def;
    if (cd.check === "min_length") out.push(cd.minimum > 0 ? `at least ${cd.minimum} character${cd.minimum === 1 ? "" : "s"}` : "");
    else if (cd.check === "max_length") out.push(`at most ${cd.maximum} characters`);
    else if (cd.check === "string_format") out.push(cd.format === "regex" ? "a fixed pattern" : cd.format);
  }
  return out.filter(Boolean);
}

/** A short type name, the allowed values and limits of a plain (unwrapped) schema. */
function describeLeaf(schema) {
  const d = defOf(schema);
  switch (d.type) {
    case "string":
      return { type: "text", limits: stringLimits(d), values: null };
    case "number":
      return { type: describeBounds(numberBounds(d)), limits: [], values: null, numeric: true };
    case "boolean":
      return { type: "true or false", limits: [], values: null };
    case "enum":
      return { type: "one of", limits: [], values: Object.values(d.entries).map(String) };
    case "literal":
      return { type: "one of", limits: [], values: d.values.map(String) };
    case "unknown":
      return { type: "any value", limits: [], values: null };
    case "array": {
      const inner = unwrap(d.element);
      const el = describeLeaf(inner.schema);
      const limits = [];
      for (const c of d.checks ?? []) {
        const cd = c._zod.def;
        if (cd.check === "max_length") limits.push(`at most ${cd.maximum} item${cd.maximum === 1 ? "" : "s"}`);
        if (cd.check === "min_length" && cd.minimum > 0) limits.push(`at least ${cd.minimum} item${cd.minimum === 1 ? "" : "s"}`);
      }
      return { type: `list of ${el.type === "one of" ? "choices" : el.type}`, limits, values: el.values };
    }
    case "union":
      return { type: "one of several forms", limits: [], values: null };
    default:
      return { type: d.type, limits: [], values: null };
  }
}

/**
 * Every key under one section, depth first. Objects are walked; a list of objects adds `[]`, a map of objects adds `<name>`.
 * @param {import("zod").ZodType} root @param {string} prefix @param {string} section @returns {ConfigKey[]}
 */
export function keysOf(root, prefix, section) {
  const out = [];
  const visit = (schema, path) => {
    const u = unwrap(schema);
    const d = defOf(u.schema);
    if (d.type === "object") {
      for (const [k, v] of Object.entries(d.shape)) visit(v, path ? `${path}.${k}` : k);
      return;
    }
    if (d.type === "array") {
      const inner = unwrap(d.element);
      if (defOf(inner.schema).type === "object") {
        out.push(leaf(u, path, section)); // the list itself
        visit(d.element, `${path}[]`);
        return;
      }
    }
    if (d.type === "record") {
      const inner = unwrap(d.valueType);
      if (defOf(inner.schema).type === "object") {
        out.push(leaf(u, path, section));
        visit(d.valueType, `${path}.<name>`);
        return;
      }
    }
    out.push(leaf(u, path, section));
  };
  const leaf = (u, path, sec) => {
    const d = defOf(u.schema);
    let info;
    if (d.type === "record") {
      const inner = unwrap(d.valueType);
      const el = describeLeaf(inner.schema);
      info = { type: defOf(inner.schema).type === "object" ? "map of settings, by name" : `map of name to ${el.type}`, limits: [], values: null };
    } else if (d.type === "array" && defOf(unwrap(d.element).schema).type === "object") {
      info = { type: "list of settings groups", limits: describeLeaf(u.schema).limits, values: null };
    } else info = describeLeaf(u.schema);
    return { path, ...info, default: u.default, hasDefault: u.hasDefault, optional: u.optional, nullable: u.nullable, section: sec };
  };
  visit(root, prefix);
  return out;
}

/** Sections in file order: the core ones, then each module's. */
export function configSections() {
  const sections = [];
  for (const [k, v] of Object.entries(coreSchema.shape)) sections.push({ name: k, owner: "core", schema: v });
  for (const m of BUILTIN_MODULES) if (m.configKey) sections.push({ name: m.configKey, owner: m.name, schema: m.configSchema });
  return sections;
}

/** All keys of the whole configuration. @returns {ConfigKey[]} */
export function allConfigKeys() {
  return configSections().flatMap((s) => keysOf(s.schema, s.name, s.name));
}
