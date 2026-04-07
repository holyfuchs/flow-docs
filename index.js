import init, { run_simulation as wasmRunSim, sim_single } from './wasm_pkg/rebalancer_sim.js';
import { FLOW_PRICES }     from './price_data/flow_prices.js';
import { ETHEREUM_PRICES } from './price_data/ethereum_prices.js';
import { BITCOIN_PRICES }  from './price_data/bitcoin_prices.js';
import { AAVE_PRICES }     from './price_data/aave_prices.js';
import { UNISWAP_PRICES }  from './price_data/uniswap_prices.js';
import { CHAINLINK_PRICES }from './price_data/chainlink_prices.js';
import { SOLANA_PRICES }   from './price_data/solana_prices.js';
import { MATIC_PRICES }    from './price_data/matic_prices.js';
import { MAKER_PRICES }    from './price_data/maker_prices.js';

const HISTORY_DATA = {
    'history-flow':     FLOW_PRICES,
    'history-eth':      ETHEREUM_PRICES,
    'history-btc':      BITCOIN_PRICES,
    'history-aave':     AAVE_PRICES,
    'history-uni':      UNISWAP_PRICES,
    'history-link':     CHAINLINK_PRICES,
    'history-sol':      SOLANA_PRICES,
    'history-matic':    MATIC_PRICES,
    'history-mkr':      MAKER_PRICES,
};

// ── WASM init ─────────────────────────────────────────────────────────
let wasmReady = false;
init({ module_or_path: './wasm_pkg/rebalancer_sim_bg.wasm' })
    .then(() => { wasmReady = true; recompute(); })
    .catch(e => console.error('[wasm] init failed:', e));

// ── Worker pool helpers ───────────────────────────────────────────────
const N_WORKERS = navigator.hardwareConcurrency || 4;
let _workerPool = null;

function getWorkerPool() {
    if (!_workerPool) {
        _workerPool = Array.from({ length: N_WORKERS }, () =>
            new Worker(new URL('./wasm_worker.js', import.meta.url), { type: 'module' })
        );
    }
    return _workerPool;
}

// Send a message to a worker and wait for its reply (matched by id).
function workerRpc(worker, msg, transfer = []) {
    return new Promise(resolve => {
        const id = Math.random();
        const handler = ({ data }) => {
            if (data.id !== id) return;
            worker.removeEventListener('message', handler);
            resolve(data);
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ ...msg, id }, transfer);
    });
}

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
let CHART_MAX = 1;
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
        yieldTokenThresholdUp:      numVal('num-threshold-erc-up')    / 100,
        yieldTokenThresholdDown:    numVal('num-threshold-erc-down')  / 100,
        collateralSwapFee:          numVal('num-collateral-swap-fee') / 100,
        yieldTokenSwapFee:          numVal('num-erc-swap-fee') / 100,
        borrowFeeAnnual:            numVal('num-borrow-fee') / 100,
        collateralRebalanceEnabled: isActive('btn-flow-rebalance'),
        yieldTokenRebalanceEnabled: isActive('btn-share-rebalance'),
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
        historyOffset: numVal('num-flow-history-offset'),
    }, N_POINTS, dt, parseInt(document.getElementById('sl-flow-seed').value) || 1);

    const yieldVol = document.getElementById('sel-yield-vol').value;
    const debtToken = genSeries(numVal('num-yield-drift') / 100, yieldVol, {
        period: numVal('num-yield-period') / 365.25,
        ampl:   numVal('num-yield-velocity') / 100,
        sigma:  numVal('num-yield-sigma') / 100,
        historyOffset: numVal('num-yield-history-offset'),
    }, N_POINTS, dt, parseInt(document.getElementById('sl-yield-seed').value) || 1);

    const shareVol = document.getElementById('sel-share-vol').value;
    const yieldToken = genSeries(numVal('num-share-drift') / 100, shareVol, {
        period: numVal('num-share-period') / 365.25,
        ampl:   numVal('num-share-velocity') / 100,
        sigma:  numVal('num-share-sigma') / 100,
        historyOffset: numVal('num-share-history-offset'),
    }, N_POINTS, dt, parseInt(document.getElementById('sl-share-seed').value) || 1);

    return { collateral, debtToken, yieldToken, times };
}

// ── Recompute everything ──────────────────────────────────────────────
function recompute() {
    if (!wasmReady) return;
    priceArrays = generatePriceArrays();
    const settings = gatherSettings();
    const coll = new Float64Array(priceArrays.collateral);
    const dbt  = new Float64Array(priceArrays.debtToken);
    const yld  = new Float64Array(priceArrays.yieldToken);
    const n    = coll.length;
    const flat = wasmRunSim(
        coll, dbt, yld,
        settings.ltvUp, settings.ltvDown,
        settings.collateralThresholdUp, settings.collateralThresholdDown,
        settings.yieldTokenThresholdUp, settings.yieldTokenThresholdDown,
        settings.borrowFeeAnnual, settings.collateralSwapFee, settings.yieldTokenSwapFee,
        settings.durationYears,
        settings.collateralRebalanceEnabled,
        settings.yieldTokenRebalanceEnabled,
    );
    const dur = settings.durationYears;
    function flagsToTimes(flags) {
        const times = [];
        for (let i = 0; i < n; i++) { if (flags[i] === 1.0) times.push(i / (n - 1) * dur); }
        return times;
    }
    simResult = {
        collateralValues:         Array.from(flat.subarray(0,   n)),
        debtTokenValues:          Array.from(flat.subarray(n,   2*n)),
        yieldTokenValues:         Array.from(flat.subarray(2*n, 3*n)),
        positionValues:           Array.from(flat.subarray(3*n, 4*n)),
        collateralRebalanceTimes: flagsToTimes(flat.subarray(4*n, 5*n)),
        yieldTokenRebalanceTimes: flagsToTimes(flat.subarray(5*n, 6*n)),
    };
    // Force position chart to reload full dataset
    positionChart.data.datasets[0].data = [];
    updatePriceChart();
    renderFrame(Math.floor(playIdx));
}

// ── Threshold lines ───────────────────────────────────────────────────
function updateThresholdLines() {
    if (!simResult) return;
    const i       = Math.min(Math.floor(playIdx), N_POINTS - 1);
    const ltvUp   = numVal('num-ltv-up')   / 100;
    const ltvDown = numVal('num-ltv-down') / 100;
    const threshUp   = numVal('num-threshold-flow-up')   / 100;
    const threshDown = numVal('num-threshold-flow-down') / 100;
    const debtUsd = simResult.debtTokenValues[i];
    const upper   = (debtUsd * (1 + threshUp))   / ltvUp;
    const lower   = (debtUsd * (1 - threshDown)) / ltvDown;

    document.getElementById('threshold-line-upper').style.left   = Math.min(upper / CHART_MAX * 100, 100) + '%';
    document.getElementById('threshold-label-upper').style.left  = Math.min(upper / CHART_MAX * 100, 100) + '%';
    document.getElementById('threshold-label-upper').textContent = usdInt(upper);
    document.getElementById('threshold-line-lower').style.left   = Math.max(lower / CHART_MAX * 100, 0)  + '%';
    document.getElementById('threshold-label-lower').style.left  = Math.max(lower / CHART_MAX * 100, 0)  + '%';
    document.getElementById('threshold-label-lower').textContent = usdInt(lower);
}

function updateYieldTokenThresholdLines() {
    if (!simResult) return;
    const i       = Math.min(Math.floor(playIdx), N_POINTS - 1);
    const threshUp   = numVal('num-threshold-erc-up')   / 100;
    const threshDown = numVal('num-threshold-erc-down') / 100;
    const debtUsd = simResult.debtTokenValues[i];
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
    callback: v => v.toFixed(2),
    maxTicksLimit: 5,
};

const priceChart = new Chart(document.getElementById('price-chart'), {
    type: 'line',
    data: {
        datasets: [
            { label: 'Collateral', data: [], yAxisID: 'y', borderColor: '#5cb85c', borderWidth: 1.5, backgroundColor: 'rgba(92,184,92,0.06)',    fill: true, pointRadius: 0, tension: 0.3 },
            { label: 'Yield Token', data: [], yAxisID: 'y', borderColor: '#9a6ab8', borderWidth: 1.5, backgroundColor: 'rgba(154,106,184,0.06)', fill: true, pointRadius: 0, tension: 0.3 },
            { label: 'Debt',        data: [], yAxisID: 'y', borderColor: '#5c7db8', borderWidth: 1.5, backgroundColor: 'rgba(92,125,184,0.06)',  fill: true, pointRadius: 0, tension: 0.3 }
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
                    label: item  => {
                        const isYieldToken = item.datasetIndex === 1;
                        const perDebt = document.getElementById('btn-erc-per-yield').textContent.trim() === 'price per Debt Token';
                        const unit = (isYieldToken && perDebt) ? '' : '$';
                        return ' ' + item.dataset.label + ': ' + unit + item.parsed.y.toFixed(3);
                    },
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
    const { collateral, debtToken, yieldToken, times } = priceArrays;
    priceChart.data.datasets[0].data = times.map((t, i) => ({ x: t, y: collateral[i] }));
    const ercPerYield = document.getElementById('btn-erc-per-yield').textContent.trim() === 'price per Debt Token';
    priceChart.data.datasets[1].data = times.map((t, i) => ({ x: t, y: ercPerYield ? yieldToken[i] : yieldToken[i] * debtToken[i] }));
    priceChart.data.datasets[2].data = times.map((t, i) => ({ x: t, y: debtToken[i] }));
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
            [simResult.yieldTokenRebalanceTimes, 'rgba(154,106,184,0.5)'],
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
                 ticks: { color: '#333', font: { family: 'SF Mono, Fira Code, monospace', size: 10 }, callback: v => v.toFixed(2) + ' CT', maxTicksLimit: 5 } },
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
    const debtUsd    = simResult.debtTokenValues[i];
    const sharesUsd  = simResult.yieldTokenValues[i];
    const posUsd     = simResult.positionValues[i];

    // Bar chart auto-scale
    let chartMaxChanged = false;
    while (cvUsd >= CHART_MAX) { CHART_MAX *= 2; chartMaxChanged = true; }
    while (cvUsd < CHART_MAX * 0.25 && CHART_MAX > 1) { CHART_MAX /= 2; chartMaxChanged = true; }
    if (chartMaxChanged) rebuildGridlines();

    const yieldLeft = barPct(Math.max(cvUsd - debtUsd, 0));
    document.getElementById('flow-bar').style.width        = barPct(cvUsd);
    document.getElementById('flow-bar-text').textContent   = `${(cvUsd / priceArrays.collateral[i]).toFixed(2)} Collateral Token\n${usdS(cvUsd)}`;
    document.getElementById('pyusd-bar').style.left        = yieldLeft;
    document.getElementById('pyusd-bar').style.width       = barPct(debtUsd);
    document.getElementById('pyusd-bar-text').textContent  = `${(debtUsd / priceArrays.debtToken[i]).toFixed(2)} Debt Token\n${(debtUsd / priceArrays.collateral[i]).toFixed(2)} Collateral Token\n${usdS(debtUsd)}`;
    document.getElementById('shares-bar').style.left       = yieldLeft;
    document.getElementById('shares-bar').style.width      = barPct(sharesUsd);
    document.getElementById('shares-bar-text').textContent = `${(sharesUsd / (priceArrays.yieldToken[i] * priceArrays.debtToken[i])).toFixed(2)} Yield Token\n${(sharesUsd / priceArrays.debtToken[i]).toFixed(2)} Debt Token\n${usdS(sharesUsd)}`;

    // Position value display (in collateral tokens)
    const posCollateral = posUsd / priceArrays.collateral[i];
    document.getElementById('position-val').textContent = posCollateral.toFixed(2) + ' Collateral Token';

    const fmtPct = (pct, el) => {
        el.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        el.style.color = pct >= 0 ? '#5cb85c' : '#d9534f';
    };

    const initialCt = simResult.positionValues[0]            / priceArrays.collateral[0];
    const finalCt   = simResult.positionValues[N_POINTS - 1] / priceArrays.collateral[N_POINTS - 1];
    fmtPct((posCollateral / initialCt - 1) * 100, document.getElementById('pos-current-pct'));
    fmtPct((finalCt       / initialCt - 1) * 100, document.getElementById('pos-total-pct'));



    // Position chart: show full precomputed trace, cursor draws the current position
    if (positionChart.data.datasets[0].data.length !== N_POINTS) {
        positionChart.data.datasets[0].data = simResult.positionValues.map((v, j) => ({ x: priceArrays.times[j], y: v / priceArrays.collateral[j] }));
        positionChart.options.scales.y.min  = undefined;
        positionChart.options.scales.y.max  = undefined;
        positionChart.options.scales.x.max  = durationYears();
    }
    positionChart.update('none');
    priceChart.update('none');

    updateThresholdLines();
    updateYieldTokenThresholdLines();
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
syncPriceControl('sl-yield-sigma',     'num-yield-sigma',     v => Math.round(v));
syncPriceControl('sl-share-sigma',     'num-share-sigma',     v => Math.round(v));
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
    document.getElementById(prefix + '-vol-sigma').classList.toggle('hidden',     v !== 'gbm');
    document.getElementById(prefix + '-vol-seed').classList.toggle('hidden',      v !== 'gbm');
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

document.getElementById('btn-erc-per-yield').addEventListener('click', () => {
    const btn = document.getElementById('btn-erc-per-yield');
    const isPerDebt = btn.textContent.trim() === 'price per Debt Token';
    btn.textContent = isPerDebt ? 'price per $' : 'price per Debt Token';
    updatePriceChart();
});

setupToggle('btn-flow-rebalance', active => {
    document.getElementById('flow-rebalance-thresh').classList.toggle('dimmed', !active);
    document.getElementById('sl-threshold-flow-up').disabled   = !active;
    document.getElementById('sl-threshold-flow-down').disabled = !active;
    recompute();
});
setupToggle('btn-share-rebalance', active => {
    document.getElementById('erc-rebalance-thresh').classList.toggle('dimmed', !active);
    document.getElementById('sl-threshold-erc-up').disabled   = !active;
    document.getElementById('sl-threshold-erc-down').disabled = !active;
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
                       'sl-flow-sigma',
                       'sl-yield-sigma',
                       'sl-share-sigma',
                       'sl-flow-seed','sl-yield-seed','sl-share-seed',
                       'sl-flow-history-offset','sl-yield-history-offset','sl-share-history-offset'];
const SHARE_TOGGLES = ['btn-flow-rebalance','btn-share-rebalance'];
const SHARE_SELECTS = ['sel-flow-vol','sel-yield-vol','sel-share-vol'];

const PROTOCOL_SLIDERS   = ['sl-threshold-flow-up', 'sl-threshold-flow-down', 'sl-threshold-erc-up', 'sl-threshold-erc-down', 'sl-ltv-up', 'sl-ltv-down'];
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

// ── Protocol optimizer ────────────────────────────────────────────────
function isHistoryVol(volType) {
    return volType.startsWith('history-');
}
function hasRandomVol(volType) {
    return volType === 'gbm' || isHistoryVol(volType);
}

function generatePriceArraysForRun(runIdx, numRuns) {
    const dur    = durationYears();
    const dt     = dur / (N_POINTS - 1);
    const times  = Array.from({ length: N_POINTS }, (_, i) => i * dt);
    const daysNeeded = Math.max(2, Math.round(dur * 365.25));

    const flowVol  = document.getElementById('sel-flow-vol').value;
    const yieldVol = document.getElementById('sel-yield-vol').value;
    const shareVol = document.getElementById('sel-share-vol').value;

    // For history vols, pick a deterministic but pseudo-random window within
    // the available data so all runs use distinct, valid slices.
    function historyOffset(vol) {
        const prices = HISTORY_DATA[vol];
        const maxOffset = Math.max(0, prices.length - daysNeeded);
        if (maxOffset === 0) return 0;
        // Stratified: divide range into numRuns equal buckets
        const offset = Math.round(runIdx / numRuns * maxOffset);
        return offset;
    }

    function seedFor(vol, base)   { return hasRandomVol(vol) && !isHistoryVol(vol) ? base + runIdx : base; }
    function offsetFor(vol, base) { return isHistoryVol(vol) ? historyOffset(vol) : base; }

    const collateral = genSeries(numVal('num-drift') / 100, flowVol, {
        period: numVal('num-period') / 365.25, ampl: numVal('num-velocity') / 100,
        sigma: numVal('num-flow-sigma') / 100,
        historyOffset: offsetFor(flowVol, numVal('num-flow-history-offset')),
    }, N_POINTS, dt, seedFor(flowVol, parseInt(document.getElementById('sl-flow-seed').value) || 1));

    const debtToken = genSeries(numVal('num-yield-drift') / 100, yieldVol, {
        period: numVal('num-yield-period') / 365.25, ampl: numVal('num-yield-velocity') / 100,
        sigma: numVal('num-yield-sigma') / 100,
        historyOffset: offsetFor(yieldVol, numVal('num-yield-history-offset')),
    }, N_POINTS, dt, seedFor(yieldVol, parseInt(document.getElementById('sl-yield-seed').value) || 1));

    const yieldToken = genSeries(numVal('num-share-drift') / 100, shareVol, {
        period: numVal('num-share-period') / 365.25, ampl: numVal('num-share-velocity') / 100,
        sigma: numVal('num-share-sigma') / 100,
        historyOffset: offsetFor(shareVol, numVal('num-share-history-offset')),
    }, N_POINTS, dt, seedFor(shareVol, parseInt(document.getElementById('sl-share-seed').value) || 1));

    return { collateral, debtToken, yieldToken, times };
}

async function runOptimize(opts) {
    const btn = document.getElementById('opt-run-btn');
    btn.textContent = '...';
    btn.disabled = true;
    const progressWrap = document.getElementById('opt-progress-wrap');
    const progressBar  = document.getElementById('opt-progress-bar');
    const progressLabel= document.getElementById('opt-progress-label');
    progressWrap.style.display = 'flex';
    progressBar.style.width = '0%';

    await new Promise(r => setTimeout(r, 10));
    {
        const base = gatherSettings();
        const { borrowFeeAnnual, collateralSwapFee, yieldTokenSwapFee } = base;
        const numRuns = opts.numRuns;

        // Build flat combo buffer once (6 f64 per combo)
        function buildComboBuffer(combos) {
            const buf = new Float64Array(combos.length * 6);
            combos.forEach((c, i) => {
                buf[i*6]   = c.lU;  buf[i*6+1] = c.lD;
                buf[i*6+2] = c.ctU; buf[i*6+3] = c.ctD;
                buf[i*6+4] = c.ytU; buf[i*6+5] = c.ytD;
            });
            return buf;
        }

        const shareVolFlat  = document.getElementById('sel-share-vol').value === 'none';
        const sharePositive = numVal('num-share-drift') >= 0;

        const { lUVals, lDVals, ctUVals, ctDVals, ytUVals, ytDVals } = getOptGrids(
            base, opts.ltvLevel, opts.collLevel, opts.yldLevel, shareVolFlat, sharePositive
        );

        const minLtv = (parseInt(document.getElementById('opt-min-ltv').value) || 90) / 100;

        // Build combos — enforce lD > lU and lD + ctD <= minLtv
        const combos = [];
        for (const lU of lUVals) for (const lD of lDVals)
        for (const ctU of ctUVals) for (const ctD of ctDVals)
        for (const ytU of ytUVals) for (const ytD of ytDVals) {
            if (lD <= lU) continue;
            if (lD + ctD > minLtv) continue;
            combos.push({ lU, lD, ctU, ctD, ytU, ytD });
        }

        // Split combos across workers — each worker owns its slice for the whole run
        const workers   = getWorkerPool();
        const nW        = workers.length;
        const comboBuf  = buildComboBuffer(combos);
        const chunkSize = Math.ceil(combos.length / nW);

        // Init each worker with its combo chunk (copied once)
        await Promise.all(workers.map((w, i) => {
            const start = i * chunkSize;
            const end   = Math.min(start + chunkSize, combos.length);
            if (start >= combos.length) return Promise.resolve();
            const chunk = comboBuf.slice(start * 6, end * 6);  // copy for transfer
            return workerRpc(w, {
                type: 'init', combos: chunk.buffer,
                borrowFee: borrowFeeAnnual, collFee: collateralSwapFee,
                ytFee: yieldTokenSwapFee, duration: base.durationYears,
            }, [chunk.buffer]);
        }));

        // Run each price path — all workers in parallel per path, cache arrays for default score
        const cachedPaths = [];
        for (let r = 0; r < numRuns; r++) {
            const arrays = generatePriceArraysForRun(r, numRuns);
            cachedPaths.push(arrays);
            const coll = new Float64Array(arrays.collateral).buffer;
            const dbt  = new Float64Array(arrays.debtToken).buffer;
            const yld  = new Float64Array(arrays.yieldToken).buffer;
            await Promise.all(workers.map(w =>
                workerRpc(w, { type: 'run_path', coll, debt: dbt, yield_: yld })
            ));
            progressBar.style.width  = ((r + 1) / numRuns * 100).toFixed(1) + '%';
            progressLabel.textContent = `Path ${r + 1} / ${numRuns}`;
            await new Promise(res => setTimeout(res, 0));
        }

        // Collect partial totals from each worker and merge
        const totals = new Float64Array(combos.length);
        await Promise.all(workers.map(async (w, i) => {
            const start = i * chunkSize;
            if (start >= combos.length) return;
            const { totals: buf } = await workerRpc(w, { type: 'get_totals' });
            const partial = new Float64Array(buf);
            for (let j = 0; j < partial.length; j++) totals[start + j] = partial[j];
        }));

        const allResults = combos.map((c, i) => ({ ...c, score: totals[i] / numRuns }));
        allResults.sort((a, b) => b.score - a.score);
        const best = allResults[0];

        const DEFAULT = { ltvUp: 0.80, ltvDown: 0.80, ctUp: 0.05, ctDown: 0.05, ytUp: 0.05, ytDown: 0.05 };
        let defaultTotal = 0;
        for (let r = 0; r < numRuns; r++) {
            const { collateral, debtToken, yieldToken } = cachedPaths[r];
            defaultTotal += sim_single(
                new Float64Array(collateral), new Float64Array(debtToken), new Float64Array(yieldToken),
                DEFAULT.ltvUp, DEFAULT.ltvDown, DEFAULT.ctUp, DEFAULT.ctDown, DEFAULT.ytUp, DEFAULT.ytDown,
                borrowFeeAnnual, collateralSwapFee, yieldTokenSwapFee, base.durationYears
            );
        }
        const defaultScore = defaultTotal / numRuns;

        // Ensure rebalancers are on
        if (!isActive('btn-flow-rebalance'))  document.getElementById('btn-flow-rebalance').click();
        if (!isActive('btn-share-rebalance')) document.getElementById('btn-share-rebalance').click();

        // Apply best settings to DOM
        writeParamValue('sl-ltv-up',              Math.round(best.lU  * 100));
        writeParamValue('sl-ltv-down',            Math.round(best.lD  * 100));
        writeParamValue('sl-threshold-flow-up',   Math.round(best.ctU * 100));
        writeParamValue('sl-threshold-flow-down', Math.round(best.ctD * 100));
        writeParamValue('sl-threshold-erc-up',    Math.round(best.ytU * 100));
        writeParamValue('sl-threshold-erc-down',  Math.round(best.ytD * 100));

        try {
            localStorage.setItem('optimize_results', JSON.stringify({
                results: allResults.slice(0, 1000),
                totalRuns: allResults.length,
                numPricePaths: numRuns,
                defaultScore,
            }));
            window.open('results.html', '_blank');
        } catch (e) {
            console.warn('localStorage quota exceeded, trimming results');
            localStorage.setItem('optimize_results', JSON.stringify({
                results: allResults.slice(0, 100),
                totalRuns: allResults.length,
                numPricePaths: numRuns,
            }));
            window.open('results.html', '_blank');
        }

        recompute(); updateUrl(); updateResetBtns();
        btn.textContent = '⚙ Run';
        btn.disabled = false;
        progressWrap.style.display = 'none';
        document.getElementById('optimize-dialog').style.display = 'none';
    }
}

// ── Opt level helpers ──────────────────────────────────────────────────
function getOptLevel(group) {
    const btn = document.querySelector(`.opt-level-group[data-opt-group="${group}"] .opt-lvl-active`);
    return btn ? btn.dataset.level : 'off';
}

const OPT_L_HIGH = [
    ...Array.from({ length: 9  }, (_, i) =>  i * 5 / 100),
    ...Array.from({ length: 60 }, (_, i) => (41 + i) / 100),
];
const OPT_L_MED  = Array.from({ length: 16 }, (_, i) => (20 + i * 5) / 100);
const OPT_L_LOW  = [0.50, 0.60, 0.70, 0.80, 0.90];

const OPT_T_HIGH = [
    ...Array.from({ length: 20 }, (_, i) => (i + 1) / 100),
    ...Array.from({ length: 16 }, (_, i) => (25 + i * 5) / 100),
];
const OPT_T_MED  = [0.01, 0.03, 0.05, 0.10, 0.15,0.20, 0.50, 1.00];
const OPT_T_LOW  = [0.01, 0.05, 0.20, 1.00];

const OPT_YT_HIGH = [
    ...Array.from({ length: 20 }, (_, i) => (i + 1) / 100),
    ...Array.from({ length: 16 }, (_, i) => (25 + i * 5) / 100),
];
const OPT_YT_MED  = [0.01, 0.03, 0.05, 0.10, 0.15,0.20, 0.50, 1.00];
const OPT_YT_LOW  = [0.01, 0.05, 0.20, 1.00];

function getOptGrids(base, ltvLevel, collLevel, yldLevel, shareVolFlat, sharePositive) {
    const lGrid = ltvLevel === 'high' ? OPT_L_HIGH : ltvLevel === 'med' ? OPT_L_MED : ltvLevel === 'low' ? OPT_L_LOW : null;
    const tGrid = collLevel === 'high' ? OPT_T_HIGH : collLevel === 'med' ? OPT_T_MED : collLevel === 'low' ? OPT_T_LOW : null;

    let ytGrid = null;
    if (yldLevel !== 'off') {
        const raw = yldLevel === 'high' ? OPT_YT_HIGH : yldLevel === 'med' ? OPT_YT_MED : OPT_YT_LOW;
        ytGrid = raw;
    }

    return {
        lUVals:  lGrid  ?? [base.ltvUp],
        lDVals:  lGrid  ?? [base.ltvDown],
        ctUVals: tGrid  ?? [base.collateralThresholdUp],
        ctDVals: tGrid  ?? [base.collateralThresholdDown],
        ytUVals: ytGrid ? (shareVolFlat && !sharePositive ? [0.20] : ytGrid) : [base.yieldTokenThresholdUp],
        ytDVals: ytGrid ? (shareVolFlat &&  sharePositive ? [0.20] : ytGrid) : [base.yieldTokenThresholdDown],
    };
}

// ── Combo counter ─────────────────────────────────────────────────────
function countOptCombos() {
    const base         = gatherSettings();
    const minLtv       = (parseInt(document.getElementById('opt-min-ltv').value) || 90) / 100;
    const shareVolFlat = document.getElementById('sel-share-vol').value === 'none';
    const sharePositive = numVal('num-share-drift') >= 0;

    const { lUVals, lDVals, ctUVals, ctDVals, ytUVals, ytDVals } = getOptGrids(
        base, getOptLevel('ltv'), getOptLevel('coll'), getOptLevel('yld'), shareVolFlat, sharePositive
    );

    // Math-based count: avoid 6-nested loops
    // Valid triples: lD > lU and lD + ctD <= minLtv
    // For each (lD, ctD) pair, count lU values < lD
    const lUSorted = [...lUVals].sort((a, b) => a - b);
    let validTriples = 0;
    for (const lD of lDVals) {
        // binary search: count lU < lD
        let lo = 0, hi = lUSorted.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; lUSorted[mid] < lD ? lo = mid + 1 : hi = mid; }
        const nLU = lo;
        if (nLU === 0) continue;
        for (const ctD of ctDVals) {
            if (lD + ctD > minLtv) continue;
            validTriples += nLU;
        }
    }
    const count = validTriples * ctUVals.length * ytUVals.length * ytDVals.length;

    const runs = parseInt(document.getElementById('opt-runs').value) || 1;
    const flowVol  = document.getElementById('sel-flow-vol').value;
    const yieldVol = document.getElementById('sel-yield-vol').value;
    const shareVol = document.getElementById('sel-share-vol').value;
    const hasRandom = hasRandomVol(flowVol) || hasRandomVol(yieldVol) || hasRandomVol(shareVol);
    const paths = hasRandom ? runs : 1;
    document.getElementById('opt-combo-count').textContent =
        `${count.toLocaleString()} combos × ${paths} path${paths > 1 ? 's' : ''} = ${(count * paths).toLocaleString()} simulations`;
}

// Build opt-level buttons
(function() {
    const DEFAULTS = { ltv: 'high', coll: 'med', yld: 'off' };
    document.querySelectorAll('.opt-level-group').forEach(group => {
        const grp = group.dataset.optGroup;
        ['off','low','med','high'].forEach(level => {
            const btn = document.createElement('button');
            btn.textContent = level;
            btn.dataset.level = level;
            btn.style.cssText = 'font-size:9px;padding:2px 7px;border:1px solid #333;background:transparent;color:#555;cursor:pointer;border-radius:2px;';
            if (level === DEFAULTS[grp]) {
                btn.style.borderColor = '#5c9ab8';
                btn.style.color = '#5c9ab8';
                btn.classList.add('opt-lvl-active');
            }
            btn.addEventListener('click', () => {
                group.querySelectorAll('button').forEach(b => {
                    b.style.borderColor = '#333'; b.style.color = '#555';
                    b.classList.remove('opt-lvl-active');
                });
                btn.style.borderColor = '#5c9ab8';
                btn.style.color = '#5c9ab8';
                btn.classList.add('opt-lvl-active');
                countOptCombos();
            });
            group.appendChild(btn);
        });
    });
})();

// Dialog open/close
document.getElementById('btn-optimize').addEventListener('click', e => {
    e.stopPropagation();
    const flowVol  = document.getElementById('sel-flow-vol').value;
    const yieldVol = document.getElementById('sel-yield-vol').value;
    const shareVol = document.getElementById('sel-share-vol').value;
    const hasRandom = hasRandomVol(flowVol) || hasRandomVol(yieldVol) || hasRandomVol(shareVol);
    const runsRow = document.getElementById('opt-runs-row');
    runsRow.style.display = hasRandom ? 'flex' : 'none';
    const hint = document.getElementById('opt-runs-hint');
    if (hasRandom) {
        const types = [flowVol, yieldVol, shareVol].filter(isHistoryVol).length > 0 ? 'history offsets' : 'seeds';
        hint.textContent = `different ${types} per run`;
    }
    document.getElementById('optimize-dialog').style.display = 'flex';
    countOptCombos();
});
document.getElementById('optimize-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});
['opt-min-ltv','opt-runs']
    .forEach(id => document.getElementById(id).addEventListener('change', countOptCombos));
document.getElementById('opt-run-btn').addEventListener('click', () => {
    const flowVol  = document.getElementById('sel-flow-vol').value;
    const yieldVol = document.getElementById('sel-yield-vol').value;
    const shareVol = document.getElementById('sel-share-vol').value;
    const hasRandom = hasRandomVol(flowVol) || hasRandomVol(yieldVol) || hasRandomVol(shareVol);
    runOptimize({
        ltvLevel:  getOptLevel('ltv'),
        collLevel: getOptLevel('coll'),
        yldLevel:  getOptLevel('yld'),
        numRuns:   hasRandom ? (parseInt(document.getElementById('opt-runs').value) || 1) : 1,
    });
});

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
