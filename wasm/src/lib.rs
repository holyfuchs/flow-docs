use std::cell::RefCell;
use wasm_bindgen::prelude::*;

// ── Simulation parameters ─────────────────────────────────────────────────────

struct SimParams {
    ltv_up:           f64,
    ltv_down:         f64,
    coll_thresh_up:   f64,
    coll_thresh_down: f64,
    yield_thresh_up:  f64,
    yield_thresh_down: f64,
    borrow_fee:       f64,   // annual rate, e.g. 0.05
    coll_swap_fee:    f64,
    yield_swap_fee:   f64,
    duration_years:   f64,
}

// ── Optimizer session state ───────────────────────────────────────────────────
// On stable wasm32, thread_local! compiles to a plain global. Safe to use here
// since all exported functions are called serially from the JS main thread.

struct OptimizerState {
    combos: Vec<f64>,   // flat: [ltv_up, ltv_down, ct_up, ct_down, yt_up, yt_down, ...]
    totals: Vec<f64>,   // accumulated score per combo across paths
    borrow_fee:      f64,
    coll_swap_fee:   f64,
    yield_swap_fee:  f64,
    duration_years:  f64,
}

thread_local! {
    static OPTIMIZER: RefCell<Option<OptimizerState>> = RefCell::new(None);
}

// ── Core inner loop ───────────────────────────────────────────────────────────
//
// Returns the unwind score: collateral tokens remaining after selling all
// yield-token shares, repaying the loan, and settling the remainder via DEX.

fn simulate(
    coll_prices:  &[f64],
    debt_prices:  &[f64],
    yield_prices: &[f64],
    p: &SimParams,
) -> f64 {
    let n  = coll_prices.len();
    let dt = p.duration_years / (n - 1) as f64;

    let mut collateral = 100.0_f64;
    let mut loan       = collateral * coll_prices[0] * ((p.ltv_up + p.ltv_down) / 2.0);
    let mut shares     = loan * (1.0 - p.yield_swap_fee) / yield_prices[0];

    for i in 0..n {
        let coll_price  = coll_prices[i];
        let debt_price  = debt_prices[i];
        let yield_price = yield_prices[i];

        if i > 0 {
            loan *= 1.0 + p.borrow_fee * dt;
        }

        // Collateral rebalance: bring loan back to target LTV
        let coll_value   = collateral * coll_price;
        let target_up    = coll_value * p.ltv_up   / debt_price;
        let target_down  = coll_value * p.ltv_down / debt_price;
        let deviation_up   = (target_up   - loan) / loan;
        let deviation_down = (target_down - loan) / loan;
        if deviation_up >= p.coll_thresh_up || deviation_down <= -p.coll_thresh_down {
            let target = if deviation_up >= p.coll_thresh_up { target_up } else { target_down };
            let diff   = target - loan;
            loan = target;
            if diff > 0.0 {
                shares += diff * (1.0 - p.yield_swap_fee) / yield_price;
            } else {
                shares += diff / ((1.0 - p.yield_swap_fee) * yield_price);
            }
        }

        // Yield-token rebalance: keep shares matched to loan value
        let yield_held = shares * yield_price;
        let deviation  = (yield_held - loan) / loan;
        if deviation >= p.yield_thresh_up {
            collateral += (yield_held - loan) * debt_price * (1.0 - p.coll_swap_fee) / coll_price;
            shares      = loan / yield_price;
        } else if deviation <= -p.yield_thresh_down {
            collateral -= (loan - yield_held) * debt_price * (1.0 + p.coll_swap_fee) / coll_price;
            shares      = loan / yield_price;
        }
    }

    // Unwind: sell yield tokens → repay loan → convert surplus/deficit to collateral
    let coll_price  = coll_prices[n - 1];
    let debt_price  = debt_prices[n - 1];
    let yield_price = yield_prices[n - 1];
    let repaid  = shares * yield_price * (1.0 - p.yield_swap_fee);
    let surplus = repaid - loan;
    if surplus >= 0.0 {
        collateral + surplus * debt_price * (1.0 - p.coll_swap_fee) / coll_price
    } else {
        collateral + surplus * debt_price * (1.0 + p.coll_swap_fee) / coll_price
    }
}

// ── WASM exports ──────────────────────────────────────────────────────────────

/// Initialise a grid-search run. Call once before the first optimizer_run_path.
/// combos layout (6 f64 per entry): ltv_up, ltv_down, ct_up, ct_down, yt_up, yt_down
#[wasm_bindgen]
pub fn optimizer_init(
    combos:         &[f64],
    borrow_fee:     f64,
    coll_swap_fee:  f64,
    yield_swap_fee: f64,
    duration_years: f64,
) {
    let n = combos.len() / 6;
    OPTIMIZER.with(|opt| {
        *opt.borrow_mut() = Some(OptimizerState {
            combos:        combos.to_vec(),
            totals:        vec![0.0; n],
            borrow_fee,
            coll_swap_fee,
            yield_swap_fee,
            duration_years,
        });
    });
}

/// Run one price path. Accumulates scores into the internal totals buffer.
#[wasm_bindgen]
pub fn optimizer_run_path(coll: &[f64], debt: &[f64], yield_: &[f64]) {
    OPTIMIZER.with(|opt| {
        let mut guard = opt.borrow_mut();
        let state = guard.as_mut().expect("optimizer_init not called");
        let params_base = SimParams {
            ltv_up: 0.0, ltv_down: 0.0,
            coll_thresh_up: 0.0, coll_thresh_down: 0.0,
            yield_thresh_up: 0.0, yield_thresh_down: 0.0,
            borrow_fee:      state.borrow_fee,
            coll_swap_fee:   state.coll_swap_fee,
            yield_swap_fee:  state.yield_swap_fee,
            duration_years:  state.duration_years,
        };
        let n_combos = state.combos.len() / 6;
        for i in 0..n_combos {
            let b = i * 6;
            let p = SimParams {
                ltv_up:           state.combos[b],
                ltv_down:         state.combos[b + 1],
                coll_thresh_up:   state.combos[b + 2],
                coll_thresh_down: state.combos[b + 3],
                yield_thresh_up:  state.combos[b + 4],
                yield_thresh_down: state.combos[b + 5],
                ..params_base
            };
            state.totals[i] += simulate(coll, debt, yield_, &p);
        }
    });
}

/// Return accumulated totals after all paths have run.
#[wasm_bindgen]
pub fn optimizer_get_totals() -> Vec<f64> {
    OPTIMIZER.with(|opt| {
        opt.borrow()
            .as_ref()
            .expect("optimizer_init not called")
            .totals
            .clone()
    })
}

/// Run a single combo — used for the default-settings score.
#[wasm_bindgen]
pub fn sim_single(
    coll: &[f64], debt: &[f64], yield_: &[f64],
    ltv_up: f64, ltv_down: f64,
    coll_thresh_up: f64, coll_thresh_down: f64,
    yield_thresh_up: f64, yield_thresh_down: f64,
    borrow_fee: f64, coll_swap_fee: f64, yield_swap_fee: f64,
    duration_years: f64,
) -> f64 {
    simulate(coll, debt, yield_, &SimParams {
        ltv_up, ltv_down,
        coll_thresh_up, coll_thresh_down,
        yield_thresh_up, yield_thresh_down,
        borrow_fee, coll_swap_fee, yield_swap_fee,
        duration_years,
    })
}

/// Full simulation for the chart. Returns a flat Vec:
/// [collateral_values..., debt_values..., yield_values..., position_values...]
#[wasm_bindgen]
pub fn run_simulation(
    coll: &[f64], debt: &[f64], yield_: &[f64],
    ltv_up: f64, ltv_down: f64,
    coll_thresh_up: f64, coll_thresh_down: f64,
    yield_thresh_up: f64, yield_thresh_down: f64,
    borrow_fee: f64, coll_swap_fee: f64, yield_swap_fee: f64,
    duration_years: f64,
    coll_rebalance_enabled: bool,
    yield_rebalance_enabled: bool,
) -> Vec<f64> {
    let n  = coll.len();
    let dt = duration_years / (n - 1) as f64;

    let mut collateral = 100.0_f64;
    let mut loan       = collateral * coll[0] * ((ltv_up + ltv_down) / 2.0);
    let mut shares     = loan * (1.0 - yield_swap_fee) / yield_[0];
    let mut out        = vec![0.0_f64; n * 6];

    for i in 0..n {
        let coll_price  = coll[i];
        let debt_price  = debt[i];
        let yield_price = yield_[i];

        if i > 0 {
            loan *= 1.0 + borrow_fee * dt;
        }

        if coll_rebalance_enabled {
            let coll_value   = collateral * coll_price;
            let target_up    = coll_value * ltv_up   / debt_price;
            let target_down  = coll_value * ltv_down / debt_price;
            let deviation_up   = (target_up   - loan) / loan;
            let deviation_down = (target_down - loan) / loan;
            if deviation_up >= coll_thresh_up || deviation_down <= -coll_thresh_down {
                let target = if deviation_up >= coll_thresh_up { target_up } else { target_down };
                let diff   = target - loan;
                loan = target;
                if diff > 0.0 {
                    shares += diff * (1.0 - yield_swap_fee) / yield_price;
                } else {
                    shares += diff / ((1.0 - yield_swap_fee) * yield_price);
                }
                out[4 * n + i] = 1.0;
            }
        }

        if yield_rebalance_enabled {
            let yield_held = shares * yield_price;
            let deviation  = (yield_held - loan) / loan;
            if deviation >= yield_thresh_up {
                collateral += (yield_held - loan) * debt_price * (1.0 - coll_swap_fee) / coll_price;
                shares      = loan / yield_price;
                out[5 * n + i] = 1.0;
            } else if deviation <= -yield_thresh_down {
                collateral -= (loan - yield_held) * debt_price * (1.0 + coll_swap_fee) / coll_price;
                shares      = loan / yield_price;
                out[5 * n + i] = 1.0;
            }
        }

        let coll_val = collateral * coll_price;
        let debt_val = loan * debt_price;
        let yt_val   = shares * yield_price * debt_price;
        out[i]         = coll_val;
        out[n + i]     = debt_val;
        out[2 * n + i] = yt_val;
        out[3 * n + i] = coll_val - debt_val + yt_val;
    }

    out
}
