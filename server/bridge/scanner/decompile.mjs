/**
 * Advanced text back to the builder (POST /v1/scanner/compile). Parses a live condition, then reads it as AND / OR
 * groups of comparisons whose sides are builder values (dashboard/scan-builder.js matchOperand over the canonical
 * text from expr.mjs toText). Anything the builder cannot show (arithmetic between values, "not", a group inside a
 * group) gives model: null with the reason, and the scan stays in Advanced mode, still valid.
 */
import { FACT_IDS, compileModel, isBool, matchOperand, opOfSign } from "../dashboard/scan-builder.js";
import { parseExpression, toText } from "./expr.mjs";

const parseLive = (src) => parseExpression(src, { fields: [...FACT_IDS] });

class NotBuilder extends Error {}
const no = (why) => {
  throw new NotBuilder(why);
};

function chain(node, op) {
  return node.t === op ? [...chain(node.l, op), ...chain(node.r, op)] : [node];
}

function operand(node) {
  const text = toText(node);
  const m = matchOperand(text);
  if (!m || m.num !== undefined) no(`"${text}" is not a value the builder lists.`);
  return m;
}

function rule(node) {
  if (node.t === "cross") return { left: operand(node.l), op: node.dir === "above" ? "xa" : "xb", right: operand(node.r) };
  if (node.t !== "cmp") no(`"${toText(node)}" is not a comparison.`);
  const left = operand(node.l);
  if (isBool(left.id)) {
    const v = matchOperand(toText(node.r));
    if (node.op !== "==" || !v || v.num === undefined || (v.num !== 0 && v.num !== 1)) no(`${left.id} is yes or no: write ${left.id} == 1 or ${left.id} == 0.`);
    return { left, op: v.num === 1 ? "yes" : "no" };
  }
  const op = opOfSign(node.op);
  if (!op) no(`"${node.op}" has no plain-word form; use >, >=, < or <=.`);
  const r = node.r;
  const asNum = matchOperand(toText(r));
  if (asNum?.num !== undefined) return { left, op, right: asNum };
  if (r.t === "bin" && r.op === "*" && r.l.t === "num") return { left, op, right: operand(r.r), mult: r.l.v };
  return { left, op, right: operand(r) };
}

/**
 * @param {string} text a live condition
 * @returns {{ model: object|null, reason: string|null, text: string }} text: the builder's own rendering when it
 *   could read it (so the caller can tell whether the round trip is exact)
 */
export function decompile(text) {
  const tree = parseLive(text); // throws VALIDATION_FAILED with a readable message for bad text
  try {
    const top = tree.t === "or" ? "or" : "and";
    const items = chain(tree, top);
    const rules = items.map((n) => {
      if (n.t === "and" || n.t === "or") {
        const inner = chain(n, n.t);
        return { join: n.t, rules: inner.map((x) => (x.t === "and" || x.t === "or" ? no("groups go one level deep in the builder.") : rule(x))) };
      }
      return rule(n);
    });
    const model = { join: top, rules };
    return { model, reason: null, text: compileModel(model).text };
  } catch (err) {
    if (err instanceof NotBuilder) return { model: null, reason: err.message, text };
    throw err;
  }
}
