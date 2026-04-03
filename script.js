// ── Constants ────────────────────────────────────────────────────────
let flowAmount                = 100;
let LTV                       = 0.90;
let FLOW_REBALANCE_THRESHOLD  = 0.05;
let ERC_REBALANCE_THRESHOLD   = 0.05;
const BASE_PRICE              = 1.00;
let CHART_MAX       = 200;  // bar chart x-axis max in $ — doubles as needed
let yMax            = 2;    // shared price chart y-axis max
const WINDOW_YEARS  = 5;

// ── State ────────────────────────────────────────────────────────────
let flowPrice      = BASE_PRICE;
let yieldLoan       = flowAmount * BASE_PRICE * LTV;  // yield assets borrowed (in yield asset units)
let sharePrice      = 1.00;       // ERC4626 share price (dynamic)
let shareTrendPrice = 1.00;
let yieldAssetPrice = 1.00;       // Yield asset price (display + income)
let yieldTrendPrice = 1.00;
let sharesCount     = yieldLoan / sharePrice;  // ERC shares = yield assets / sharePrice
let playing    = false;
let lastTs     = null;
let rafId      = null;
let trendPrice = BASE_PRICE;
let simMonths  = 0;

// ── Helpers ──────────────────────────────────────────────────────────
function usd(n) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function usdInt(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
}
function usdS(n) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '$';
}
function fv() { return flowAmount * flowPrice; }
function barPct(dollars) { return Math.min(dollars / CHART_MAX * 100, 100) + '%'; }

function formatSimTime(months) {
    const years = Math.floor(months / 12);
    const mo    = Math.floor(months % 12);
    if (years === 0) return mo + 'mo';
    return years + 'y ' + mo + 'mo';
}

// ── Rebalance ─────────────────────────────────────────────────────────
function tryRebalanceFlow() {
    if (!document.getElementById('btn-flow-rebalance').classList.contains('active')) return false;
    const targetYield = fv() * LTV / yieldAssetPrice;  // target in yield asset units
    const dev = (targetYield - yieldLoan) / yieldLoan;
    if (Math.abs(dev) >= FLOW_REBALANCE_THRESHOLD) {
        const yieldDiff = targetYield - yieldLoan;
        yieldLoan   = targetYield;
        sharesCount += yieldDiff / sharePrice;
        return 'flow';
    }
    return false;
}

function tryRebalanceERC4626() {
    if (!document.getElementById('btn-share-rebalance').classList.contains('active')) return false;
    const yieldHeld = sharesCount * sharePrice;  // yield assets held via ERC shares
    const dev = (yieldHeld - yieldLoan) / yieldLoan;
    if (dev >= ERC_REBALANCE_THRESHOLD) {
        const excessYield = yieldHeld - yieldLoan;
        sharesCount = yieldLoan / sharePrice;
        flowAmount += excessYield * yieldAssetPrice / flowPrice;
        return 'erc';
    }
    return false;
}

function tryRebalance() {
    const flowResult = tryRebalanceFlow();
    if (flowResult) return flowResult;
    const ercResult = tryRebalanceERC4626();
    if (ercResult) return ercResult;
    return false;
}

function currentDeviation() {
    return (fv() * LTV / yieldAssetPrice - yieldLoan) / yieldLoan;
}

// ── Threshold lines ───────────────────────────────────────────────────
function updateERC4626ThresholdLines() {
    const debtUsd = yieldLoan * yieldAssetPrice;
    const barStart = Math.max(fv() - debtUsd, 0);
    const upper = (barStart + debtUsd * (1 + ERC_REBALANCE_THRESHOLD)) / CHART_MAX * 100;
    const lower = (barStart + debtUsd * (1 - ERC_REBALANCE_THRESHOLD)) / CHART_MAX * 100;

    document.getElementById('threshold-line-erc-upper').style.left  = Math.min(upper, 100) + '%';
    document.getElementById('threshold-label-erc-upper').style.left = Math.min(upper, 100) + '%';
    document.getElementById('threshold-label-erc-upper').textContent = usdInt(debtUsd * (1 + ERC_REBALANCE_THRESHOLD));

    document.getElementById('threshold-line-erc-lower').style.left  = Math.max(lower, 0) + '%';
    document.getElementById('threshold-label-erc-lower').style.left = Math.max(lower, 0) + '%';
    document.getElementById('threshold-label-erc-lower').textContent = usdInt(debtUsd * (1 - ERC_REBALANCE_THRESHOLD));
}

function updateThresholdLines() {
    // FLOW values at which loan deviates from fv()*LTV by ±threshold
    const debtUsd = yieldLoan * yieldAssetPrice;
    const upper = (debtUsd * (1 + FLOW_REBALANCE_THRESHOLD)) / LTV;
    const lower = (debtUsd * (1 - FLOW_REBALANCE_THRESHOLD)) / LTV;

    document.getElementById('threshold-line-upper').style.left  = Math.min(upper / CHART_MAX * 100, 100) + '%';
    document.getElementById('threshold-label-upper').style.left = Math.min(upper / CHART_MAX * 100, 100) + '%';
    document.getElementById('threshold-label-upper').textContent = usdInt(upper);

    document.getElementById('threshold-line-lower').style.left   = Math.max(lower / CHART_MAX * 100, 0) + '%';
    document.getElementById('threshold-label-lower').style.left  = Math.max(lower / CHART_MAX * 100, 0) + '%';
    document.getElementById('threshold-label-lower').textContent = usdInt(lower);
}

// ── Price history chart (Chart.js) ────────────────────────────────────
let simTime           = 0; // seconds — only advances during active animations

const TICK_STYLE = {
    color: '#333',
    font: { family: 'SF Mono, Fira Code, monospace', size: 10 },
    callback: v => '$' + v.toFixed(2),
    maxTicksLimit: 5,
};

const priceChart = new Chart(document.getElementById('price-chart'), {
    type: 'line',
    data: {
        datasets: [
            {
                // FLOW price
                data: [{ x: 0, y: BASE_PRICE }, { x: 0.001, y: BASE_PRICE }],
                yAxisID: 'y',
                borderColor: '#5cb85c',
                borderWidth: 1.5,
                backgroundColor: 'rgba(92, 184, 92, 0.06)',
                fill: true,
                pointRadius: 0,
                tension: 0.3,
            },
            {
                // ERC4626 share price
                data: [{ x: 0, y: 1.00 }, { x: 0.001, y: 1.00 }],
                yAxisID: 'y',
                borderColor: '#9a6ab8',
                borderWidth: 1.5,
                backgroundColor: 'rgba(154, 106, 184, 0.06)',
                fill: true,
                pointRadius: 0,
                tension: 0.3,
            },
            {
                // Yield asset price
                data: [{ x: 0, y: 1.00 }, { x: 0.001, y: 1.00 }],
                yAxisID: 'y',
                borderColor: '#5c7db8',
                borderWidth: 1.5,
                backgroundColor: 'rgba(92, 125, 184, 0.06)',
                fill: true,
                pointRadius: 0,
                tension: 0.3,
            }
        ]
    },
    options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
        },
        scales: {
            x: {
                type: 'linear',
                min: 0,
                max: WINDOW_YEARS,
                grid: { color: 'rgba(255,255,255,0.03)' },
                ticks: {
                    color: '#333',
                    font: { family: 'SF Mono, Fira Code, monospace', size: 10 },
                    callback: v => v.toFixed(1) + 'y',
                    maxTicksLimit: 6,
                },
            },
            y: {
                position: 'right',
                min: 0,
                max: yMax,
                grid: { color: 'rgba(255,255,255,0.04)' },
                ticks: TICK_STYLE,
            },
        }
    }
});

// Rebalance markers — only drawn on the position chart
let flowRebalanceYears = [];
let ercRebalanceYears  = [];

const rebalancePlugin = {
    id: 'rebalanceLines',
    afterDraw(chart) {
        if (chart.canvas.id !== 'position-chart') return;
        const { ctx, chartArea, scales } = chart;
        if (!chartArea) return;
        ctx.save();
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        for (const [times, color] of [[flowRebalanceYears, 'rgba(92,184,92,0.5)'], [ercRebalanceYears, 'rgba(154,106,184,0.5)']]) {
            ctx.strokeStyle = color;
            for (const t of times) {
                const x = scales.x.getPixelForValue(t);
                if (x < chartArea.left || x > chartArea.right) continue;
                ctx.beginPath();
                ctx.moveTo(x, chartArea.top);
                ctx.lineTo(x, chartArea.bottom);
                ctx.stroke();
            }
        }
        ctx.setLineDash([]);
        ctx.restore();
    }
};
Chart.register(rebalancePlugin);

// ── Position value chart ───────────────────────────────────────────────
let posYMax = 200;
let posYMin = 90;
function effectiveSharePrice() { return sharePrice * yieldAssetPrice; }
function posVal() { return fv() - yieldLoan * yieldAssetPrice + sharesCount * effectiveSharePrice(); }
let initialPosVal = null;

const positionChart = new Chart(document.getElementById('position-chart'), {
    type: 'line',
    data: {
        datasets: [{
            data: [{ x: 0, y: posVal() }, { x: 0.001, y: posVal() }],
            yAxisID: 'y',
            borderColor: '#5c9ab8',
            borderWidth: 1.5,
            backgroundColor: 'rgba(92, 154, 184, 0.06)',
            fill: true,
            pointRadius: 0,
            tension: 0.3,
        }]
    },
    options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
            x: {
                type: 'linear',
                min: 0,
                max: 1,
                grid: { color: 'rgba(255,255,255,0.03)' },
                ticks: {
                    color: '#333',
                    font: { family: 'SF Mono, Fira Code, monospace', size: 10 },
                    callback: v => v.toFixed(1) + 'y',
                    maxTicksLimit: 6,
                },
            },
            y: {
                position: 'right',
                min: posYMin,
                max: posYMax,
                grid: { color: 'rgba(255,255,255,0.04)' },
                ticks: {
                    color: '#333',
                    font: { family: 'SF Mono, Fira Code, monospace', size: 10 },
                    callback: v => '$' + v.toFixed(0),
                    maxTicksLimit: 5,
                },
            },
        }
    }
});

const WINDOW_SECS     = 10;
let lastRecordedFlow  = BASE_PRICE;
let lastRecordedShare = 1.00;
let lastRecordedYield = 1.00;
let lastRecordedPos   = posVal();

function recordPrice(rebalanceType) {
    const isRebalance = !!rebalanceType;
    const simYears = simMonths / 12;

    // ── Price history chart (same 5-year sliding window as position chart) ──
    const dsFlow   = priceChart.data.datasets[0].data;
    const dsShare  = priceChart.data.datasets[1].data;
    const dsYield  = priceChart.data.datasets[2].data;
    const cutoff   = simYears - WINDOW_YEARS;

    const flowMoved  = Math.abs(flowPrice       - lastRecordedFlow)  >= 0.0001;
    const shareMoved = Math.abs(sharePrice      - lastRecordedShare) >= 0.0001;
    const yieldMoved = Math.abs(yieldAssetPrice - lastRecordedYield) >= 0.0001;

    if (flowMoved || shareMoved || yieldMoved || isRebalance) {
        lastRecordedFlow  = flowPrice;
        lastRecordedShare = sharePrice;
        lastRecordedYield = yieldAssetPrice;
        dsFlow.push({ x: simYears, y: flowPrice });
        dsShare.push({ x: simYears, y: sharePrice });
        dsYield.push({ x: simYears, y: yieldAssetPrice });
        while (dsFlow.length  > 1 && dsFlow[0].x  < cutoff) dsFlow.shift();
        while (dsShare.length > 1 && dsShare[0].x < cutoff) dsShare.shift();
        while (dsYield.length > 1 && dsYield[0].x < cutoff) dsYield.shift();
    } else if (playing || running1y) {
        if (dsFlow.length  > 0) dsFlow[dsFlow.length - 1].x   = simYears;
        if (dsShare.length > 0) dsShare[dsShare.length - 1].x = simYears;
        if (dsYield.length > 0) dsYield[dsYield.length - 1].x = simYears;
    }

    if (flowPrice >= yMax || sharePrice >= yMax || yieldAssetPrice >= yMax) {
        while (yMax <= flowPrice || yMax <= sharePrice || yMax <= yieldAssetPrice) yMax *= 2;
        priceChart.options.scales.y.max = yMax;
    }

    priceChart.options.scales.x.min = Math.max(0, simYears - WINDOW_YEARS);
    priceChart.options.scales.x.max = Math.max(simYears, WINDOW_YEARS);
    priceChart.update('none');

    // ── Position value chart (sliding 5-year window, x = sim years) ──
    const dsPos    = positionChart.data.datasets[0].data;
    const posCutoff = simYears - WINDOW_YEARS;
    const pv        = posVal();
    const posMoved  = Math.abs(pv - lastRecordedPos) >= 0.01;

    if (posMoved || isRebalance) {
        lastRecordedPos = pv;
        dsPos.push({ x: simYears, y: pv });
        if (rebalanceType === 'flow') flowRebalanceYears.push(simYears);
        if (rebalanceType === 'erc')  ercRebalanceYears.push(simYears);
        while (dsPos.length > 1 && dsPos[0].x < posCutoff) dsPos.shift();
        flowRebalanceYears = flowRebalanceYears.filter(t => t >= posCutoff);
        ercRebalanceYears  = ercRebalanceYears.filter(t => t >= posCutoff);
    } else if (playing || running1y) {
        if (dsPos.length > 0) dsPos[dsPos.length - 1].x = simYears;
    }

    // Snap y-axis: scan all visible points, double/halve at boundaries
    const allY    = dsPos.map(p => p.y);
    const dataMin = Math.min(...allY);
    const dataMax = Math.max(...allY);
    if (dataMax >= posYMax) {
        while (posYMax <= dataMax) posYMax *= 2;
        positionChart.options.scales.y.max = posYMax;
    } else if (dataMax < posYMax * 0.25) {
        while (dataMax < posYMax * 0.25) posYMax /= 2;
        positionChart.options.scales.y.max = posYMax;
    }
    if (dataMin < posYMin) {
        while (posYMin > dataMin) posYMin /= 2;
        positionChart.options.scales.y.min = posYMin;
    } else if (dataMin > posYMin * 4 && posYMin < 90) {
        while (dataMin > posYMin * 4 && posYMin < 90) posYMin *= 2;
        positionChart.options.scales.y.min = Math.min(posYMin, 90);
    }

    positionChart.options.scales.x.min = Math.max(0, simYears - WINDOW_YEARS);
    positionChart.options.scales.x.max = Math.max(simYears, WINDOW_YEARS);
    positionChart.update('none');
}

// ── Render ────────────────────────────────────────────────────────────
function render(rebalanced) {
    const flowVal = fv();
    const pv = posVal();
    if (initialPosVal === null) initialPosVal = pv;
    document.getElementById('position-val').textContent = usd(pv);

    const simYears = simMonths / 12;
    const yearlyPctEl = document.getElementById('pos-yearly-pct');
    if (simYears >= 0.01) {
        const rate = (Math.pow(pv / initialPosVal, 1 / simYears) - 1) * 100;
        const sign = rate >= 0 ? '+' : '';
        yearlyPctEl.textContent = sign + rate.toFixed(1) + '%/yr';
        yearlyPctEl.style.color = rate >= 0 ? '#5cb85c' : '#d9534f';
    } else {
        yearlyPctEl.textContent = '';
    }
    document.getElementById('flow-price-val').textContent  = '$' + flowPrice.toFixed(2);
    document.getElementById('yield-price-val').textContent = '$' + yieldAssetPrice.toFixed(2);
    document.getElementById('share-price-val').textContent = '$' + sharePrice.toFixed(2);

    // Resize bar chart max: double if hitting ceiling, halve if below 25%
    const barRef = fv();
    let chartMaxChanged = false;
    if (barRef >= CHART_MAX) {
        while (CHART_MAX <= barRef) CHART_MAX *= 2;
        chartMaxChanged = true;
    } else if (barRef < CHART_MAX * 0.25) {
        while (barRef < CHART_MAX * 0.25) CHART_MAX /= 2;
        chartMaxChanged = true;
    }
    if (chartMaxChanged) {
        rebuildGridlines();
        const yieldLeftNow = barPct(Math.max(fv() - yieldLoan * yieldAssetPrice, 0));
        document.getElementById('pyusd-bar').style.left   = yieldLeftNow;
        document.getElementById('pyusd-bar').style.width  = barPct(yieldLoan * yieldAssetPrice);
        document.getElementById('shares-bar').style.left  = yieldLeftNow;
        document.getElementById('shares-bar').style.width = barPct(sharesCount * effectiveSharePrice());
    }



    document.getElementById('flow-bar').style.width = barPct(flowVal);
    document.getElementById('flow-bar-text').textContent = `${flowAmount.toFixed(2)} FLOW\n${usdS(flowVal)}`;

    // Yield asset bar = loan (debt), right-anchored to FLOW's right edge, grows leftward
    const yieldLeft = barPct(Math.max(fv() - yieldLoan * yieldAssetPrice, 0));
    document.getElementById('pyusd-bar').style.left         = yieldLeft;
    document.getElementById('pyusd-bar').style.width        = barPct(yieldLoan * yieldAssetPrice);
    document.getElementById('pyusd-bar-text').textContent   = `${yieldLoan.toFixed(2)} Yield Asset\n${usdS(yieldLoan * yieldAssetPrice)}`;

    // Shares bar starts at yield asset's left edge, grows rightward
    const sharesValueNow = sharesCount * effectiveSharePrice();
    document.getElementById('shares-bar').style.left        = yieldLeft;
    document.getElementById('shares-bar').style.width       = barPct(sharesValueNow);
    document.getElementById('shares-bar-text').textContent  = `${sharesCount.toFixed(2)} shares\n${(sharesCount * sharePrice).toFixed(2)} yield asset\n${usdS(sharesValueNow)}`;

    // Threshold lines track live yieldLoan every frame
    updateThresholdLines();

    if (rebalanced) {
        const toast = document.getElementById('toast');
        document.getElementById('toast-body').textContent =
            `Rebalanced \u2192 ${usd(yieldLoan * yieldAssetPrice)} yield debt at FLOW ${usd(flowVal)}`;
        toast.classList.add('show');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
    }

    updateERC4626ThresholdLines();

    recordPrice(rebalanced);
}

// ── Price advance helper (shared by tick and run-1-year) ──────────────
function advancePrices(simYearFrac, dtSecs) {
    simTime += dtSecs;

    const annualPct = parseFloat(document.getElementById('sl-drift').value);
    const flowVolOn = document.getElementById('btn-flow-vol').classList.contains('active');
    const period    = Math.max(parseFloat(document.getElementById('sl-period').value), 0.1);
    const amplitude = flowVolOn ? parseFloat(document.getElementById('sl-velocity').value) : 0;

    trendPrice = Math.max(trendPrice * Math.pow(1 + annualPct / 100, simYearFrac), 0.01);
    flowPrice  = Math.max(trendPrice + amplitude * Math.sin(2 * Math.PI * simTime / period), 0.01);

    const shareAnnualPct = parseFloat(document.getElementById('sl-share-drift').value);
    const shareVolOn     = document.getElementById('btn-share-vol').classList.contains('active');
    const sharePeriod    = Math.max(parseFloat(document.getElementById('sl-share-period').value), 0.1);
    const shareAmplitude = shareVolOn ? parseFloat(document.getElementById('sl-share-velocity').value) : 0;

    shareTrendPrice = Math.max(shareTrendPrice * Math.pow(1 + shareAnnualPct / 100, simYearFrac), 0.01);
    sharePrice      = Math.max(shareTrendPrice + shareAmplitude * Math.sin(2 * Math.PI * simTime / sharePeriod), 0.01);

    // Borrow fee: interest accrues on the loan, growing the debt
    const borrowFee = parseFloat(document.getElementById('sl-borrow-fee').value) / 100;
    yieldLoan += yieldLoan * borrowFee * simYearFrac;

    // Yield asset price + income credited to shares
    const yieldAnnualPct = parseFloat(document.getElementById('sl-yield-drift').value);
    const yieldVolOn     = document.getElementById('btn-yield-vol').classList.contains('active');
    const yieldPeriod    = Math.max(parseFloat(document.getElementById('sl-yield-period').value), 0.1);
    const yieldAmpl      = yieldVolOn ? parseFloat(document.getElementById('sl-yield-velocity').value) : 0;
    yieldTrendPrice  = Math.max(yieldTrendPrice * Math.pow(1 + yieldAnnualPct / 100, simYearFrac), 0.01);
    yieldAssetPrice  = Math.max(yieldTrendPrice + yieldAmpl * Math.sin(2 * Math.PI * simTime / yieldPeriod), 0.01);
}

// ── Play loop ─────────────────────────────────────────────────────────
function tick(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.1);
    lastTs = ts;

    const speed = parseFloat(document.getElementById('sl-speed').value);
    simMonths += dt * speed;
    advancePrices(dt * speed / 12, dt);

    const rebalanced = tryRebalance();
    render(rebalanced);

    rafId = requestAnimationFrame(tick);
}

// ── Play / Reset ──────────────────────────────────────────────────────
document.getElementById('btn-play').addEventListener('click', () => {
    playing = !playing;
    document.getElementById('btn-play').textContent = playing ? '\u23F8 Pause' : '\u25B6 Play';
    if (playing) {
        lastTs = null;
        rafId  = requestAnimationFrame(tick);
    }
});

document.getElementById('btn-reset').addEventListener('click', () => {
    playing = false;
    lastTs  = null;
    if (rafId) cancelAnimationFrame(rafId);
    document.getElementById('btn-play').textContent = '\u25B6 Play';

    flowPrice   = BASE_PRICE;
    flowAmount  = 100;
    trendPrice  = BASE_PRICE;
    yieldLoan   = flowAmount * BASE_PRICE * LTV;  // yield asset units (yieldAssetPrice reset to 1)
    CHART_MAX   = 200;
    yMax        = 2;
    rebuildGridlines();

    // Reset history chart
    simTime           = 0;
    simMonths         = 0;
    initialPosVal     = null;
    lastRecordedFlow  = BASE_PRICE;
    lastRecordedShare = 1.00;
    sharePrice        = 1.00;
    shareTrendPrice   = 1.00;
    yieldAssetPrice   = 1.00;
    yieldTrendPrice   = 1.00;
    lastRecordedYield = 1.00;
    priceChart.options.scales.y.max = yMax;
    priceChart.data.datasets[0].data = [{ x: 0, y: BASE_PRICE }, { x: 0.001, y: BASE_PRICE }];
    priceChart.data.datasets[1].data = [{ x: 0, y: 1.00 }, { x: 0.001, y: 1.00 }];
    priceChart.data.datasets[2].data = [{ x: 0, y: 1.00 }, { x: 0.001, y: 1.00 }];
    priceChart.options.scales.x.min  = 0;
    priceChart.options.scales.x.max  = WINDOW_YEARS;
    priceChart.update('none');

    sharesCount = yieldLoan / sharePrice;
    lastRecordedPos = posVal();
    flowRebalanceYears = [];
    ercRebalanceYears  = [];
    positionChart.data.datasets[0].data = [{ x: 0, y: posVal() }, { x: 0.001, y: posVal() }];
    posYMax = 200;
    posYMin = 90;
    positionChart.options.scales.y.max  = posYMax;
    positionChart.options.scales.y.min  = posYMin;
    positionChart.options.scales.x.min  = 0;
    positionChart.options.scales.x.max  = WINDOW_YEARS;
    positionChart.update('none');

    const resetYieldLeft = barPct(Math.max(fv() - yieldLoan * yieldAssetPrice, 0));
    document.getElementById('flow-bar').style.width    = barPct(fv());
    document.getElementById('pyusd-bar').style.left    = resetYieldLeft;
    document.getElementById('pyusd-bar').style.width   = barPct(yieldLoan * yieldAssetPrice);
    document.getElementById('shares-bar').style.left   = resetYieldLeft;
    document.getElementById('shares-bar').style.width  = barPct(sharesCount * effectiveSharePrice());
    document.getElementById('pyusd-bar-text').textContent  = `${(sharesCount * sharePrice).toFixed(2)} Yield Asset\n${usdS(sharesCount * effectiveSharePrice())}`;
    document.getElementById('shares-bar-text').textContent = `${sharesCount.toFixed(2)} shares\n${(sharesCount * sharePrice).toFixed(2)} yield asset\n${usdS(sharesCount * effectiveSharePrice())}`;


    updateThresholdLines();
    updateERC4626ThresholdLines();
    render(false);
});

// ── Run 1 Year ────────────────────────────────────────────────────────
let running1y = false;
document.getElementById('btn-run1y').addEventListener('click', () => {
    if (running1y) return;
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    document.getElementById('btn-play').textContent = '\u25B6 Play';

    running1y = true;
    const btn = document.getElementById('btn-run1y');
    btn.disabled = true;

    const STEPS    = 90;              // ~1.5s of real time at 60fps
    const dtMonths = 12 / STEPS;     // sim months per frame
    const dtSecs   = 1 / 60;         // real seconds per frame (for sine)
    let step = 0;

    function frame() {
        if (step >= STEPS) {
            running1y    = false;
            btn.disabled = false;
            return;
        }
        step++;
        simMonths += dtMonths;
        advancePrices(dtMonths / 12, dtSecs);
        const rebalanced = tryRebalance();
        render(rebalanced);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
});

// ── Run 3 Years ───────────────────────────────────────────────────────
document.getElementById('btn-run3y').addEventListener('click', () => {
    if (running1y) return;
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    document.getElementById('btn-play').textContent = '\u25B6 Play';

    running1y = true;
    const btn = document.getElementById('btn-run3y');
    btn.disabled = true;

    const STEPS    = 90;               // same wall-clock time as 1 Year
    const dtMonths = 36 / STEPS;
    const dtSecs   = 1 / 60;
    let step = 0;

    function frame() {
        if (step >= STEPS) {
            running1y    = false;
            btn.disabled = false;
            return;
        }
        step++;
        simMonths += dtMonths;
        advancePrices(dtMonths / 12, dtSecs);
        const rebalanced = tryRebalance();
        render(rebalanced);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
});

// ── Build bar chart gridlines + x-axis ───────────────────────────────
const gridContainer = document.getElementById('gridlines');
const xLabels       = document.getElementById('x-labels');

function rebuildGridlines() {
    gridContainer.querySelectorAll('.gridline').forEach(el => el.remove());
    xLabels.querySelectorAll('.x-label').forEach(el => el.remove());

    const step = CHART_MAX / 8;
    for (let i = 1; i <= 8; i++) {
        const val = step * i;
        const pct = (val / CHART_MAX * 100) + '%';
        const label = val >= 1000 ? `$${val / 1000}k` : `$${val}`;

        const line = document.createElement('div');
        line.className = 'gridline' + (i === 4 ? ' gridline-hl' : '');
        line.style.left = pct;
        gridContainer.appendChild(line);

        const span = document.createElement('span');
        span.className = 'x-label';
        span.style.left = pct;
        span.textContent = label;
        xLabels.appendChild(span);
    }
    updateThresholdLines();
    updateERC4626ThresholdLines();
}

rebuildGridlines();

// ── Config slider listeners ───────────────────────────────────────────
document.getElementById('sl-ltv').addEventListener('input', e => {
    LTV = parseFloat(e.target.value);
    document.getElementById('val-ltv').textContent = Math.round(LTV * 100);
    updateThresholdLines();
});
document.getElementById('sl-threshold-flow').addEventListener('input', e => {
    FLOW_REBALANCE_THRESHOLD = parseInt(e.target.value) / 100;
    document.getElementById('val-threshold-flow').textContent = parseInt(e.target.value);
    updateThresholdLines();
});
document.getElementById('sl-threshold-erc').addEventListener('input', e => {
    ERC_REBALANCE_THRESHOLD = parseInt(e.target.value) / 100;
    document.getElementById('val-threshold-erc').textContent = parseInt(e.target.value);
    updateERC4626ThresholdLines();
});

// ── Slider labels ─────────────────────────────────────────────────────
document.getElementById('sl-speed').addEventListener('input', e =>
    document.getElementById('val-speed').textContent = parseFloat(e.target.value).toFixed(1));
document.getElementById('sl-borrow-fee').addEventListener('input', e =>
    document.getElementById('val-borrow-fee').textContent = parseInt(e.target.value));
document.getElementById('sl-drift').addEventListener('input', e =>
    document.getElementById('val-drift').textContent = parseFloat(e.target.value).toFixed(0));
document.getElementById('sl-period').addEventListener('input', e =>
    document.getElementById('val-period').textContent = parseFloat(e.target.value).toFixed(1));
document.getElementById('sl-velocity').addEventListener('input', e =>
    document.getElementById('val-velocity').textContent = parseFloat(e.target.value).toFixed(3));
document.getElementById('sl-share-drift').addEventListener('input', e =>
    document.getElementById('val-share-drift').textContent = parseInt(e.target.value));
document.getElementById('sl-share-period').addEventListener('input', e =>
    document.getElementById('val-share-period').textContent = parseFloat(e.target.value).toFixed(1));
document.getElementById('sl-share-velocity').addEventListener('input', e =>
    document.getElementById('val-share-velocity').textContent = parseFloat(e.target.value).toFixed(3));
document.getElementById('sl-yield-drift').addEventListener('input', e =>
    document.getElementById('val-yield-drift').textContent = parseInt(e.target.value));
document.getElementById('sl-yield-period').addEventListener('input', e =>
    document.getElementById('val-yield-period').textContent = parseFloat(e.target.value).toFixed(1));
document.getElementById('sl-yield-velocity').addEventListener('input', e =>
    document.getElementById('val-yield-velocity').textContent = parseFloat(e.target.value).toFixed(3));

// ── Toggle buttons ────────────────────────────────────────────────────
function setupToggle(btnId, onToggle) {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        if (onToggle) onToggle(btn.classList.contains('active'));
    });
}

function applyVolDim(volBtnId, periodId, amplitudeId) {
    const on = document.getElementById(volBtnId).classList.contains('active');
    document.getElementById(periodId).classList.toggle('dimmed', !on);
    document.getElementById(amplitudeId).classList.toggle('dimmed', !on);
}

setupToggle('btn-flow-vol',  () => applyVolDim('btn-flow-vol',  'flow-vol-period',  'flow-vol-amplitude'));
setupToggle('btn-share-vol', () => applyVolDim('btn-share-vol', 'share-vol-period', 'share-vol-amplitude'));
setupToggle('btn-yield-vol', () => applyVolDim('btn-yield-vol', 'yield-vol-period', 'yield-vol-amplitude'));
setupToggle('btn-flow-rebalance', active => {
    document.getElementById('flow-rebalance-thresh').classList.toggle('dimmed', !active);
    document.getElementById('sl-threshold-flow').disabled = !active;
});
setupToggle('btn-share-rebalance', active => {
    document.getElementById('erc-rebalance-thresh').classList.toggle('dimmed', !active);
    document.getElementById('sl-threshold-erc').disabled = !active;
});

// Apply initial dim state (vol buttons start inactive)
applyVolDim('btn-flow-vol',  'flow-vol-period',  'flow-vol-amplitude');
applyVolDim('btn-share-vol', 'share-vol-period', 'share-vol-amplitude');
applyVolDim('btn-yield-vol', 'yield-vol-period', 'yield-vol-amplitude');

// ── Initial render ────────────────────────────────────────────────────
const initYieldLeft = barPct(Math.max(fv() - yieldLoan * yieldAssetPrice, 0));
document.getElementById('flow-bar').style.width    = barPct(fv());
document.getElementById('pyusd-bar').style.left    = initYieldLeft;
document.getElementById('pyusd-bar').style.width   = barPct(yieldLoan * yieldAssetPrice);
document.getElementById('shares-bar').style.left   = initYieldLeft;
document.getElementById('shares-bar').style.width  = barPct(sharesCount * effectiveSharePrice());
document.getElementById('pyusd-bar-text').textContent  = `${(sharesCount * sharePrice).toFixed(2)} Yield Asset\n${usdS(sharesCount * effectiveSharePrice())}`;
document.getElementById('shares-bar-text').textContent = `${sharesCount.toFixed(2)} shares\n${(sharesCount * sharePrice).toFixed(2)} yield asset\n${usdS(sharesCount * effectiveSharePrice())}`;
updateThresholdLines();
render(false);
