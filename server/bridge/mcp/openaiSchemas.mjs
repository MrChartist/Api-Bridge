/**
 * The MCP tool registry as strict OpenAI function schemas. Same tools, same order, same input rules,
 * for assistants and scripts that use OpenAI-style function calling instead of MCP. The Bridge does not call OpenAI;
 * this only produces the definitions (the caller runs the tool through POST /mcp or the REST API).
 *
 * Strict mode rules applied and checked (https://platform.openai.com/docs/guides/structured-outputs, needs
 * verification when OpenAI changes the supported subset):
 *  - every object has `additionalProperties: false` and lists ALL its properties in `required`
 *    (optional values are expressed as `null`-able types, which the registry's input schemas already do);
 *  - only supported keywords are kept (type, properties, required, additionalProperties, items, enum, const, anyOf,
 *    description, pattern, format, minimum, maximum, minItems, maxItems, minLength, maxLength);
 *  - the root is an object; names match ^[a-zA-Z0-9_-]{1,64}$.
 */
import { BridgeError } from "../core/errors.mjs";
import { mcpConfig } from "./config.mjs";
import { TOOL_DEFS, jsonSchemaOf, toolEnv } from "./tools.mjs";

const KEEP = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "description", "pattern", "format", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]);
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** JavaScript's safe-integer bounds that zod adds to every int; they say nothing and only clutter the schema. */
const SAFE_INT = Number.MAX_SAFE_INTEGER;

/**
 * Reduce a JSON Schema to the strict subset; throws if it cannot be made strict.
 * @param {any} s
 * @param {string} path
 */
export function toStrictSchema(s, path = "$") {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`${path}: schema must be an object`);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k)) continue;
    if ((k === "maximum" && v === SAFE_INT) || (k === "minimum" && v === -SAFE_INT)) continue;
    out[k] = v;
  }
  if (out.anyOf) out.anyOf = out.anyOf.map((x, i) => toStrictSchema(x, `${path}.anyOf[${i}]`));
  if (out.items) out.items = toStrictSchema(out.items, `${path}.items`);
  const isObject = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object"));
  if (isObject) {
    const props = out.properties ?? {};
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toStrictSchema(v, `${path}.${k}`)]));
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (!out.type && !out.anyOf && !out.enum && out.const === undefined) throw new Error(`${path}: strict schemas need a type`);
  return out;
}

/**
 * Build OpenAI function definitions from the registry.
 * @param {{ config?: any, scopes?: string[], accounts?: string[] | "*", toolsets?: string[], format?: "responses"|"chat" }} [opts]
 *   config: the Bridge config (mcp section decides toolsets and order accounts); scopes/accounts: the key the
 *   functions are for (default: a read-only key for every account, i.e. no order tools); toolsets: override.
 *   format "responses" (default): { type: "function", name, description, parameters, strict: true }.
 *   format "chat": { type: "function", function: { name, description, parameters, strict: true } }.
 * @returns {object[]}
 */
export function toOpenAITools({ config, scopes = ["read"], accounts = "*", toolsets, format = "responses" } = {}) {
  const base = mcpConfig(config);
  const cfg = toolsets ? { ...base, toolsets: base.toolsets.filter((t) => toolsets.includes(t)) } : base;
  const granted = new Set(scopes.flatMap((s) => (s === "live" ? ["live", "paper", "read"] : s === "paper" ? ["paper", "read"] : s === "admin" ? ["admin", "read"] : [s])));
  const pseudoCtx = {
    scopes: granted,
    requireAccountAccess(id) {
      if (accounts !== "*" && !accounts.includes(id)) throw new BridgeError("ACCOUNT_FORBIDDEN");
    },
  };
  if (!granted.has("read")) return [];
  const env = toolEnv(cfg, pseudoCtx);
  const out = [];
  for (const def of TOOL_DEFS) {
    if (!cfg.toolsets.includes(def.toolset) || (def.available && !def.available(env, pseudoCtx))) continue;
    if (!NAME_RE.test(def.name)) throw new Error(`Tool name ${def.name} is not valid for OpenAI`);
    const parameters = toStrictSchema(jsonSchemaOf(def.input(env)), def.name);
    const description = `${def.description}${def.annotations.readOnlyHint ? "" : " (Changes state.)"}`.slice(0, 1024);
    out.push(format === "chat" ? { type: "function", function: { name: def.name, description, parameters, strict: true } } : { type: "function", name: def.name, description, parameters, strict: true });
  }
  return out;
}
