import { validateIr } from './validate.js';
export class IrError extends Error {
    problems;
    constructor(message, problems = []) {
        super(message);
        this.problems = problems;
        this.name = 'IrError';
    }
}
function sortKeys(v) {
    if (Array.isArray(v))
        return v.map(sortKeys);
    if (v && typeof v === 'object') {
        const o = v;
        const out = {};
        for (const k of Object.keys(o).sort())
            if (o[k] !== undefined)
                out[k] = sortKeys(o[k]);
        return out;
    }
    return v;
}
export function serializeIr(program) {
    return JSON.stringify(sortKeys(program));
}
export function deserializeIr(text, hash) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw new IrError('The program text is not valid JSON.');
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes) || !Array.isArray(raw.outputs) || !Array.isArray(raw.inputs)) {
        throw new IrError('The text is not a program.');
    }
    const program = raw;
    const problems = validateIr(program, hash);
    if (problems.length > 0)
        throw new IrError(`The program is not well formed (${problems.length} problems).`, problems);
    return program;
}
