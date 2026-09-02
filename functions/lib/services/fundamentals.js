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
exports.HttpFundamentalsSource = exports.FirestoreFundamentalsSource = void 0;
exports.doIngestFundamentals = doIngestFundamentals;
exports.doSyncFundamentals = doSyncFundamentals;
exports.getFundamentalsQuality = getFundamentalsQuality;
exports.updateFundamentalsSettings = updateFundamentalsSettings;
exports.getFundamentalsSettings = getFundamentalsSettings;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const earningsQuality_1 = require("./earningsQuality");
const eodhdAdapter_1 = require("./eodhdAdapter");
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Firestore-backed fundamentals source: reads canonical statements staged at
 * fundamentalsRaw/{symbol}. This is the swap-in behind FundamentalsSource until a live
 * XBRL/vendor adapter is added — statements are populated via the ingestFundamentals
 * action (script/manual/vendor export), keeping ingestion decoupled from scoring.
 */
class FirestoreFundamentalsSource {
    constructor() {
        this.name = 'firestore';
    }
    async fetchLatestStatement(symbol) {
        const snap = await getDb().collection('fundamentalsRaw').doc(symbol).get();
        return snap.exists ? snap.data() : null;
    }
}
exports.FirestoreFundamentalsSource = FirestoreFundamentalsSource;
/**
 * Config-driven HTTP vendor adapter: fetches a canonical FinancialStatement per symbol from
 * a provider configured at settings/fundamentals { url, apiKey }. The provider must return
 * JSON already in canonical shape (a thin server-side mapper per vendor keeps this generic).
 * `{symbol}` in the URL is substituted; the API key (if any) is sent as x-api-key. Fail-soft:
 * any missing config, network error, or non-canonical payload yields null (⇒ UNKNOWN), never
 * a throw and never fabricated data.
 */
class HttpFundamentalsSource {
    constructor(urlTemplate, apiKey) {
        this.urlTemplate = urlTemplate;
        this.apiKey = apiKey;
        this.name = 'http';
    }
    static async fromSettings() {
        const snap = await getDb().collection('settings').doc('fundamentals').get();
        const cfg = snap.exists ? snap.data() : null;
        if (!(cfg === null || cfg === void 0 ? void 0 : cfg.url))
            return null;
        return new HttpFundamentalsSource(cfg.url, cfg.apiKey);
    }
    async fetchLatestStatement(symbol) {
        try {
            const url = this.urlTemplate.replace('{symbol}', encodeURIComponent(symbol));
            const headers = { accept: 'application/json' };
            if (this.apiKey)
                headers['x-api-key'] = this.apiKey;
            const res = await fetch(url, { headers });
            if (!res.ok)
                return null;
            const data = (await res.json());
            if (!data || typeof data.period !== 'string' || typeof data.filedAt !== 'string')
                return null;
            return Object.assign(Object.assign({}, data), { symbol });
        }
        catch (_a) {
            return null;
        }
    }
}
exports.HttpFundamentalsSource = HttpFundamentalsSource;
/**
 * Ingest canonical financial statements into fundamentalsRaw/{symbol}. Point-in-time:
 * we never rewrite history silently — callers pass the as-reported figures + filedAt.
 */
async function doIngestFundamentals(req, res) {
    var _a, _b;
    const statements = ((_b = (_a = req.body) === null || _a === void 0 ? void 0 : _a.statements) !== null && _b !== void 0 ? _b : []);
    if (!Array.isArray(statements) || statements.length === 0) {
        res.status(400).send({ error: 'Body must include a non-empty "statements" array' });
        return;
    }
    const db = getDb();
    let written = 0;
    const skipped = [];
    // Firestore batches cap at 500 writes.
    for (let i = 0; i < statements.length; i += 400) {
        const batch = db.batch();
        for (const stmt of statements.slice(i, i + 400)) {
            if (!(stmt === null || stmt === void 0 ? void 0 : stmt.symbol)) {
                skipped.push(JSON.stringify(stmt).slice(0, 40));
                continue;
            }
            batch.set(db.collection('fundamentalsRaw').doc(stmt.symbol), stmt, { merge: true });
            written++;
        }
        await batch.commit();
    }
    await logger_1.logger.info(`[Fundamentals] Ingested ${written} statements`, 'Fundamentals', { written, skipped: skipped.length });
    res.status(200).send({ written, skipped });
}
/**
 * Compute earnings-quality for every symbol that has a staged raw statement and persist
 * the result to fundamentalsQuality/{symbol}. Non-gating: consumed as a dashboard badge.
 */
async function doSyncFundamentals(req, res) {
    var _a, _b, _c, _d;
    const db = getDb();
    const source = new FirestoreFundamentalsSource();
    // Optional: refresh fundamentalsRaw from the configured vendor first. Prefer EODHD when a
    // key is set, else the generic HTTP source. Symbols come from the request, else the universe.
    if ((_a = req.body) === null || _a === void 0 ? void 0 : _a.fromHttp) {
        const vendor = (_b = (await eodhdAdapter_1.EodhdFundamentalsSource.fromSettings())) !== null && _b !== void 0 ? _b : (await HttpFundamentalsSource.fromSettings());
        if (!vendor) {
            res.status(400).send({ error: 'No fundamentals vendor configured (settings/fundamentals eodhdApiKey or url)' });
            return;
        }
        const universeId = ((_c = req.body) === null || _c === void 0 ? void 0 : _c.universe) || 'midsmall400';
        let symbols = Array.isArray((_d = req.body) === null || _d === void 0 ? void 0 : _d.symbols) ? req.body.symbols : [];
        if (symbols.length === 0) {
            const memSnap = await db.collection('universes').doc(universeId).collection('members').get();
            symbols = memSnap.docs.map((d) => d.id);
        }
        let fetched = 0;
        for (let i = 0; i < symbols.length; i += 400) {
            const batch = db.batch();
            let inBatch = 0;
            for (const sym of symbols.slice(i, i + 400)) {
                const stmt = await vendor.fetchLatestStatement(sym);
                if (!stmt)
                    continue;
                batch.set(db.collection('fundamentalsRaw').doc(sym), stmt, { merge: true });
                fetched++;
                inBatch++;
            }
            if (inBatch > 0)
                await batch.commit();
        }
        await logger_1.logger.info(`[Fundamentals] ${vendor.name} refresh fetched ${fetched} statements`, 'Fundamentals', { fetched, vendor: vendor.name });
    }
    const rawSnap = await db.collection('fundamentalsRaw').get();
    const summary = { CLEAN: 0, WATCH: 0, FLAGGED: 0, UNKNOWN: 0 };
    let processed = 0;
    for (let i = 0; i < rawSnap.docs.length; i += 400) {
        const batch = db.batch();
        for (const doc of rawSnap.docs.slice(i, i + 400)) {
            const symbol = doc.id;
            const stmt = await source.fetchLatestStatement(symbol);
            if (!stmt)
                continue;
            const result = (0, earningsQuality_1.computeEarningsQuality)(stmt);
            const qualityDoc = {
                symbol,
                period: stmt.period,
                filedAt: stmt.filedAt,
                source: source.name,
                status: result.status,
                flags: result.flags,
                computedAt: firestore_1.Timestamp.now(),
            };
            batch.set(db.collection('fundamentalsQuality').doc(symbol), qualityDoc);
            summary[result.status] = (summary[result.status] || 0) + 1;
            processed++;
        }
        await batch.commit();
    }
    await logger_1.logger.info(`[Fundamentals] Synced quality for ${processed} symbols`, 'Fundamentals', summary);
    res.status(200).send({ processed, summary });
}
/**
 * Return all computed quality docs for the dashboard badge layer.
 */
async function getFundamentalsQuality(_req, res) {
    const snap = await getDb().collection('fundamentalsQuality').get();
    const items = snap.docs.map((d) => d.data());
    res.status(200).send({ count: items.length, items });
}
/**
 * Save the fundamentals vendor settings. The API key is written but never returned or logged.
 */
async function updateFundamentalsSettings(req, res) {
    var _a;
    const { eodhdApiKey, url, apiKey } = (_a = req.body) !== null && _a !== void 0 ? _a : {};
    const update = {};
    if (typeof eodhdApiKey === 'string' && eodhdApiKey.trim())
        update.eodhdApiKey = eodhdApiKey.trim();
    if (typeof url === 'string')
        update.url = url.trim();
    if (typeof apiKey === 'string' && apiKey.trim())
        update.apiKey = apiKey.trim();
    if (Object.keys(update).length === 0) {
        res.status(400).send({ error: 'Provide eodhdApiKey and/or url' });
        return;
    }
    await getDb().collection('settings').doc('fundamentals').set(update, { merge: true });
    res.status(200).send({ message: 'Fundamentals settings saved' });
}
/**
 * Report which vendor is configured WITHOUT ever returning the stored key.
 */
async function getFundamentalsSettings(_req, res) {
    const snap = await getDb().collection('settings').doc('fundamentals').get();
    const d = snap.exists ? snap.data() : {};
    res.status(200).send({ hasEodhd: !!d.eodhdApiKey, hasUrl: !!d.url });
}
//# sourceMappingURL=fundamentals.js.map