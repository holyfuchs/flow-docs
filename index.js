import { runSimulation } from './simulation.js';
import { FLOW_PRICES }     from './price_data/flow_prices.js';
import { ETHEREUM_PRICES } from './price_data/ethereum_prices.js';

const HISTORY_DATA = { 'history-flow': FLOW_PRICES, 'history-eth': ETHEREUM_PRICES };

// ── Formatters ────────────────────────────────────────────────────────
function usd(n)   { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function usdInt(n){ return '$' + Math.round(n).toLocaleString('en-US'); }
function usdS(n)  { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '$'; }

// ── DOM helpers ───────────────────────────────────────────────────────
const durationYears  = () => parseInt(document.getElementById('sl-duration').value) / 365.25;
const fmtTime        = v => { const d = Math.round(v * 365.25); return d < 60 ? d + 'd' : Math.round(v * 12) + 'mo'; };
const numVal         = id => parseFloat(document.getElementById(id).value);
const isActive      = id => document.getElementById(id).classList.contains('active');

// ── Bar chart ─────────────────────────────────────────────────────────
let CHART_MAX = 200;
function barPct(dollars) { return Math.min(dollars / CHART_MAX * 100, 100) + '%'; }

// ── Simulation state ──────────────────────────────────────────────────
const N_POINTS  = 4000;
let simResult        = null;   // last result from runSimulation()
let priceArrays      = null;   // { collateral, yield, share, times }

let playing  = false;
let playIdx  = 0;         // float — fractional index into result arrays
let lastTs   = null;
let rafId    = null;

// ── Read settings from DOM ────────────────────────────────────────────
function gatherSettings() {
    return {
        durationYears:              durationYears(),
        ltvUp:                      numVal('num-ltv-up') / 100,
        ltvDown:                    numVal('num-ltv-down') / 100,
        collateralThresholdUp:      numVal('num-threshold-flow-up')   / 100,
        collateralThresholdDown:    numVal('num-threshold-flow-down') / 100,
        ercThresholdUp:             numVal('num-threshold-erc-up')    / 100,
        ercThresholdDown:           numVal('num-threshold-erc-down')  / 100,
        collateralSwapFee:          numVal('num-collateral-swap-fee') / 100,
        ercSwapFee:                 numVal('num-erc-swap-fee') / 100,
        borrowFeeAnnual:            numVal('num-borrow-fee') / 100,
        collateralRebalanceEnabled: isActive('btn-flow-rebalance'),
        ercRebalanceEnabled:        isActive('btn-share-rebalance'),
        collateralIntervalMinutes:  numVal('num-interval-flow'),
        ercIntervalMinutes:         numVal('num-interval-erc'),
    };
}

// ── Deterministic PRNG (xorshift32, fixed seeds per asset) ───────────
function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return (s >>> 0) / 4294967296;
    };
}

function rngRandn(rng) {
    // Box-Muller with seeded RNG
    let u, v;
    do { u = rng(); } while (u === 0);
    do { v = rng(); } while (v === 0);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function rngPoisson(rng, lambda) {
    if (lambda <= 0) return 0;
    let L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
}

// ── Generate price series for one asset ──────────────────────────────
// GBM and Jump use a Brownian Bridge so the path always ends at EXACTLY (1+μ)^T.
// B(t) = W(t) - (t/T)·W(T) pins both endpoints to 0, then trend multiplies on top.
function genSeries(drift, volType, params, N, dt, seed) {
    const out = new Array(N);
    out[0] = 1.0;
    const mu = drift;
    const T  = (N - 1) * dt;

    if (volType in HISTORY_DATA) {
        const prices     = HISTORY_DATA[volType];
        const daysNeeded = Math.max(2, Math.round(T * 365.25));
        const offset     = Math.max(0, Math.round(params.historyOffset || 0));
        const endIdx     = Math.max(daysNeeded, prices.length - offset);
        const src        = prices.slice(Math.max(0, endIdx - daysNeeded), endIdx);
        const base       = src[0];
        for (let i = 0; i < N; i++) {
            const t  = i / (N - 1) * (src.length - 1);
            const lo = Math.floor(t), hi = Math.min(lo + 1, src.length - 1);
            out[i]   = Math.max((src[lo] + (src[hi] - src[lo]) * (t - lo)) / base, 0.001);
        }
        return out;
    } else if (volType === 'none') {
        for (let i = 1; i < N; i++) out[i] = Math.max(Math.pow(1 + mu, i * dt), 0.001);

    } else if (volType === 'sine') {
        // Snap period so an integer number of half-waves fits exactly in T
        const halfWaves = Math.max(1, Math.round(T / params.period * 2));
        const period    = 2 * T / halfWaves;
        for (let i = 1; i < N; i++) {
            const t = i * dt;
            out[i] = Math.max(Math.pow(1 + mu, t) * (1 + params.ampl * Math.sin(2 * Math.PI * t / period)), 0.001);
        }

    } else if (volType === 'gbm') {
        // Build standard BM, then apply bridge B(t)=W(t)-(t/T)·W(T) so B(T)=0
        // out[i] = (1+μ)^t · exp(σ·B(t))  →  out[N-1] = (1+μ)^T exactly
        const rng   = makeRng(seed);
        const sigma = params.sigma;
        const sqDt  = Math.sqrt(dt);
        const W = new Array(N).fill(0);
        for (let i = 1; i < N; i++) W[i] = W[i - 1] + sqDt * rngRandn(rng);
        for (let i = 0; i < N; i++) {
            const t = i * dt;
            const B = W[i] - (t / T) * W[N - 1];
            out[i] = Math.max(Math.pow(1 + mu, t) * Math.exp(sigma * B), 0.001);
        }

    } else if (volType === 'jump') {
        // Generate Poisson jumps first, record cumulative log-return from jumps.
        // Adjust continuous drift so total log-return = log((1+μ)^T) exactly.
        // Then layer a Brownian Bridge on top for the diffusion component.
        const rng         = makeRng(seed);
        const sigma       = params.sigma;
        const lambda      = params.lambda;
        const jumpLogRet  = Math.log(1 + params.jumpSize);
        const sqDt        = Math.sqrt(dt);

        const cumJump = new Array(N).fill(0);
        let totalJumpLogRet = 0;
        for (let i = 1; i < N; i++) {
            const nJumps = rngPoisson(rng, lambda / (N - 1));
            totalJumpLogRet += nJumps * jumpLogRet;
            cumJump[i] = totalJumpLogRet;
        }

        const targetLogRet       = T * Math.log(1 + mu);
        const contLogDriftPerYr  = (targetLogRet - totalJumpLogRet) / T;

        const W = new Array(N).fill(0);
        for (let i = 1; i < N; i++) W[i] = W[i - 1] + sqDt * rngRandn(rng);
        for (let i = 0; i < N; i++) {
            const t = i * dt;
            const B = W[i] - (t / T) * W[N - 1];
            out[i] = Math.max(Math.exp(contLogDriftPerYr * t + sigma * B + cumJump[i]), 0.001);
        }
    }
    return out;
}

// ── Generate price arrays ─────────────────────────────────────────────
function generatePriceArrays() {
    const dur = durationYears();
    const dt  = dur / (N_POINTS - 1);

    const times = Array.from({ length: N_POINTS }, (_, i) => i * dt);

    const flowVol = document.getElementById('sel-flow-vol').value;
    const collateral = genSeries(numVal('num-drift') / 100, flowVol, {
        period: numVal('num-period') / 365.25,
        ampl:   numVal('num-velocity') / 100,
        sigma:  numVal('num-flow-sigma') / 100,
        lambda: numVal('num-flow-lambda'),
        jumpSize: numVal('num-flow-jump') / 100,
        historyOffset: numVal('num-flow-history-offset'),
    }, N_POINTS, dt, parseInt(document.getElementById('sl-flow-seed').value) || 1);

    const yieldVol = document.getElementById('sel-yield-vol').value;
    const yieldArr = genSeries(numVal('num-yield-drift') / 100, yieldVol, {
        period: numVal('num-yield-period') / 365.25,
        ampl:   numVal('num-yield-velocity') / 100,
        sigma:  numVal('num-yield-sigma') / 100,
        lambda: numVal('num-yield-lambda'),
        jumpSize: numVal('num-yield-jump') / 100,
        historyOffset: numVal('num-yield-history-offset'),
    }, N_POINTS, dt, parseInt(document.getElementById('sl-yield-seed').value) || 1);

    const shareVol = document.getElementById('sel-share-vol').value;
    const share = genSeries(numVal('num-share-drift') / 100, shareVol, {
        period: numVal('num-share-period') / 365.25,
        ampl:   numVal('num-share-velocity') / 100,
        sigma:  numVal('num-share-sigma') / 100,
        lambda: numVal('num-share-lambda'),
        jumpSize: numVal('num-share-jump') / 100,
        historyOffset: numVal('num-share-history-offset'),
    }, N_POINTS, dt, parseInt(document.getElementById('sl-share-seed').value) || 1);

    return { collateral, yield: yieldArr, share, times };
}

// ── Recompute everything ──────────────────────────────────────────────
function recompute() {
    priceArrays = generatePriceArrays();
    const settings = gatherSettings();
    simResult   = runSimulation(priceArrays.collateral, priceArrays.yield, priceArrays.share, settings);
    // Force position chart to reload full dataset
    positionChart.data.datasets[0].data = [];
    updatePriceChart();
    renderFrame(Math.floor(playIdx));
}

// ── Threshold lines ───────────────────────────────────────────────────
function updateThresholdLines() {
    if (!simResult) return;
    const i       = Math.min(Math.floor(playIdx), N_POINTS - 1);
    const yp      = priceArrays.yield[i];
    const ltvUp   = numVal('num-ltv-up')   / 100;
    const ltvDown = numVal('num-ltv-down') / 100;
    const threshUp   = numVal('num-threshold-flow-up')   / 100;
    const threshDown = numVal('num-threshold-flow-down') / 100;
    const debtUsd = simResult.yieldTokenValues[i];
    const upper   = (debtUsd * (1 + threshUp))   / ltvUp;
    const lower   = (debtUsd * (1 - threshDown)) / ltvDown;

    document.getElementById('threshold-line-upper').style.left   = Math.min(upper / CHART_MAX * 100, 100) + '%';
    document.getElementById('threshold-label-upper').style.left  = Math.min(upper / CHART_MAX * 100, 100) + '%';
    document.getElementById('threshold-label-upper').textContent = usdInt(upper);
    document.getElementById('threshold-line-lower').style.left   = Math.max(lower / CHART_MAX * 100, 0)  + '%';
    document.getElementById('threshold-label-lower').style.left  = Math.max(lower / CHART_MAX * 100, 0)  + '%';
    document.getElementById('threshold-label-lower').textContent = usdInt(lower);
}

function updateERC4626ThresholdLines() {
    if (!simResult) return;
    const i       = Math.min(Math.floor(playIdx), N_POINTS - 1);
    const threshUp   = numVal('num-threshold-erc-up')   / 100;
    const threshDown = numVal('num-threshold-erc-down') / 100;
    const debtUsd = simResult.yieldTokenValues[i];
    const cvUsd   = simResult.collateralValues[i];
    const barStart = Math.max(cvUsd - debtUsd, 0);
    const upper    = (barStart + debtUsd * (1 + threshUp))   / CHART_MAX * 100;
    const lower    = (barStart + debtUsd * (1 - threshDown)) / CHART_MAX * 100;

    document.getElementById('threshold-line-erc-upper').style.left  = Math.min(upper, 100) + '%';
    document.getElementById('threshold-label-erc-upper').style.left = Math.min(upper, 100) + '%';
    document.getElementById('threshold-label-erc-upper').textContent = usdInt(debtUsd * (1 + threshUp));
    document.getElementById('threshold-line-erc-lower').style.left  = Math.max(lower, 0)  + '%';
    document.getElementById('threshold-label-erc-lower').style.left = Math.max(lower, 0)  + '%';
    document.getElementById('threshold-label-erc-lower').textContent = usdInt(debtUsd * (1 - threshDown));
}

// ── Price history chart ───────────────────────────────────────────────
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
            { label: 'Collateral', data: [], yAxisID: 'y', borderColor: '#5cb85c', borderWidth: 1.5, backgroundColor: 'rgba(92,184,92,0.06)',    fill: true, pointRadius: 0, tension: 0.3 },
            { label: 'ERC-4626',   data: [], yAxisID: 'y', borderColor: '#9a6ab8', borderWidth: 1.5, backgroundColor: 'rgba(154,106,184,0.06)', fill: true, pointRadius: 0, tension: 0.3 },
            { label: 'Yield',      data: [], yAxisID: 'y', borderColor: '#5c7db8', borderWidth: 1.5, backgroundColor: 'rgba(92,125,184,0.06)',  fill: true, pointRadius: 0, tension: 0.3 }
        ]
    },
    options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                mode: 'index', intersect: false,
                backgroundColor: 'rgba(13,13,24,0.92)', borderColor: '#1e1e30', borderWidth: 1,
                titleColor: '#555', bodyColor: '#aaa',
                titleFont: { family: 'SF Mono, Fira Code, monospace', size: 10 },
                bodyFont:  { family: 'SF Mono, Fira Code, monospace', size: 11 },
                callbacks: {
                    title: items => items[0].parsed.x.toFixed(2) + 'y',
                    label: item  => ' ' + item.dataset.label + ': $' + item.parsed.y.toFixed(3),
                },
            },
        },
        scales: {
            x: { type: 'linear', min: 0, max: durationYears(), grid: { color: 'rgba(255,255,255,0.03)' },
                 ticks: { color: '#333', font: { family: 'SF Mono, Fira Code, monospace', size: 10 }, callback: fmtTime, maxTicksLimit: 6 } },
            y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' }, ticks: TICK_STYLE },
        }
    }
});

function updatePriceChart() {
    if (!priceArrays) return;
    const { collateral, yield: yieldArr, share, times } = priceArrays;
    priceChart.data.datasets[0].data = times.map((t, i) => ({ x: t, y: collateral[i] }));
    const ercPerYield = document.getElementById('btn-erc-per-yield').classList.contains('active');
    priceChart.data.datasets[1].data = times.map((t, i) => ({ x: t, y: ercPerYield ? share[i] : share[i] * yieldArr[i] }));
    priceChart.data.datasets[2].data = times.map((t, i) => ({ x: t, y: yieldArr[i] }));
    priceChart.options.scales.x.max  = durationYears();
    priceChart.options.scales.y.min  = undefined;
    priceChart.options.scales.y.max  = undefined;
    priceChart.update('none');
}

// ── Shared red cursor drawing ─────────────────────────────────────────
function drawTimeCursor(chart) {
    if (!priceArrays) return;
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;
    const t  = priceArrays.times[Math.min(Math.floor(playIdx), N_POINTS - 1)];
    const cx = scales.x.getPixelForValue(t);
    ctx.save();
    ctx.strokeStyle = '#d9534f';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx, chartArea.top);
    ctx.lineTo(cx, chartArea.bottom);
    ctx.stroke();
    ctx.fillStyle = '#d9534f';
    ctx.beginPath();
    ctx.arc(cx, chartArea.top + 5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

const priceChartPlugin = {
    id: 'priceChartCursor',
    afterDraw(chart) {
        if (chart.canvas.id === 'price-chart') drawTimeCursor(chart);
    }
};
Chart.register(priceChartPlugin);

// ── Position value chart ──────────────────────────────────────────────

const positionChartPlugin = {
    id: 'positionChartOverlays',
    afterDraw(chart) {
        if (chart.canvas.id !== 'position-chart') return;
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !simResult || !priceArrays) return;
        ctx.save();

        // Rebalance marker lines
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        for (const [times, color] of [
            [simResult.collateralRebalanceTimes, 'rgba(92,184,92,0.5)'],
            [simResult.ercRebalanceTimes,        'rgba(154,106,184,0.5)'],
        ]) {
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

        ctx.restore();
        drawTimeCursor(chart);
    }
};
Chart.register(positionChartPlugin);

const positionChart = new Chart(document.getElementById('position-chart'), {
    type: 'line',
    data: { datasets: [{ data: [], yAxisID: 'y', borderColor: '#5c9ab8', borderWidth: 1.5, backgroundColor: 'rgba(92,154,184,0.06)', fill: true, pointRadius: 0, tension: 0.3 }] },
    options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
            x: { type: 'linear', min: 0, max: 1, grid: { color: 'rgba(255,255,255,0.03)' },
                 ticks: { color: '#333', font: { family: 'SF Mono, Fira Code, monospace', size: 10 }, callback: fmtTime, maxTicksLimit: 6 } },
            y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' },
                 ticks: { color: '#333', font: { family: 'SF Mono, Fira Code, monospace', size: 10 }, callback: v => '$' + v.toFixed(0), maxTicksLimit: 5 } },
        }
    }
});

// ── Chart scrubbing (position + price charts) ─────────────────────────
{
    let dragging = false;

    function scrubChart(chartObj, canvas, e) {
        const rect    = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const { chartArea, scales } = chartObj;
        if (!chartArea) return;
        const x   = Math.max(chartArea.left, Math.min(chartArea.right, clientX - rect.left));
        const t   = scales.x.getValueForPixel(x);
        const dur = durationYears();
        playIdx   = Math.max(0, Math.min(N_POINTS - 1, Math.round(t / dur * (N_POINTS - 1))));
        renderFrame(Math.floor(playIdx));
    }

    for (const [chartObj, canvasId] of [[positionChart, 'position-chart'], [priceChart, 'price-chart']]) {
        const canvas = document.getElementById(canvasId);
        canvas.addEventListener('mousedown',  e => { dragging = true;  scrubChart(chartObj, canvas, e); });
        canvas.addEventListener('mousemove',  e => { if (dragging) scrubChart(chartObj, canvas, e); });
        canvas.addEventListener('touchstart', e => { dragging = true;  scrubChart(chartObj, canvas, e); }, { passive: true });
        canvas.addEventListener('touchmove',  e => { if (dragging) scrubChart(chartObj, canvas, e); }, { passive: true });
        canvas.style.cursor = 'crosshair';
    }
    document.addEventListener('mouseup',  () => { dragging = false; });
    document.addEventListener('touchend', () => { dragging = false; });
}

// ── Render frame at index i ───────────────────────────────────────────
function renderFrame(i) {
    if (!simResult || !priceArrays) return;
    i = Math.min(i, N_POINTS - 1);

    const cvUsd      = simResult.collateralValues[i];
    const debtUsd    = simResult.yieldTokenValues[i];
    const sharesUsd  = simResult.erc4626Values[i];
    const posUsd     = simResult.positionValues[i];
    const t          = priceArrays.times[i];

    // Bar chart auto-scale
    let chartMaxChanged = false;
    while (cvUsd >= CHART_MAX) { CHART_MAX *= 2; chartMaxChanged = true; }
    while (cvUsd < CHART_MAX * 0.25 && CHART_MAX > 200) { CHART_MAX /= 2; chartMaxChanged = true; }
    if (chartMaxChanged) rebuildGridlines();

    const yieldLeft = barPct(Math.max(cvUsd - debtUsd, 0));
    document.getElementById('flow-bar').style.width        = barPct(cvUsd);
    document.getElementById('flow-bar-text').textContent   = `${(cvUsd / priceArrays.collateral[i]).toFixed(2)} Collateral Token\n${usdS(cvUsd)}`;
    document.getElementById('pyusd-bar').style.left        = yieldLeft;
    document.getElementById('pyusd-bar').style.width       = barPct(debtUsd);
    document.getElementById('pyusd-bar-text').textContent  = `${(debtUsd / priceArrays.yield[i]).toFixed(2)} Yield Token\n${usdS(debtUsd)}`;
    document.getElementById('shares-bar').style.left       = yieldLeft;
    document.getElementById('shares-bar').style.width      = barPct(sharesUsd);
    document.getElementById('shares-bar-text').textContent = `${(sharesUsd / (priceArrays.share[i] * priceArrays.yield[i])).toFixed(2)} shares\n${(sharesUsd / priceArrays.yield[i]).toFixed(2)} yield token\n${usdS(sharesUsd)}`;

    // Position value display
    document.getElementById('position-val').textContent = usd(posUsd);

    const fmt = (pct, el) => {
        el.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        el.style.color = pct >= 0 ? '#5cb85c' : '#d9534f';
    };

    const currentReturn = (posUsd / simResult.positionValues[0] - 1) * 100;
    fmt(currentReturn, document.getElementById('pos-current-pct'));

    const finalReturn = (simResult.positionValues[N_POINTS - 1] / simResult.positionValues[0] - 1) * 100;
    fmt(finalReturn, document.getElementById('pos-total-pct'));


    // Position chart: show full precomputed trace, cursor draws the current position
    if (positionChart.data.datasets[0].data.length !== N_POINTS) {
        const allY  = simResult.positionValues;
        positionChart.data.datasets[0].data = simResult.positionValues.map((v, j) => ({ x: priceArrays.times[j], y: v }));
        positionChart.options.scales.y.min  = undefined;
        positionChart.options.scales.y.max  = undefined;
        positionChart.options.scales.x.max  = durationYears();
    }
    positionChart.update('none');
    priceChart.update('none');

    updateThresholdLines();
    updateERC4626ThresholdLines();
}

// ── Play loop ─────────────────────────────────────────────────────────
function tick(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.1);
    lastTs = ts;

    const stepsPerSec = (N_POINTS - 1) / 10;  // always 10 seconds for full duration
    playIdx = Math.min(playIdx + dt * stepsPerSec, N_POINTS - 1);

    renderFrame(Math.floor(playIdx));

    if (playIdx < N_POINTS - 1) {
        rafId = requestAnimationFrame(tick);
    } else {
        playing = false;
        document.getElementById('btn-play').textContent = '\u25B6 Play';
    }
}

// ── Play / Reset ──────────────────────────────────────────────────────
document.getElementById('btn-play').addEventListener('click', () => {
    if (playIdx >= N_POINTS - 1) playIdx = 0; // restart if at end
    playing = !playing;
    document.getElementById('btn-play').textContent = playing ? '\u23F8 Pause' : '\u25B6 Play';
    if (playing) {
        lastTs = null;
        rafId  = requestAnimationFrame(tick);
    }
});

function resetSimulation() {
    playing = false;
    playIdx = 0;
    lastTs  = null;
    if (rafId) cancelAnimationFrame(rafId);
    document.getElementById('btn-play').textContent = '\u25B6 Play';

    CHART_MAX = 200;
    rebuildGridlines();
    recompute();
}

// ── Bar chart gridlines ───────────────────────────────────────────────
const gridContainer = document.getElementById('gridlines');
const xLabels       = document.getElementById('x-labels');

function rebuildGridlines() {
    gridContainer.querySelectorAll('.gridline').forEach(el => el.remove());
    xLabels.querySelectorAll('.x-label').forEach(el => el.remove());

    const step = CHART_MAX / 8;
    for (let i = 1; i <= 8; i++) {
        const val   = step * i;
        const pct   = (val / CHART_MAX * 100) + '%';
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
}

// ── Exponential fee mapping ───────────────────────────────────────────
function sliderToFee(v) { return (Math.pow(100, v / 100) - 1) / 99; }
function feeToSlider(f) { return 100 * Math.log(f * 99 + 1) / Math.log(100); }

function syncFeeSlider(slId, numId, onChange) {
    const sl  = document.getElementById(slId);
    const num = document.getElementById(numId);
    sl.addEventListener('input', () => {
        num.value = (sliderToFee(parseFloat(sl.value)) * 100).toFixed(2);
        onChange();
    });
    num.addEventListener('change', () => {
        const pct = parseFloat(num.value);
        if (!isNaN(pct)) sl.value = feeToSlider(Math.min(100, Math.max(0, pct)) / 100);
        sl.dispatchEvent(new Event('input'));
    });
}

// ── Price slider sync ─────────────────────────────────────────────────
function syncPriceControl(slId, numId, fmt) {
    const sl  = document.getElementById(slId);
    const num = document.getElementById(numId);
    sl.addEventListener('input',  () => { num.value = fmt(parseFloat(sl.value)); recompute(); });
    num.addEventListener('input', () => {
        const v = parseFloat(num.value);
        if (!isNaN(v)) sl.value = Math.min(parseFloat(sl.max), Math.max(parseFloat(sl.min), v));
        recompute();
        updateUrl();
        updateResetBtns();
    });
}

// ── Config listeners ──────────────────────────────────────────────────
['ltv-up', 'ltv-down'].forEach(suffix => {
    document.getElementById('num-' + suffix).addEventListener('input', e => {
        const v = parseInt(e.target.value);
        if (!isNaN(v)) document.getElementById('sl-' + suffix).value = Math.min(0.95, Math.max(0.5, v / 100));
        recompute(); updateUrl(); updateResetBtns();
    });
    document.getElementById('sl-' + suffix).addEventListener('input', e => {
        document.getElementById('num-' + suffix).value = Math.round(parseFloat(e.target.value) * 100);
        recompute();
    });
});

['sl-threshold-flow-up','sl-threshold-flow-down','sl-threshold-erc-up','sl-threshold-erc-down'].forEach(slId => {
    const numId = slId.replace('sl-', 'num-');
    document.getElementById(slId).addEventListener('input', e => {
        document.getElementById(numId).value = parseInt(e.target.value);
        recompute();
    });
    document.getElementById(numId).addEventListener('change', e => {
        const v = parseInt(e.target.value);
        if (!isNaN(v)) document.getElementById(slId).value = Math.min(20, Math.max(1, v));
        recompute(); updateUrl(); updateResetBtns();
    });
});

document.getElementById('sl-interval-flow').addEventListener('input', e => {
    document.getElementById('num-interval-flow').value = parseInt(e.target.value);
    recompute();
});
document.getElementById('num-interval-flow').addEventListener('change', e => {
    const v = parseInt(e.target.value);
    if (!isNaN(v)) document.getElementById('sl-interval-flow').value = Math.min(120, Math.max(1, v));
    recompute(); updateUrl(); updateResetBtns();
});
document.getElementById('sl-interval-erc').addEventListener('input', e => {
    document.getElementById('num-interval-erc').value = parseInt(e.target.value);
    recompute();
});
document.getElementById('num-interval-erc').addEventListener('change', e => {
    const v = parseInt(e.target.value);
    if (!isNaN(v)) document.getElementById('sl-interval-erc').value = Math.min(120, Math.max(1, v));
    recompute(); updateUrl(); updateResetBtns();
});

syncFeeSlider('sl-collateral-swap-fee', 'num-collateral-swap-fee', () => { recompute(); updateResetBtns(); });
syncFeeSlider('sl-erc-swap-fee',        'num-erc-swap-fee',        () => { recompute(); updateResetBtns(); });

// Duration sync
document.getElementById('sl-duration').addEventListener('input', e => {
    document.getElementById('num-duration').value = parseInt(e.target.value);
    recompute();
});
document.getElementById('num-duration').addEventListener('input', e => {
    const v = parseInt(e.target.value);
    if (!isNaN(v)) document.getElementById('sl-duration').value = Math.min(3650, Math.max(1, v));
    recompute(); updateUrl(); updateResetBtns();
});

syncPriceControl('sl-flow-seed',       'num-flow-seed',       v => Math.round(v));
syncPriceControl('sl-yield-seed',      'num-yield-seed',      v => Math.round(v));
syncPriceControl('sl-share-seed',      'num-share-seed',      v => Math.round(v));

syncPriceControl('sl-flow-history-offset',  'num-flow-history-offset',  v => Math.round(v));
syncPriceControl('sl-yield-history-offset', 'num-yield-history-offset', v => Math.round(v));
syncPriceControl('sl-share-history-offset', 'num-share-history-offset', v => Math.round(v));
syncPriceControl('sl-borrow-fee',      'num-borrow-fee',      v => Math.round(v));
syncPriceControl('sl-flow-sigma',      'num-flow-sigma',      v => Math.round(v));
syncPriceControl('sl-flow-lambda',     'num-flow-lambda',     v => Math.round(v));
syncPriceControl('sl-flow-jump',       'num-flow-jump',       v => Math.round(v));
syncPriceControl('sl-yield-sigma',     'num-yield-sigma',     v => Math.round(v));
syncPriceControl('sl-yield-lambda',    'num-yield-lambda',    v => Math.round(v));
syncPriceControl('sl-yield-jump',      'num-yield-jump',      v => Math.round(v));
syncPriceControl('sl-share-sigma',     'num-share-sigma',     v => Math.round(v));
syncPriceControl('sl-share-lambda',    'num-share-lambda',    v => Math.round(v));
syncPriceControl('sl-share-jump',      'num-share-jump',      v => Math.round(v));
syncPriceControl('sl-drift',           'num-drift',           v => Math.round(v));
syncPriceControl('sl-period',          'num-period',          v => +v.toFixed(1));
syncPriceControl('sl-velocity',        'num-velocity',        v => Math.round(v));
syncPriceControl('sl-yield-drift',     'num-yield-drift',     v => Math.round(v));
syncPriceControl('sl-yield-period',    'num-yield-period',    v => +v.toFixed(1));
syncPriceControl('sl-yield-velocity',  'num-yield-velocity',  v => Math.round(v));
syncPriceControl('sl-share-drift',     'num-share-drift',     v => Math.round(v));
syncPriceControl('sl-share-period',    'num-share-period',    v => +v.toFixed(1));
syncPriceControl('sl-share-velocity',  'num-share-velocity',  v => Math.round(v));

// ── Toggle buttons ────────────────────────────────────────────────────
function setupToggle(btnId, onToggle) {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        if (onToggle) onToggle(btn.classList.contains('active'));
    });
}

function applyVolSelect(prefix, selId) {
    const v = document.getElementById(selId).value;
    document.getElementById(prefix + '-vol-period').classList.toggle('hidden',    v !== 'sine');
    document.getElementById(prefix + '-vol-amplitude').classList.toggle('hidden', v !== 'sine');
    document.getElementById(prefix + '-vol-sigma').classList.toggle('hidden',     v !== 'gbm' && v !== 'jump');
    document.getElementById(prefix + '-vol-lambda').classList.toggle('hidden',    v !== 'jump');
    document.getElementById(prefix + '-vol-jump').classList.toggle('hidden',      v !== 'jump');
    document.getElementById(prefix + '-vol-seed').classList.toggle('hidden',      v !== 'gbm' && v !== 'jump');
    document.getElementById(prefix + '-vol-history').classList.toggle('hidden',   !(v in HISTORY_DATA));
    document.getElementById(prefix + '-vol-drift').classList.toggle('dimmed',     v in HISTORY_DATA);
}

[['flow', 'sel-flow-vol'], ['yield', 'sel-yield-vol'], ['share', 'sel-share-vol']].forEach(([prefix, selId]) => {
    document.getElementById(selId).addEventListener('change', () => {
        applyVolSelect(prefix, selId);
        const canvas = document.getElementById('price-chart');
        canvas.style.height = '1px';
        setTimeout(() => { canvas.style.height = ''; priceChart.resize(); }, 50);
        recompute();
    });
    applyVolSelect(prefix, selId);
});

setupToggle('btn-erc-per-yield', () => { updatePriceChart(); });

setupToggle('btn-flow-rebalance', active => {
    document.getElementById('flow-rebalance-thresh').classList.toggle('dimmed', !active);
    document.getElementById('sl-threshold-flow-up').disabled   = !active;
    document.getElementById('sl-threshold-flow-down').disabled = !active;
    document.getElementById('sl-interval-flow').disabled  = !active;
    document.getElementById('num-interval-flow').disabled = !active;
    document.getElementById('num-interval-flow').closest('.flex').classList.toggle('dimmed', !active);
    recompute();
});
setupToggle('btn-share-rebalance', active => {
    document.getElementById('erc-rebalance-thresh').classList.toggle('dimmed', !active);
    document.getElementById('sl-threshold-erc-up').disabled   = !active;
    document.getElementById('sl-threshold-erc-down').disabled = !active;
    document.getElementById('sl-interval-erc').disabled   = !active;
    document.getElementById('num-interval-erc').disabled  = !active;
    document.getElementById('num-interval-erc').closest('.flex').classList.toggle('dimmed', !active);
    recompute();
});

// ── Chart resize on section expand ───────────────────────────────────
window.__resizePriceChart = () => {
    const canvas = document.getElementById('price-chart');
    canvas.style.height = '1px';
    setTimeout(() => { canvas.style.height = ''; priceChart.resize(); }, 50);
};

// ── URL sharing ───────────────────────────────────────────────────────
const SHARE_SLIDERS = ['sl-duration','sl-drift','sl-threshold-flow-up','sl-threshold-flow-down','sl-collateral-swap-fee','sl-period','sl-velocity',
                       'sl-yield-drift','sl-borrow-fee','sl-ltv-up','sl-ltv-down','sl-yield-period','sl-yield-velocity',
                       'sl-share-drift','sl-threshold-erc-up','sl-threshold-erc-down','sl-erc-swap-fee','sl-share-period','sl-share-velocity',
                       'sl-interval-flow','sl-interval-erc',
                       'sl-flow-sigma','sl-flow-lambda','sl-flow-jump',
                       'sl-yield-sigma','sl-yield-lambda','sl-yield-jump',
                       'sl-share-sigma','sl-share-lambda','sl-share-jump',
                       'sl-flow-seed','sl-yield-seed','sl-share-seed',
                       'sl-flow-history-offset','sl-yield-history-offset','sl-share-history-offset'];
const SHARE_TOGGLES = ['btn-flow-rebalance','btn-share-rebalance'];
const SHARE_SELECTS = ['sel-flow-vol','sel-yield-vol','sel-share-vol'];

const PROTOCOL_SLIDERS   = ['sl-threshold-flow-up', 'sl-threshold-flow-down', 'sl-threshold-erc-up', 'sl-threshold-erc-down', 'sl-interval-flow', 'sl-interval-erc', 'sl-ltv-up', 'sl-ltv-down'];
const PROTOCOL_TOGGLES   = ['btn-flow-rebalance', 'btn-share-rebalance'];
const PRICE_DATA_SLIDERS = ['sl-drift','sl-period','sl-velocity','sl-yield-drift','sl-yield-period','sl-yield-velocity','sl-share-drift','sl-share-period','sl-share-velocity','sl-flow-seed','sl-yield-seed','sl-share-seed'];
const PRICE_DATA_SELECTS = ['sel-flow-vol','sel-yield-vol','sel-share-vol'];
const FEE_SLIDERS        = ['sl-collateral-swap-fee','sl-erc-swap-fee','sl-borrow-fee'];

// Read the authoritative value for a slider — prefers the num input when present
function readParamValue(slId) {
    const numEl = document.getElementById(slId.replace('sl-', 'num-'));
    return numEl ? numEl.value : document.getElementById(slId).value;
}

// Write a value to a slider param — sets both the num input and the slider (no events fired)
function writeParamValue(slId, val) {
    const sl    = document.getElementById(slId);
    const numEl = document.getElementById(slId.replace('sl-', 'num-'));
    if (numEl) {
        numEl.value = val;
        let sv = parseFloat(val);
        if (slId === 'sl-ltv-up' || slId === 'sl-ltv-down') sv = sv / 100;
        else if (slId === 'sl-collateral-swap-fee' || slId === 'sl-erc-swap-fee') sv = feeToSlider(sv / 100);
        sl.value = Math.min(parseFloat(sl.max), Math.max(parseFloat(sl.min), sv));
    } else {
        sl.value = val;
    }
}

const PARAM_DEFAULTS  = Object.fromEntries(SHARE_SLIDERS.map(id => [id, readParamValue(id)]));
const TOGGLE_DEFAULTS = Object.fromEntries(SHARE_TOGGLES.map(id => [id, isActive(id)]));
const SELECT_DEFAULTS = Object.fromEntries(SHARE_SELECTS.map(id => [id, document.getElementById(id).value]));

function isAtDefaults(sliderIds, selectIds = [], toggleIds = []) {
    return sliderIds.every(id => readParamValue(id) === PARAM_DEFAULTS[id])
        && selectIds.every(id => document.getElementById(id).value === SELECT_DEFAULTS[id])
        && toggleIds.every(id => isActive(id) === TOGGLE_DEFAULTS[id]);
}

function updateResetBtns() {
    document.getElementById('btn-reset-price-data').disabled = isAtDefaults(PRICE_DATA_SLIDERS, PRICE_DATA_SELECTS);
    document.getElementById('btn-reset-fees').disabled       = isAtDefaults(FEE_SLIDERS);
    document.getElementById('btn-reset-protocol').disabled   = isAtDefaults(PROTOCOL_SLIDERS, [], PROTOCOL_TOGGLES);
}

document.getElementById('btn-reset-price-data').addEventListener('click', () => {
    PRICE_DATA_SLIDERS.forEach(id => writeParamValue(id, PARAM_DEFAULTS[id]));
    PRICE_DATA_SELECTS.forEach(id => { document.getElementById(id).value = SELECT_DEFAULTS[id]; document.getElementById(id).dispatchEvent(new Event('change')); });
    recompute(); updateUrl(); updateResetBtns();
});
document.getElementById('btn-reset-fees').addEventListener('click', () => {
    FEE_SLIDERS.forEach(id => writeParamValue(id, PARAM_DEFAULTS[id]));
    recompute(); updateUrl(); updateResetBtns();
});
document.getElementById('btn-reset-protocol').addEventListener('click', () => {
    PROTOCOL_SLIDERS.forEach(id => writeParamValue(id, PARAM_DEFAULTS[id]));
    PROTOCOL_TOGGLES.forEach(id => { if (isActive(id) !== TOGGLE_DEFAULTS[id]) document.getElementById(id).click(); });
    recompute(); updateUrl(); updateResetBtns();
});

function updateUrl() {
    const vd = {}, td = {}, sd = {};
    SHARE_SLIDERS.forEach((id, i) => { const v = readParamValue(id); if (v !== PARAM_DEFAULTS[id]) vd[i] = v; });
    SHARE_TOGGLES.forEach((id, i) => { const v = isActive(id); if (v !== TOGGLE_DEFAULTS[id]) td[i] = v ? 1 : 0; });
    SHARE_SELECTS.forEach((id, i) => { const v = document.getElementById(id).value; if (v !== SELECT_DEFAULTS[id]) sd[i] = v; });
    if (!Object.keys(vd).length && !Object.keys(td).length && !Object.keys(sd).length) {
        history.replaceState(null, '', location.pathname); return;
    }
    history.replaceState(null, '', `${location.pathname}?s=${btoa(JSON.stringify([vd, td, sd]))}`);
}

SHARE_SLIDERS.forEach(id => document.getElementById(id).addEventListener('input',  () => { updateUrl(); updateResetBtns(); }));
SHARE_TOGGLES.forEach(id => document.getElementById(id).addEventListener('click',  () => { updateUrl(); updateResetBtns(); }));
SHARE_SELECTS.forEach(id => document.getElementById(id).addEventListener('change', () => { updateUrl(); updateResetBtns(); }));

// Load state from base64-encoded URL param
const _raw = new URLSearchParams(location.search).get('s');
if (_raw) {
    try {
        const [vd, td, sd] = JSON.parse(atob(_raw));
        SHARE_SLIDERS.forEach((id, i) => { if (vd[i] != null) writeParamValue(id, vd[i]); });
        SHARE_TOGGLES.forEach((id, i) => { if (td[i] != null && (td[i] === 1) !== isActive(id)) document.getElementById(id).click(); });
        SHARE_SELECTS.forEach((id, i) => {
            if (sd[i] != null) document.getElementById(id).value = sd[i];
            document.getElementById(id).dispatchEvent(new Event('change'));
        });
    } catch (e) { /* invalid state, use defaults */ }
}

// ── Boot ──────────────────────────────────────────────────────────────
rebuildGridlines();
recompute();
setTimeout(updateResetBtns, 0);
updateUrl();
