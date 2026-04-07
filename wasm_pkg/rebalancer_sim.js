/* @ts-self-types="./rebalancer_sim.d.ts" */

/**
 * Return accumulated totals after all paths have run.
 * @returns {Float64Array}
 */
export function optimizer_get_totals() {
    const ret = wasm.optimizer_get_totals();
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Initialise a grid-search run. Call once before the first optimizer_run_path.
 * combos layout (6 f64 per entry): ltv_up, ltv_down, ct_up, ct_down, yt_up, yt_down
 * @param {Float64Array} combos
 * @param {number} borrow_fee
 * @param {number} coll_swap_fee
 * @param {number} yield_swap_fee
 * @param {number} duration_years
 */
export function optimizer_init(combos, borrow_fee, coll_swap_fee, yield_swap_fee, duration_years) {
    const ptr0 = passArrayF64ToWasm0(combos, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.optimizer_init(ptr0, len0, borrow_fee, coll_swap_fee, yield_swap_fee, duration_years);
}

/**
 * Run one price path. Accumulates scores into the internal totals buffer.
 * @param {Float64Array} coll
 * @param {Float64Array} debt
 * @param {Float64Array} yield_
 */
export function optimizer_run_path(coll, debt, yield_) {
    const ptr0 = passArrayF64ToWasm0(coll, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(debt, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(yield_, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    wasm.optimizer_run_path(ptr0, len0, ptr1, len1, ptr2, len2);
}

/**
 * Full simulation for the chart. Returns a flat Vec:
 * [collateral_values..., debt_values..., yield_values..., position_values...]
 * @param {Float64Array} coll
 * @param {Float64Array} debt
 * @param {Float64Array} yield_
 * @param {number} ltv_up
 * @param {number} ltv_down
 * @param {number} coll_thresh_up
 * @param {number} coll_thresh_down
 * @param {number} yield_thresh_up
 * @param {number} yield_thresh_down
 * @param {number} borrow_fee
 * @param {number} coll_swap_fee
 * @param {number} yield_swap_fee
 * @param {number} duration_years
 * @param {boolean} coll_rebalance_enabled
 * @param {boolean} yield_rebalance_enabled
 * @returns {Float64Array}
 */
export function run_simulation(coll, debt, yield_, ltv_up, ltv_down, coll_thresh_up, coll_thresh_down, yield_thresh_up, yield_thresh_down, borrow_fee, coll_swap_fee, yield_swap_fee, duration_years, coll_rebalance_enabled, yield_rebalance_enabled) {
    const ptr0 = passArrayF64ToWasm0(coll, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(debt, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(yield_, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.run_simulation(ptr0, len0, ptr1, len1, ptr2, len2, ltv_up, ltv_down, coll_thresh_up, coll_thresh_down, yield_thresh_up, yield_thresh_down, borrow_fee, coll_swap_fee, yield_swap_fee, duration_years, coll_rebalance_enabled, yield_rebalance_enabled);
    var v4 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v4;
}

/**
 * Run a single combo — used for the default-settings score.
 * @param {Float64Array} coll
 * @param {Float64Array} debt
 * @param {Float64Array} yield_
 * @param {number} ltv_up
 * @param {number} ltv_down
 * @param {number} coll_thresh_up
 * @param {number} coll_thresh_down
 * @param {number} yield_thresh_up
 * @param {number} yield_thresh_down
 * @param {number} borrow_fee
 * @param {number} coll_swap_fee
 * @param {number} yield_swap_fee
 * @param {number} duration_years
 * @returns {number}
 */
export function sim_single(coll, debt, yield_, ltv_up, ltv_down, coll_thresh_up, coll_thresh_down, yield_thresh_up, yield_thresh_down, borrow_fee, coll_swap_fee, yield_swap_fee, duration_years) {
    const ptr0 = passArrayF64ToWasm0(coll, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(debt, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(yield_, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.sim_single(ptr0, len0, ptr1, len1, ptr2, len2, ltv_up, ltv_down, coll_thresh_up, coll_thresh_down, yield_thresh_up, yield_thresh_down, borrow_fee, coll_swap_fee, yield_swap_fee, duration_years);
    return ret;
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./rebalancer_sim_bg.js": import0,
    };
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat64ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('rebalancer_sim_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
