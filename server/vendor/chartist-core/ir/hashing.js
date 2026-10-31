import { mapRefs } from './builder.js';
import { opKey } from './digest.js';
/** The content digest of every node, in node order. Nodes must refer only to earlier nodes. */
export function nodeDigests(program, hash) {
    const out = [];
    for (const n of program.nodes) {
        const { id: _id, ty: _ty, ...op } = n;
        void _id;
        void _ty;
        const keyed = mapRefs(op, (r) => out[r] ?? `?${r}`);
        out.push(hash.sha256Hex(opKey(keyed)));
    }
    return out;
}
const entries = (o) => Object.keys(o).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join(';');
const opt = (v) => (v === undefined ? '-' : JSON.stringify(v));
export function hashProgram(program, hash) {
    const d = nodeDigests(program, hash);
    const lines = [
        `chartist-ir ${program.irVersion}`,
        `kind ${program.kind.replace(/^bare-/, '')}`,
        `params ${entries(program.params)}`,
        // Options are part of the setting (a host refuses a value outside them); written only when present, so older scripts keep their hash.
        ...program.inputs.map((i) => `input ${JSON.stringify(i.name)} ${i.type} ${JSON.stringify(i.default)} ${opt(i.min)} ${opt(i.max)}${i.options ? ` options ${JSON.stringify(i.options)}` : ''}`),
        ...program.outputs.map((o) => `out ${o.kind} ${d[o.value]} ${o.enabled === undefined ? '-' : d[o.enabled]}${o.leg ? ` leg ${o.leg.right} ${o.leg.side} ${o.leg.strike} ${o.leg.expiry}` : ''}${o.sizePct !== undefined ? ` size ${o.sizePct}` : ''}${o.other !== undefined ? ` to ${d[o.other]}` : ''}`),
    ];
    const irHash = hash.sha256Hex(lines.join('\n'));
    const presentation = [
        irHash,
        `form ${program.kind}`,
        `meta ${entries(program.meta)}`,
        ...program.outputs.map((o) => `look ${opt(o.label)} ${opt(o.style)} ${opt(o.shape)} ${opt(o.where)} ${o.color === undefined ? '-' : d[o.color]}${o.width !== undefined ? ` width ${o.width}` : ''}${o.offset !== undefined ? ` offset ${o.offset}` : ''}`),
    ];
    return { irHash, scriptHash: hash.sha256Hex(presentation.join('\n')) };
}
