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
exports.probeInventory = exports.diagnostics = exports.downloadReport = void 0;
const functionsV1 = __importStar(require("firebase-functions"));
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0) {
        admin.initializeApp();
        const db = admin.firestore();
        db.settings({ ignoreUndefinedProperties: true });
        return db;
    }
    return admin.firestore();
};
const downloadReport = async (req, res) => {
    const { jobId } = req.query;
    if (!jobId) {
        res.status(400).send({ error: 'Missing jobId query parameter' });
        return;
    }
    const db = getDb();
    const snap = await db.collection('jobs').doc(jobId).collection('reports').doc('final').get();
    if (!snap.exists) {
        res.status(404).send({ error: 'Report not found for this job' });
        return;
    }
    const data = snap.data();
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="report_${jobId}.md"`);
    res.send(data.content);
};
exports.downloadReport = downloadReport;
exports.diagnostics = functionsV1.https.onRequest(async (req, res) => {
    const db = getDb();
    const { type = 'jobs' } = req.query;
    try {
        switch (type) {
            case 'jobs': {
                const { limit = 20 } = req.query;
                const finalLimit = Math.min(Math.max(Number(limit), 1), 100);
                const snap = await db.collection('jobs').orderBy('startedAt', 'desc').limit(finalLimit).get();
                const jobs = await Promise.all(snap.docs.map(async (doc) => {
                    const data = doc.data();
                    const reportSnap = await doc.ref.collection('reports').doc('final').get();
                    return Object.assign(Object.assign({ id: doc.id }, data), { hasReport: reportSnap.exists });
                }));
                res.json({ value: jobs, Count: jobs.length });
                break;
            }
            case 'errors': {
                const { limit = 50 } = req.query;
                const finalLimit = Math.min(Math.max(Number(limit), 1), 100);
                const snap = await db.collection('system_errors').orderBy('timestamp', 'desc').limit(finalLimit).get();
                const errors = snap.docs.map(doc => (Object.assign({ id: doc.id }, doc.data())));
                res.json({ value: errors, Count: errors.length });
                break;
            }
            case 'logs': {
                const { jobId, date, level } = req.query;
                const dateId = date ? date.replace(/-/g, '') : new Date().toISOString().split('T')[0].replace(/-/g, '');
                let query = db.collection('logs').doc(dateId).collection('entries');
                if (jobId)
                    query = query.where('metadata.jobId', '==', jobId);
                if (level)
                    query = query.where('level', '==', level);
                const snapshot = await query.limit(100).get();
                const logs = snapshot.docs.map((doc) => doc.data());
                res.json({ count: logs.length, jobId: jobId || 'all', date: dateId, level: level || 'all', logs });
                break;
            }
            case 'features': {
                const { symbol = 'NIFTY 50', colType = 'days', includeBar = 'false' } = req.query;
                const col = colType === 'weeks' ? 'weeks' : 'days';
                const snap = await db.collection('features').doc(symbol).collection(col).get();
                const lastDoc = snap.empty ? null : snap.docs[snap.docs.length - 1].data();
                let barData = null;
                if (includeBar === 'true' && !snap.empty) {
                    const lastDateId = snap.docs[snap.docs.length - 1].id;
                    const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(lastDateId).get();
                    if (barSnap.exists)
                        barData = barSnap.data();
                }
                res.json({ symbol, type: col, count: snap.size, last5: snap.docs.slice(-5).map(d => d.id), lastData: lastDoc, barData });
                break;
            }
            case 'bars': {
                const { symbol = 'NIFTY 50', colType = 'days' } = req.query;
                const col = colType === 'weeks' ? 'weeks' : 'days';
                const snap = await db.collection('barsD').doc(symbol).collection(col).get();
                res.json({ symbol, type: col, count: snap.size, last5: snap.docs.slice(-5).map(d => d.id) });
                break;
            }
            case 'universe': {
                const { universe = 'nifty500', limit = 1000 } = req.query;
                const snap = await db.collection('universes').doc(universe).collection('members').limit(Number(limit)).get();
                const members = snap.docs.map(d => d.id);
                res.json({ universe, totalInFirestore: members.length, members: members.slice(0, 50) });
                break;
            }
            case 'signals': {
                const { date, limit = 100, status = 'ORDERED' } = req.query;
                const dateId = date ? date.replace(/-/g, '') : new Date().toISOString().split('T')[0].replace(/-/g, '');
                let query = db.collection('signals').doc(dateId).collection('items');
                if (status !== 'all') {
                    query = query.where('status', '==', status);
                }
                const snap = await query.limit(Number(limit)).get();
                const signals = snap.docs.map((doc) => (Object.assign({ id: doc.id }, doc.data())));
                res.json({ dateId, count: signals.length, signals });
                break;
            }
            default:
                res.status(400).send({ error: `Unknown diagnostic type: ${type}` });
        }
    }
    catch (err) {
        console.error(`Diagnostics failed for ${type}:`, err);
        res.status(500).send({ error: 'Diagnostics failed', details: err.message });
    }
});
/**
 * Probes the market data repository to build a summary of historical data
 * available across all symbols, and signal lifecycle stats.
 */
exports.probeInventory = (0, https_1.onRequest)({ cors: true, invoker: 'public', memory: '1GiB', timeoutSeconds: 300 }, async (req, res) => {
    const db = getDb();
    const dateId = new Date().toISOString().split('T')[0].replace(/-/g, '');
    try {
        // 1. Symbol/Bars Inventory (Sampled)
        const symbolRefs = await db.collection('barsD').listDocuments();
        const inventoryMap = {};
        const BATCH_SIZE = 25;
        const sampleLimit = 250;
        const targetRefs = symbolRefs.slice(0, sampleLimit);
        for (let i = 0; i < targetRefs.length; i += BATCH_SIZE) {
            const chunk = targetRefs.slice(i, i + BATCH_SIZE);
            await Promise.all(chunk.map(async (ref) => {
                const daysSnap = await ref.collection('days').get();
                const count = daysSnap.size || 0;
                if (count > 0) {
                    inventoryMap[count] = (inventoryMap[count] || 0) + 1;
                }
            }));
        }
        const groupings = Object.entries(inventoryMap)
            .map(([bars, symbols]) => ({ bars: Number(bars), symbols }))
            .sort((a, b) => b.bars - a.bars);
        // 2. Signal Metrics for Today
        const signalsSnap = await db.collection('signals').doc(dateId).collection('items').get();
        const signalsByStrategy = {};
        const signalsByStatus = {};
        signalsSnap.docs.forEach(doc => {
            const data = doc.data();
            signalsByStrategy[data.strategy] = (signalsByStrategy[data.strategy] || 0) + 1;
            signalsByStatus[data.status] = (signalsByStatus[data.status] || 0) + 1;
        });
        const signalStats = {
            total: signalsSnap.size,
            byStrategy: Object.entries(signalsByStrategy).map(([name, count]) => ({ name, count })),
            byStatus: Object.entries(signalsByStatus).map(([name, count]) => ({ name, count })),
        };
        // 3. Universe Metadata
        const universeSnap = await db.collection('universes').get();
        const universes = await Promise.all(universeSnap.docs.map(async (d) => {
            const members = await d.ref.collection('members').count().get();
            return { id: d.id, count: members.data().count };
        }));
        res.status(200).json({
            groupings,
            totalSymbolsTracked: symbolRefs.length,
            sampleSize: targetRefs.length,
            signalStats,
            universes,
            timestamp: admin.firestore.Timestamp.now().toDate().toISOString()
        });
    }
    catch (err) {
        console.error('Probe Inventory failed:', err);
        res.status(500).send({ error: 'Failed to build inventory', details: err.message });
    }
});
//# sourceMappingURL=diag.js.map