/* tslint:disable */
/* eslint-disable */

/**
 * Return accumulated totals after all paths have run.
 */
export function optimizer_get_totals(): Float64Array;

/**
 * Initialise a grid-search run. Call once before the first optimizer_run_path.
 * combos layout (6 f64 per entry): ltv_up, ltv_down, ct_up, ct_down, yt_up, yt_down
 */
export function optimizer_init(combos: Float64Array, borrow_fee: number, coll_swap_fee: number, yield_swap_fee: number, duration_years: number): void;

/**
 * Run one price path. Accumulates scores into the internal totals buffer.
 */
export function optimizer_run_path(coll: Float64Array, debt: Float64Array, yield_: Float64Array): void;

/**
 * Full simulation for the chart. Returns a flat Vec:
 * [collateral_values..., debt_values..., yield_values..., position_values...]
 */
export function run_simulation(coll: Float64Array, debt: Float64Array, yield_: Float64Array, ltv_up: number, ltv_down: number, coll_thresh_up: number, coll_thresh_down: number, yield_thresh_up: number, yield_thresh_down: number, borrow_fee: number, coll_swap_fee: number, yield_swap_fee: number, duration_years: number, coll_rebalance_enabled: boolean, yield_rebalance_enabled: boolean): Float64Array;

/**
 * Run a single combo — used for the default-settings score.
 */
export function sim_single(coll: Float64Array, debt: Float64Array, yield_: Float64Array, ltv_up: number, ltv_down: number, coll_thresh_up: number, coll_thresh_down: number, yield_thresh_up: number, yield_thresh_down: number, borrow_fee: number, coll_swap_fee: number, yield_swap_fee: number, duration_years: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly optimizer_get_totals: () => [number, number];
    readonly optimizer_init: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly optimizer_run_path: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly run_simulation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => [number, number];
    readonly sim_single: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
