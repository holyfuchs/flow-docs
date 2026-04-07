// Web Worker — owns one WASM instance and processes a slice of combos.
// Receives messages: { id, type: 'init'|'run_path'|'get_totals', ...payload }
// Replies: { id, done: true }  or  { id, totals: ArrayBuffer }

import init, {
    optimizer_init,
    optimizer_run_path,
    optimizer_get_totals,
} from './wasm_pkg/rebalancer_sim.js';

const ready = init({ module_or_path: './wasm_pkg/rebalancer_sim_bg.wasm' });

self.onmessage = async ({ data: { id, type, ...p } }) => {
    await ready;

    if (type === 'init') {
        optimizer_init(new Float64Array(p.combos), p.borrowFee, p.collFee, p.ytFee, p.duration);
        self.postMessage({ id });
    } else if (type === 'run_path') {
        optimizer_run_path(
            new Float64Array(p.coll),
            new Float64Array(p.debt),
            new Float64Array(p.yield_),
        );
        self.postMessage({ id });
    } else if (type === 'get_totals') {
        const totals = optimizer_get_totals();
        self.postMessage({ id, totals: totals.buffer }, [totals.buffer]);
    }
};
