/**
 * A small JSON Schema validator for the subset docs/openapi.yaml uses (OpenAPI 3.1, JSON Schema 2020-12 semantics),
 * with no dependency. It exists so a test can check real answers against the documented schemas.
 *
 * Supported: $ref (local "#/..."), type (a name or a list, "integer" included), enum, const, properties, required,
 * additionalProperties (false or a schema), items, prefixItems is not used, allOf, anyOf, oneOf, not, minimum, maximum,
 * exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern, format (date, date-time, uri, email: loose checks),
 * minItems, maxItems, uniqueItems, minProperties, maxProperties.
 * Ignored on purpose: readOnly, writeOnly, description, example(s), default, deprecated, x-* keys, discriminator.
 *
 * Semantics follow the standard, so the classic trap is caught: `additionalProperties: false` only knows the
 * `properties` next to it, not those of an `allOf` sibling.
 *
 *   const errors = validate(spec, schema, value);   // [] when valid; else [{ path: "data.items[2].id", message }]
 */

const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
};

const FORMATS = {
  "date-time": (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/.test(s) && !Number.isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  uri: (s) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) || s.startsWith("/"),
  email: (s) => /^[^@\s]+@[^@\s]+$/.test(s),
};

function resolveRef(spec, ref) {
  if (!ref.startsWith("#/")) throw new Error(`only local references are supported: ${ref}`);
  let cur = spec;
  for (const part of ref.slice(2).split("/")) cur = cur?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (cur === undefined) throw new Error(`unresolved reference ${ref}`);
  return cur;
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const join = (path, key) => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : String(key));
const describe_ = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * @param {any} spec     the whole OpenAPI document (for $ref)
 * @param {any} schema   a schema node
 * @param {any} value    the value to check
 * @param {{ path?: string, maxErrors?: number }} [opts]
 * @returns {Array<{ path: string, message: string }>}
 */
export function validate(spec, schema, value, opts = {}) {
  const errors = [];
  const max = opts.maxErrors ?? 20;
  check(spec, schema, value, opts.path ?? "", errors, max, 0);
  return errors;
}

function check(spec, schema, value, path, errors, max, depth) {
  if (errors.length >= max) return;
  if (depth > 60) {
    errors.push({ path, message: "schema nesting too deep" });
    return;
  }
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    errors.push({ path, message: "no value is allowed here" });
    return;
  }
  const bad = (message) => {
    if (errors.length < max) errors.push({ path: path || "(root)", message });
  };
  if (typeof schema.$ref === "string") {
    check(spec, resolveRef(spec, schema.$ref), value, path, errors, max, depth + 1);
    return; // sibling keywords of a $ref are documentation in this spec
  }

  if (schema.allOf) for (const s of schema.allOf) check(spec, s, value, path, errors, max, depth + 1);
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(spec, s, value, { path, maxErrors: 1 }).length === 0);
    if (!ok) bad(`does not match any of the ${schema.anyOf.length} allowed shapes (got ${describe_(value)})`);
  }
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s) => validate(spec, s, value, { path, maxErrors: 1 }).length === 0).length;
    if (hits !== 1) bad(hits === 0 ? `does not match any of the ${schema.oneOf.length} allowed shapes (got ${describe_(value)})` : `matches ${hits} of the ${schema.oneOf.length} shapes, expected exactly one`);
  }
  if (schema.not && validate(spec, schema.not, value, { path, maxErrors: 1 }).length === 0) bad("matches a shape that is not allowed");

  if (schema.const !== undefined && !deepEqual(schema.const, value)) bad(`must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) bad(`must be one of ${JSON.stringify(schema.enum)} (got ${JSON.stringify(value)})`);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => TYPE_CHECKS[t]?.(value))) {
      bad(`must be ${types.join(" or ")} (got ${describe_(value)})`);
      return; // the keywords below assume the type
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) bad(`is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) bad(`is longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) bad(`does not match ${schema.pattern}`);
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](value)) bad(`is not a valid ${schema.format}: ${JSON.stringify(value).slice(0, 60)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) bad(`is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) bad(`is above ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) bad(`must be above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) bad(`must be below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) bad(`has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) bad(`has more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) bad("has repeated items");
    if (schema.items !== undefined) value.forEach((item, i) => check(spec, schema.items, item, join(path, i), errors, max, depth + 1));
  }
  if (TYPE_CHECKS.object(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) bad(`has fewer than ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) bad(`has more than ${schema.maxProperties} properties`);
    for (const r of schema.required ?? []) if (!Object.hasOwn(value, r)) bad(`is missing the required field "${r}"`);
    const props = schema.properties ?? {};
    for (const [k, sub] of Object.entries(props)) if (Object.hasOwn(value, k)) check(spec, sub, value[k], join(path, k), errors, max, depth + 1);
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const k of keys) {
        if (Object.hasOwn(props, k)) continue;
        if (schema.additionalProperties === false) bad(`has the field "${k}", which this schema does not list`);
        else check(spec, schema.additionalProperties, value[k], join(path, k), errors, max, depth + 1);
      }
    }
  }
}
