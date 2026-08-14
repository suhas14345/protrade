"use strict";
/**
 * Deterministic synthetic OHLCV generator for engine validation.
 *
 * This produces reproducible price series so the replay engine, P&L loop and
 * metrics can be validated end-to-end WITHOUT any broker data or credentials.
 * It is NOT a source of edge — synthetic data only proves the machinery runs
 * and the numbers reconcile. Real-edge validation uses Kite historical data.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.tradingDates = tradingDates;
exports.generateSeries = generateSeries;
/** Small, fast, seedable PRNG (mulberry32) — deterministic across runs. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Box-Muller standard-normal draw from a uniform PRNG. */
function gaussian(rand) {
    let u = 0;
    let v = 0;
    while (u === 0)
        u = rand();
    while (v === 0)
        v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** All weekday dates in [startISO, endISO] as {dateId, isoDate}. Mirrors CalendarService weekend skip. */
function tradingDates(startISO, endISO) {
    const out = [];
    const cur = new Date(startISO + 'T00:00:00Z');
    const end = new Date(endISO + 'T00:00:00Z');
    while (cur <= end) {
        const dow = cur.getUTCDay();
        if (dow !== 0 && dow !== 6) {
            const iso = cur.toISOString().slice(0, 10);
            out.push({ isoDate: iso, dateId: iso.replace(/-/g, '') });
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}
/**
 * Generate a synthetic OHLCV series for one symbol across the given dates.
 * `seed` makes each symbol's path reproducible and independent.
 */
function generateSeries(seed, dates, opts) {
    var _a, _b, _c, _d;
    const rand = mulberry32(seed);
    const startPrice = (_a = opts === null || opts === void 0 ? void 0 : opts.startPrice) !== null && _a !== void 0 ? _a : 100 + rand() * 1900;
    const mu = (_b = opts === null || opts === void 0 ? void 0 : opts.annualDrift) !== null && _b !== void 0 ? _b : -0.05 + rand() * 0.35; // -5%..+30% drift
    const sigma = (_c = opts === null || opts === void 0 ? void 0 : opts.annualVol) !== null && _c !== void 0 ? _c : 0.18 + rand() * 0.30; // 18%..48% vol
    const baseVol = (_d = opts === null || opts === void 0 ? void 0 : opts.baseVolume) !== null && _d !== void 0 ? _d : 200000 + rand() * 5000000;
    const dtDrift = mu / 252;
    const dtVol = sigma / Math.sqrt(252);
    const bars = [];
    let prevClose = startPrice;
    for (const d of dates) {
        const ret = dtDrift + dtVol * gaussian(rand);
        const close = Math.max(1, prevClose * Math.exp(ret));
        const open = prevClose * (1 + (rand() - 0.5) * 0.01); // small overnight gap
        const intradayRange = Math.abs(close - open) + prevClose * dtVol * (0.5 + rand());
        const high = Math.max(open, close) + intradayRange * rand() * 0.5;
        const low = Math.min(open, close) - intradayRange * rand() * 0.5;
        const volume = Math.round(baseVol * (0.5 + rand()));
        bars.push({
            dateId: d.dateId,
            isoDate: d.isoDate,
            open: round2(open),
            high: round2(Math.max(high, open, close)),
            low: round2(Math.max(0.5, Math.min(low, open, close))),
            close: round2(close),
            volume,
        });
        prevClose = close;
    }
    return bars;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
//# sourceMappingURL=syntheticData.js.map