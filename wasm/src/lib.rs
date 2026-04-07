use wasm_bindgen::prelude::*;

// ── Core simulation step (mirrors simOnArrays in index.js) ────────────────────
//
// Returns the final "unwind score" — collateral tokens remaining after
// selling all yield tokens, repaying the debt, and converting any surplus
// or deficit through the DEX.
fn sim_on_arrays(
    coll:   &[f64],
    debt:   &[f64],
    yield_: &[f64],
    l_u:    f64,   // LTV target when rebalancing up
    l_d:    f64,   // LTV target when rebalancing down
    ct_u:   f64,   // collateral threshold up
    ct_d:   f64,   // collateral threshold down
    yt_u:   f64,   // yield-token threshold up
    yt_d:   f64,   // yield-token threshold down
    borrow_fee:    f64,   // annual borrow fee (e.g. 0.05)
    coll_swap_fee: f64,   // collateral swap fee (e.g. 0.01)
    yt_swap_fee:   f64,   // yield-token swap fee (e.g. 0.01)
    duration_years: f64,
) -> f64 {
    let n      = coll.len();
    let dt     = duration_years / (n - 1) as f64;

    let mut ca        = 100.0_f64;
    let mut debt_loan = ca * coll[0] * ((l_u + l_d) / 2.0);
    let mut shares    = debt_loan * (1.0 - yt_swap_fee) / yield_[0];

    for i in 0..n {
        let cp  = coll[i];
        let dtp = debt[i];
        let ytp = yield_[i];

        if i > 0 {
            debt_loan *= 1.0 + borrow_fee * dt;
        }

        // Collateral rebalance
        let cv  = ca * cp;
        let t_u = cv * l_u / dtp;
        let t_d = cv * l_d / dtp;
        let d_u = (t_u - debt_loan) / debt_loan;
        let d_d = (t_d - debt_loan) / debt_loan;
        if d_u >= ct_u || d_d <= -ct_d {
            let target = if d_u >= ct_u { t_u } else { t_d };
            let diff   = target - debt_loan;
            debt_loan  = target;
            if diff > 0.0 {
                shares += diff * (1.0 - yt_swap_fee) / ytp;
            } else {
                shares += diff / ((1.0 - yt_swap_fee) * ytp);
            }
        }

        // Yield-token rebalance
        let held = shares * ytp;
        let dev  = (held - debt_loan) / debt_loan;
        if dev >= yt_u {
            ca     += (held - debt_loan) * dtp * (1.0 - coll_swap_fee) / cp;
            shares  = debt_loan / ytp;
        } else if dev <= -yt_d {
            ca     -= (debt_loan - held) * dtp * (1.0 + coll_swap_fee) / cp;
            shares  = debt_loan / ytp;
        }
    }

    // Unwind: sell yield tokens → repay debt → convert remainder
    let last           = n - 1;
    let cp             = coll[last];
    let dtp            = debt[last];
    let ytp            = yield_[last];
    let debt_from_yt   = shares * ytp * (1.0 - yt_swap_fee);
    let net_debt       = debt_from_yt - debt_loan;
    if net_debt >= 0.0 {
        ca + net_debt * dtp * (1.0 - coll_swap_fee) / cp
    } else {
        ca + net_debt * dtp * (1.0 + coll_swap_fee) / cp
    }
}

// ── WASM exports ──────────────────────────────────────────────────────────────

/// Run the optimizer over all combos for a single price path.
/// Accumulates into `totals` (must be pre-allocated, length = combos.len() / 6).
/// combos layout: [lU, lD, ctU, ctD, ytU, ytD, lU, lD, ...]
#[wasm_bindgen]
pub fn optimize_path(
    coll:           &[f64],
    debt:           &[f64],
    yield_:         &[f64],
    combos:         &[f64],  // flat: 6 f64 per combo
    totals:         &mut [f64],
    borrow_fee:     f64,
    coll_swap_fee:  f64,
    yt_swap_fee:    f64,
    duration_years: f64,
) {
    let n_combos = combos.len() / 6;
    for i in 0..n_combos {
        let base = i * 6;
        totals[i] += sim_on_arrays(
            coll, debt, yield_,
            combos[base],     // lU
            combos[base + 1], // lD
            combos[base + 2], // ctU
            combos[base + 3], // ctD
            combos[base + 4], // ytU
            combos[base + 5], // ytD
            borrow_fee,
            coll_swap_fee,
            yt_swap_fee,
            duration_years,
        );
    }
}

/// Run a single combo (used for defaultScore computation).
#[wasm_bindgen]
pub fn sim_single(
    coll:           &[f64],
    debt:           &[f64],
    yield_:         &[f64],
    l_u:            f64,
    l_d:            f64,
    ct_u:           f64,
    ct_d:           f64,
    yt_u:           f64,
    yt_d:           f64,
    borrow_fee:     f64,
    coll_swap_fee:  f64,
    yt_swap_fee:    f64,
    duration_years: f64,
) -> f64 {
    sim_on_arrays(
        coll, debt, yield_,
        l_u, l_d, ct_u, ct_d, yt_u, yt_d,
        borrow_fee, coll_swap_fee, yt_swap_fee, duration_years,
    )
}

/// Full simulation — returns flat array:
/// [collateralValues..., debtTokenValues..., yieldTokenValues..., positionValues...]
/// Each series has `n` points (n = coll.len()).
#[wasm_bindgen]
pub fn run_simulation(
    coll:                       &[f64],
    debt:                       &[f64],
    yield_:                     &[f64],
    l_u:                        f64,
    l_d:                        f64,
    ct_u:                       f64,
    ct_d:                       f64,
    yt_u:                       f64,
    yt_d:                       f64,
    borrow_fee:                 f64,
    coll_swap_fee:              f64,
    yt_swap_fee:                f64,
    duration_years:             f64,
    coll_rebalance_enabled:     bool,
    yt_rebalance_enabled:       bool,
) -> Vec<f64> {
    let n  = coll.len();
    let dt = duration_years / (n - 1) as f64;

    let mut ca        = 100.0_f64;
    let mut debt_loan = ca * coll[0] * ((l_u + l_d) / 2.0);
    let mut shares    = debt_loan * (1.0 - yt_swap_fee) / yield_[0];

    // output layout: coll_vals | debt_vals | yt_vals | pos_vals
    let mut out = vec![0.0_f64; n * 4];

    for i in 0..n {
        let cp  = coll[i];
        let dtp = debt[i];
        let ytp = yield_[i];

        if i > 0 {
            debt_loan *= 1.0 + borrow_fee * dt;
        }

        if coll_rebalance_enabled {
            let cv  = ca * cp;
            let t_u = cv * l_u / dtp;
            let t_d = cv * l_d / dtp;
            let d_u = (t_u - debt_loan) / debt_loan;
            let d_d = (t_d - debt_loan) / debt_loan;
            if d_u >= ct_u || d_d <= -ct_d {
                let target = if d_u >= ct_u { t_u } else { t_d };
                let diff   = target - debt_loan;
                debt_loan  = target;
                if diff > 0.0 {
                    shares += diff * (1.0 - yt_swap_fee) / ytp;
                } else {
                    shares += diff / ((1.0 - yt_swap_fee) * ytp);
                }
            }
        }

        if yt_rebalance_enabled {
            let held = shares * ytp;
            let dev  = (held - debt_loan) / debt_loan;
            if dev >= yt_u {
                ca     += (held - debt_loan) * dtp * (1.0 - coll_swap_fee) / cp;
                shares  = debt_loan / ytp;
            } else if dev <= -yt_d {
                ca     -= (debt_loan - held) * dtp * (1.0 + coll_swap_fee) / cp;
                shares  = debt_loan / ytp;
            }
        }

        let coll_val = ca * cp;
        let debt_val = debt_loan * dtp;
        let yt_val   = shares * ytp * dtp;
        out[i]         = coll_val;
        out[n + i]     = debt_val;
        out[2 * n + i] = yt_val;
        out[3 * n + i] = coll_val - debt_val + yt_val;
    }

    out
}
