/**
 * Run the full rebalancer simulation over pre-generated price arrays.
 *
 * @param {number[]} collateralPrices  - collateral token price at each timestep
 * @param {number[]} yieldAssetPrices  - yield asset price at each timestep
 * @param {number[]} sharePrices       - ERC4626 share price at each timestep
 * @param {object}   settings
 * @param {number}   settings.durationYears
 * @param {number}   settings.ltv                        - e.g. 0.90
 * @param {number}   settings.collateralThresholdUp      - e.g. 0.05
 * @param {number}   settings.collateralThresholdDown    - e.g. 0.05
 * @param {number}   settings.ercThresholdUp             - e.g. 0.05
 * @param {number}   settings.ercThresholdDown           - e.g. 0.05
 * @param {number}   settings.collateralSwapFee          - e.g. 0.01
 * @param {number}   settings.ercSwapFee                 - e.g. 0.01
 * @param {number}   settings.borrowFeeAnnual            - e.g. 0.05 (5 %/yr)
 * @param {boolean}  settings.collateralRebalanceEnabled
 * @param {boolean}  settings.ercRebalanceEnabled
 *
 * @returns {{
 *   collateralValues:         number[],   // collateral position USD value at each step
 *   yieldTokenValues:         number[],   // yield loan USD value at each step
 *   erc4626Values:            number[],   // ERC4626 shares USD value at each step
 *   positionValues:           number[],   // net position USD value at each step
 *   collateralRebalanceTimes: number[],   // time in years when collateral rebalance fired
 *   ercRebalanceTimes:        number[],   // time in years when ERC4626 rebalance fired
 * }}
 */
export function runSimulation(collateralPrices, yieldAssetPrices, sharePrices, settings) {
    const {
        durationYears,
        ltv,
        collateralThresholdUp,
        collateralThresholdDown,
        ercThresholdUp,
        ercThresholdDown,
        collateralSwapFee,
        ercSwapFee,
        borrowFeeAnnual,
        collateralRebalanceEnabled,
        ercRebalanceEnabled,
        collateralIntervalMinutes = 0,
        ercIntervalMinutes        = 0,
    } = settings;

    const n       = collateralPrices.length;
    const dtYears = durationYears / (n - 1);

    let collateralAmount = 100;
    let yieldLoan        = collateralAmount * collateralPrices[0] * ltv;   // yield asset units
    let sharesCount      = yieldLoan * (1 - ercSwapFee) / sharePrices[0]; // ERC4626 share units

    const collateralValues         = new Array(n);
    const yieldTokenValues         = new Array(n);
    const erc4626Values            = new Array(n);
    const positionValues           = new Array(n);
    const collateralRebalanceTimes = [];
    const ercRebalanceTimes        = [];

    const collateralIntervalYears = collateralIntervalMinutes / (365.25 * 24 * 60);
    const ercIntervalYears        = ercIntervalMinutes / (365.25 * 24 * 60);
    let lastCollateralRebalance   = -Infinity;
    let lastErcRebalance          = -Infinity;

    for (let i = 0; i < n; i++) {
        const t  = i * dtYears;
        const cp = collateralPrices[i];
        const yp = yieldAssetPrices[i];
        const sp = sharePrices[i];

        // Accrue borrow fee on the loan
        if (i > 0) yieldLoan *= (1 + borrowFeeAnnual * dtYears);

        const cvUsd = collateralAmount * cp;

        // Collateral rebalance: bring loan back to cv * ltv
        if (collateralRebalanceEnabled && t - lastCollateralRebalance >= collateralIntervalYears) {
            const targetYield = cvUsd * ltv / yp;
            const dev         = (targetYield - yieldLoan) / yieldLoan;
            if (dev >= collateralThresholdUp || dev <= -collateralThresholdDown) {
                const yieldDiff = targetYield - yieldLoan;
                yieldLoan   = targetYield;
                sharesCount += yieldDiff > 0
                    ? yieldDiff * (1 - ercSwapFee) / sp          // buying shares: pay fee
                    : yieldDiff / ((1 - ercSwapFee) * sp);       // selling shares: pay fee (need more shares)
                collateralRebalanceTimes.push(t);
                lastCollateralRebalance = t;
            }
        }

        // ERC4626 rebalance: rebalance shares to match loan
        if (ercRebalanceEnabled && t - lastErcRebalance >= ercIntervalYears) {
            const yieldHeld = sharesCount * sp;
            const dev       = (yieldHeld - yieldLoan) / yieldLoan;
            if (dev >= ercThresholdUp) {
                // Excess shares → sell into collateral
                const excessYield  = yieldHeld - yieldLoan;
                sharesCount        = yieldLoan / sp;
                collateralAmount  += excessYield * yp * (1 - collateralSwapFee) / cp;
                ercRebalanceTimes.push(t);
                lastErcRebalance = t;
            } else if (dev <= -ercThresholdDown) {
                // Shares deficit → sell collateral to buy more shares
                const shortfall   = yieldLoan - yieldHeld;
                sharesCount       = yieldLoan / sp;
                collateralAmount -= shortfall * yp * (1 + collateralSwapFee) / cp;
                ercRebalanceTimes.push(t);
                lastErcRebalance = t;
            }
        }

        collateralValues[i] = collateralAmount * cp;
        yieldTokenValues[i] = yieldLoan * yp;
        erc4626Values[i]    = sharesCount * sp * yp;
        positionValues[i]   = collateralValues[i] - yieldTokenValues[i] + erc4626Values[i];
    }

    return {
        collateralValues,
        yieldTokenValues,
        erc4626Values,
        positionValues,
        collateralRebalanceTimes,
        ercRebalanceTimes,
    };
}
