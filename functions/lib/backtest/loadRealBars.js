"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadRealBars = loadRealBars;
/**
 * Real-data loader for the backtest engine.
 *
 * Reads daily OHLCV CSVs (yfinance format: `Date,Close,High,Low,Open,Volume`)
 * from a directory and returns them in the `SyntheticBar` shape the seeder
 * accepts. This is how Increment 2 (real-edge validation) feeds actual NSE
 * history into the exact same replay path as synthetic data — no broker login,
 * no credentials.
 *
 * The index file `^NSEI.csv` is mapped to INDEX_SYMBOL so the regime engine and
 * RS-ranking benchmark find it; stock files `SYMBOL.NS.csv` are mapped to the
 * bare NSE symbol (`SYMBOL`).
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const seed_1 = require("./seed");
/** Parse one yfinance CSV into in-range, ascending SyntheticBar[]. */
function parseCsv(file, startId, endId) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length < 2)
        return [];
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const iDate = header.indexOf('date');
    const iOpen = header.indexOf('open');
    const iHigh = header.indexOf('high');
    const iLow = header.indexOf('low');
    const iClose = header.indexOf('close');
    const iVol = header.indexOf('volume');
    if ([iDate, iOpen, iHigh, iLow, iClose, iClose].some((i) => i < 0))
        return [];
    const out = [];
    for (let r = 1; r < lines.length; r++) {
        const line = lines[r];
        if (!line)
            continue;
        const cols = line.split(',');
        const iso = (cols[iDate] || '').trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso))
            continue;
        const dateId = iso.replace(/-/g, '');
        if (dateId < startId || dateId > endId)
            continue;
        const open = Number(cols[iOpen]);
        const high = Number(cols[iHigh]);
        const low = Number(cols[iLow]);
        const close = Number(cols[iClose]);
        const volume = iVol >= 0 ? Number(cols[iVol]) : 0;
        // Skip rows with any non-finite OHLC (yfinance sometimes emits blanks).
        if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0))
            continue;
        out.push({
            dateId,
            isoDate: iso,
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
        });
    }
    out.sort((a, b) => (a.dateId < b.dateId ? -1 : a.dateId > b.dateId ? 1 : 0));
    return out;
}
/**
 * Load the index plus up to `maxSymbols` stock series from a CSV directory.
 * Throws if the index file is missing (the regime engine requires it).
 */
function loadRealBars(opts) {
    var _a, _b;
    const startId = opts.startISO.replace(/-/g, '');
    const endId = opts.endISO.replace(/-/g, '');
    const minBars = (_a = opts.minBars) !== null && _a !== void 0 ? _a : 250;
    const indexPath = path.join(opts.dataDir, '^NSEI.csv');
    if (!fs.existsSync(indexPath)) {
        throw new Error(`Index file not found: ${indexPath}. The regime/RS benchmark needs ^NSEI.`);
    }
    const indexBars = parseCsv(indexPath, startId, endId);
    if (indexBars.length < minBars) {
        throw new Error(`Index ^NSEI has only ${indexBars.length} bars in range (need >= ${minBars}).`);
    }
    const bars = { [seed_1.INDEX_SYMBOL]: indexBars };
    // Discover stock CSVs (everything except the index), deterministic order.
    const files = fs
        .readdirSync(opts.dataDir)
        .filter((f) => f.toLowerCase().endsWith('.csv') && f !== '^NSEI.csv')
        .sort();
    const candidates = [];
    for (const f of files) {
        const series = parseCsv(path.join(opts.dataDir, f), startId, endId);
        if (series.length < minBars)
            continue;
        // 'AXISBANK.NS.csv' -> 'AXISBANK'; strip trailing exchange suffix + .csv.
        const symbol = f.replace(/\.csv$/i, '').replace(/\.(NS|BO)$/i, '').toUpperCase();
        candidates.push({ symbol, series });
    }
    // Prefer the most-complete series when capping, keep a stable tie-break.
    candidates.sort((a, b) => b.series.length - a.series.length || (a.symbol < b.symbol ? -1 : 1));
    const chosen = opts.maxSymbols && opts.maxSymbols > 0 ? candidates.slice(0, opts.maxSymbols) : candidates;
    const symbols = [];
    for (const c of chosen) {
        bars[c.symbol] = c.series;
        symbols.push(c.symbol);
    }
    // Force-include any always-include symbols (e.g. metals ETFs) that the cap dropped,
    // so a small dedicated sleeve is never squeezed out of the universe by the cap.
    const force = new Set(((_b = opts.alwaysInclude) !== null && _b !== void 0 ? _b : []).map((s) => s.toUpperCase()));
    if (force.size > 0) {
        const already = new Set(symbols);
        for (const c of candidates) {
            if (force.has(c.symbol) && !already.has(c.symbol)) {
                bars[c.symbol] = c.series;
                symbols.push(c.symbol);
                already.add(c.symbol);
            }
        }
    }
    symbols.sort();
    return { bars, symbols };
}
//# sourceMappingURL=loadRealBars.js.map