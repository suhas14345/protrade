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
exports.computeRsRankingTask = void 0;
exports.doComputeRsRanking = doComputeRsRanking;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const runtime_1 = require("../config/runtime");
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * V2.2: RS Ranking Engine
 *
 * Runs as a post-features pass across the entire universe.
 * Computes a 0-99 RS (Relative Strength) score for each symbol based on:
 *   composite = ret20d * RET20D_WEIGHT + ret60d * RET60D_WEIGHT
 *
 * Then ranks all symbols from lowest to highest and maps to 0-99.
 * Writes rsScore back into each features/{symbol}/days/{dateId} doc.
 * Also writes universeMedianRet20d + universeMedianRet60d into regime/{dateId}.
 *
 * This enables the strategy engine to filter: only trade rsScore >= MIN_RS_SCORE.
 */
async function doComputeRsRanking(dateId, jobId, universeId = 'nifty500') {
    var _a, _b, _c, _d, _e, _f;
    const db = getDb();
    await logger_1.logger.info(`[RSRank] Computing RS scores for ${dateId}`, 'RSRank', { dateId, jobId });
    // 1. Load all feature docs for this dateId
    const universeSnap = await db
        .collection('universes')
        .doc(universeId)
        .collection('members')
        .get();
    if (universeSnap.empty) {
        await logger_1.logger.warn('[RSRank] Universe is empty — skipping RS ranking', 'RSRank', { dateId });
        return;
    }
    const symbols = universeSnap.docs.map(d => d.id);
    // Fetch all features in parallel (chunked to avoid firestore query limits)
    const CHUNK_SIZE = 50;
    const symbolData = [];
    for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
        const chunk = symbols.slice(i, i + CHUNK_SIZE);
        const snaps = await Promise.all(chunk.map(sym => db.collection('features').doc(sym).collection('days').doc(dateId).get()));
        for (let j = 0; j < snaps.length; j++) {
            const snap = snaps[j];
            if (!snap.exists)
                continue;
            const data = snap.data();
            const ret20d = Number((_b = (_a = data === null || data === void 0 ? void 0 : data.returns) === null || _a === void 0 ? void 0 : _a.ret20d) !== null && _b !== void 0 ? _b : 0);
            const ret60d = Number((_d = (_c = data === null || data === void 0 ? void 0 : data.returns) === null || _c === void 0 ? void 0 : _c.ret60d) !== null && _d !== void 0 ? _d : 0);
            if (Number.isFinite(ret20d) && Number.isFinite(ret60d)) {
                symbolData.push({ symbol: chunk[j], ret20d, ret60d });
            }
        }
    }
    if (symbolData.length === 0) {
        await logger_1.logger.warn('[RSRank] No feature data found — skipping RS ranking', 'RSRank', { dateId });
        return;
    }
    // 2. Compute composite RS score and rank
    const composites = symbolData.map(s => ({
        symbol: s.symbol,
        composite: s.ret20d * runtime_1.RS_CONFIG.RET20D_WEIGHT + s.ret60d * runtime_1.RS_CONFIG.RET60D_WEIGHT,
        ret20d: s.ret20d,
        ret60d: s.ret60d,
    }));
    composites.sort((a, b) => a.composite - b.composite);
    const n = composites.length;
    // 3. Write rsScore (0-99) back to each features doc in batches
    const batchSize = 400; // Firestore batch limit is 500
    for (let i = 0; i < composites.length; i += batchSize) {
        const batch = db.batch();
        const chunk = composites.slice(i, i + batchSize);
        for (let j = 0; j < chunk.length; j++) {
            const globalIndex = i + j;
            const rsScore = Math.round((globalIndex / (n - 1)) * 99); // 0-99
            const ref = db.collection('features').doc(chunk[j].symbol).collection('days').doc(dateId);
            batch.update(ref, { rsScore });
        }
        await batch.commit();
    }
    // 4. Compute universe median returns and write to regime doc
    const ret20dValues = composites.map(c => c.ret20d).sort((a, b) => a - b);
    const ret60dValues = composites.map(c => c.ret60d).sort((a, b) => a - b);
    const midIdx = Math.floor(ret20dValues.length / 2);
    const universeMedianRet20d = (_e = ret20dValues[midIdx]) !== null && _e !== void 0 ? _e : 0;
    const universeMedianRet60d = (_f = ret60dValues[midIdx]) !== null && _f !== void 0 ? _f : 0;
    await db.collection('regime').doc(dateId).update({
        'breadth.universeMedianRet20d': universeMedianRet20d,
        'breadth.universeMedianRet60d': universeMedianRet60d,
        updatedAt: admin.firestore.Timestamp.now(),
    });
    await logger_1.logger.info(`[RSRank] Done. Ranked ${composites.length} symbols. ` +
        `MedianRet20d=${(universeMedianRet20d * 100).toFixed(2)}% ` +
        `MedianRet60d=${(universeMedianRet60d * 100).toFixed(2)}%`, 'RSRank', { dateId, count: composites.length });
    if (jobId) {
        await db.collection('jobs').doc(jobId).update({
            stage: 'RS_RANK',
            updatedAt: admin.firestore.Timestamp.now(),
        });
    }
}
exports.computeRsRankingTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId, jobId } = req.body || {};
    if (!dateId) {
        res.status(400).send('Missing dateId');
        return;
    }
    try {
        await doComputeRsRanking(String(dateId), jobId ? String(jobId) : undefined);
        res.status(200).send('RS ranking computed');
    }
    catch (error) {
        console.error('[RSRank] Failed:', error);
        res.status(500).send(error.message || 'Internal Error');
    }
});
//# sourceMappingURL=rsRanking.js.map