/**
 * Run the full rebalancer simulation over pre-generated price arrays.
 *
 * @param {number[]} collateralPrices  - collateral token price at each timestep
 * @param {number[]} debtTokenPrices   - debt token price at each timestep
 * @param {number[]} yieldTokenPrices  - Yield Token share price at each timestep
 * @param {object}   settings
 * @param {number}   settings.durationYears
 * @param {number}   settings.ltvUp                          - e.g. 0.80  target LTV when rebalancing up
 * @param {number}   settings.ltvDown                        - e.g. 0.80  target LTV when rebalancing down
 * @param {number}   settings.collateralThresholdUp          - e.g. 0.05
 * @param {number}   settings.collateralThresholdDown        - e.g. 0.05
 * @param {number}   settings.yieldTokenThresholdUp          - e.g. 0.05
 * @param {number}   settings.yieldTokenThresholdDown        - e.g. 0.05
 * @param {number}   settings.collateralSwapFee              - e.g. 0.01
 * @param {number}   settings.yieldTokenSwapFee              - e.g. 0.01
 * @param {number}   settings.borrowFeeAnnual                - e.g. 0.05 (5 %/yr)
 * @param {boolean}  settings.collateralRebalanceEnabled
 * @param {boolean}  settings.yieldTokenRebalanceEnabled
 *
 * @returns {{
 *   collateralValues:         number[],   // collateral position USD value at each step
 *   debtTokenValues:          number[],   // debt loan USD value at each step
 *   yieldTokenValues:         number[],   // Yield Token shares USD value at each step
 *   positionValues:           number[],   // net position USD value at each step
 *   collateralRebalanceTimes: number[],   // time in years when collateral rebalance fired
 *   yieldTokenRebalanceTimes: number[],   // time in years when Yield Token rebalance fired
 * }}
 */
export function runSimulation(collateralPrices, debtTokenPrices, yieldTokenPrices, settings) {
    const {
        durationYears,
        ltvUp,
        ltvDown,
        collateralThresholdUp,
        collateralThresholdDown,
        yieldTokenThresholdUp,
        yieldTokenThresholdDown,
        collateralSwapFee,
        yieldTokenSwapFee,
        borrowFeeAnnual,
        collateralRebalanceEnabled,
        yieldTokenRebalanceEnabled,
        collateralIntervalMinutes  = 0,
        yieldTokenIntervalMinutes  = 0,
    } = settings;

    const n       = collateralPrices.length;
    const dtYears = durationYears / (n - 1);

    let collateralAmount = 100;
    let debtLoan         = collateralAmount * collateralPrices[0] * ltvUp;  // initial loan at ltvUp
    let sharesCount      = debtLoan * (1 - yieldTokenSwapFee) / yieldTokenPrices[0];  // Yield Token share units

    const collateralValues         = new Array(n);
    const debtTokenValues          = new Array(n);
    const yieldTokenValues         = new Array(n);
    const positionValues           = new Array(n);
    const collateralRebalanceTimes = [];
    const yieldTokenRebalanceTimes = [];

    const collateralIntervalYears  = collateralIntervalMinutes  / (365.25 * 24 * 60);
    const yieldTokenIntervalYears  = yieldTokenIntervalMinutes  / (365.25 * 24 * 60);
    let lastCollateralRebalance    = -Infinity;
    let lastYieldTokenRebalance    = -Infinity;

    for (let i = 0; i < n; i++) {
        const t   = i * dtYears;
        const cp  = collateralPrices[i];
        const dtp = debtTokenPrices[i];
        const ytp = yieldTokenPrices[i];

        // Accrue borrow fee on the loan
        if (i > 0) debtLoan *= (1 + borrowFeeAnnual * dtYears);

        const cvUsd = collateralAmount * cp;

        // Collateral rebalance: bring loan back to cv * ltv
        if (collateralRebalanceEnabled && t - lastCollateralRebalance >= collateralIntervalYears) {
            // Use ltvUp when increasing loan (collateral up), ltvDown when decreasing (collateral down)
            const targetUp   = cvUsd * ltvUp   / dtp;
            const targetDown = cvUsd * ltvDown  / dtp;
            const devUp      = (targetUp   - debtLoan) / debtLoan;
            const devDown    = (targetDown - debtLoan) / debtLoan;
            if (devUp >= collateralThresholdUp || devDown <= -collateralThresholdDown) {
                const target    = devUp >= collateralThresholdUp ? targetUp : targetDown;
                const debtDiff  = target - debtLoan;
                debtLoan    = target;
                sharesCount += debtDiff > 0
                    ? debtDiff * (1 - yieldTokenSwapFee) / ytp          // buying shares: pay fee
                    : debtDiff / ((1 - yieldTokenSwapFee) * ytp);       // selling shares: pay fee
                collateralRebalanceTimes.push(t);
                lastCollateralRebalance = t;
            }
        }

        // Yield Token rebalance: rebalance shares to match loan
        if (yieldTokenRebalanceEnabled && t - lastYieldTokenRebalance >= yieldTokenIntervalYears) {
            const yieldTokenHeld = sharesCount * ytp;
            const dev            = (yieldTokenHeld - debtLoan) / debtLoan;
            if (dev >= yieldTokenThresholdUp) {
                // Excess shares → sell into collateral
                const excess      = yieldTokenHeld - debtLoan;
                sharesCount       = debtLoan / ytp;
                collateralAmount += excess * dtp * (1 - collateralSwapFee) / cp;
                yieldTokenRebalanceTimes.push(t);
                lastYieldTokenRebalance = t;
            } else if (dev <= -yieldTokenThresholdDown) {
                // Shares deficit → sell collateral to buy more shares
                const shortfall   = debtLoan - yieldTokenHeld;
                sharesCount       = debtLoan / ytp;
                collateralAmount -= shortfall * dtp * (1 + collateralSwapFee) / cp;
                yieldTokenRebalanceTimes.push(t);
                lastYieldTokenRebalance = t;
            }
        }

        collateralValues[i] = collateralAmount * cp;
        debtTokenValues[i]  = debtLoan * dtp;
        yieldTokenValues[i] = sharesCount * ytp * dtp;
        positionValues[i]   = collateralValues[i] - debtTokenValues[i] + yieldTokenValues[i];
    }

    return {
        collateralValues,
        debtTokenValues,
        yieldTokenValues,
        positionValues,
        collateralRebalanceTimes,
        yieldTokenRebalanceTimes,
    };
}
