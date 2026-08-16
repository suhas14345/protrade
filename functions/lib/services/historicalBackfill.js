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
exports.runHistoricalBackfill = runHistoricalBackfill;
const admin = __importStar(require("firebase-admin"));
const marketdata_1 = require("./marketdata");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
function dateIdFromBar(bar) {
    const date = bar.timestamp.toDate();
    const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
    return `${ist.getUTCFullYear()}${String(ist.getUTCMonth() + 1).padStart(2, '0')}${String(ist.getUTCDate()).padStart(2, '0')}`;
}
async function writeBars(db, symbol, bars) {
    for (let i = 0; i < bars.length; i += 400) {
        const batch = db.batch();
        for (const bar of bars.slice(i, i + 400)) {
            batch.set(db.collection('barsD').doc(symbol).collection('days').doc(dateIdFromBar(bar)), Object.assign(Object.assign({}, bar), { dateId: dateIdFromBar(bar) }));
        }
        await batch.commit();
    }
    await db.collection('barsD').doc(symbol).set({
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        type: symbol === 'NIFTY 50' ? 'INDEX' : 'EQUITY',
    }, { merge: true });
}
/** True if the symbol already has history reaching back to the requested start (earliest bar at/before start + buffer). */
async function hasCoverage(db, symbol, startISO) {
    const start = new Date(startISO);
    start.setUTCDate(start.getUTCDate() + 10); // tolerate the first tradable day after a holiday/weekend gap
    const threshold = `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, '0')}${String(start.getUTCDate()).padStart(2, '0')}`;
    const earliest = await db.collection('barsD').doc(symbol).collection('days')
        .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
        .limit(1)
        .get();
    return !earliest.empty && earliest.docs[0].id <= threshold;
}
async function runHistoricalBackfill(opts) {
    var _a, _b;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.startISO) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.endISO)) {
        throw new Error('startISO and endISO must use YYYY-MM-DD');
    }
    if (opts.startISO > opts.endISO)
        throw new Error('startISO must be before endISO');
    const db = getDb();
    const settings = (await db.collection('settings').doc('kite').get()).data();
    if (!(settings === null || settings === void 0 ? void 0 : settings.apiKey) || !(settings === null || settings === void 0 ? void 0 : settings.accessToken) || settings.status === 'ERROR') {
        throw new Error('Kite session is not active; run scheduledKiteRenew first');
    }
    const skipExisting = opts.skipExisting !== false;
    const deadline = Date.now() + ((_a = opts.maxRuntimeMs) !== null && _a !== void 0 ? _a : 460000); // leave margin under the 540s function cap
    const members = await db.collection('universes').doc(opts.universeId).collection('members').get();
    const symbols = members.docs.map(doc => doc.id).slice(0, (_b = opts.maxSymbols) !== null && _b !== void 0 ? _b : 500);
    const instruments = await (0, marketdata_1.getNSEInstrumentsMap)(settings.apiKey, settings.accessToken);
    const targets = ['NIFTY 50', ...symbols.filter(symbol => symbol !== 'NIFTY 50')];
    let fetched = 0;
    let failed = 0;
    let skipped = 0;
    let bars = 0;
    let processed = 0;
    let lastSymbol = null;
    for (const symbol of targets) {
        if (Date.now() >= deadline) {
            console.warn(`[HistoricalBackfill] Time budget reached; resume after ${lastSymbol}`);
            break;
        }
        processed++;
        lastSymbol = symbol;
        try {
            if (skipExisting && await hasCoverage(db, symbol, opts.startISO)) {
                skipped++;
                continue;
            }
            const token = symbol === 'NIFTY 50'
                ? 256265
                : instruments.get(symbol.endsWith('.NS') ? symbol.slice(0, -3) : symbol);
            if (!token)
                throw new Error(`Instrument not found: ${symbol}`);
            const result = await (0, marketdata_1.fetchHistoricalBars)(symbol, opts.startISO, opts.endISO, settings.apiKey, settings.accessToken, token);
            await writeBars(db, symbol, result);
            fetched++;
            bars += result.length;
            console.log(`[HistoricalBackfill] ${symbol}: ${result.length} bars`);
        }
        catch (error) {
            failed++;
            console.error(`[HistoricalBackfill] ${symbol} failed:`, error instanceof Error ? error.message : String(error));
        }
    }
    const remaining = targets.length - processed;
    return { fetched, failed, skipped, bars, processed, remaining, done: remaining === 0, lastSymbol };
}
//# sourceMappingURL=historicalBackfill.js.map