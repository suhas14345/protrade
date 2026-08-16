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
exports.runStaleCleanup = runStaleCleanup;
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
const DEFAULT_RETENTION = {
    logsDays: 30,
    jobsDays: 30,
    signalsDays: 90,
    regimeDays: 90,
    corrDays: 90,
    ordersDays: 180,
    fillsDays: 180,
    featuresDays: 120,
    alertsDays: 90,
};
/** YYYYMMDD cutoff `days` before today (UTC). Docs with an earlier id are purged. */
function cutoffDateId(days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function cutoffTimestamp(days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return admin.firestore.Timestamp.fromDate(d);
}
/** Delete date-partitioned docs (id === YYYYMMDD) older than the cutoff, including subcollections. */
async function purgeDateKeyed(db, collection, days) {
    const cutoff = cutoffDateId(days);
    const refs = await db.collection(collection).listDocuments();
    let deleted = 0;
    for (const ref of refs) {
        if (ref.id < cutoff) {
            await db.recursiveDelete(ref);
            deleted++;
        }
    }
    return deleted;
}
/** Delete top-level docs older than the cutoff by a timestamp field, including subcollections. */
async function purgeByTimestamp(db, collection, field, days) {
    const cutoff = cutoffTimestamp(days);
    const snap = await db.collection(collection).where(field, '<', cutoff).get();
    let deleted = 0;
    for (const doc of snap.docs) {
        await db.recursiveDelete(doc.ref);
        deleted++;
    }
    return deleted;
}
/** Delete old feature day-docs per symbol, preserving the symbol parent and barsD. */
async function purgeFeatures(db, days) {
    const cutoff = cutoffDateId(days);
    const symbols = await db.collection('features').listDocuments();
    let deleted = 0;
    for (const symbolRef of symbols) {
        const olddays = await symbolRef.collection('days')
            .where(admin.firestore.FieldPath.documentId(), '<', cutoff)
            .get();
        for (let i = 0; i < olddays.docs.length; i += 400) {
            const batch = db.batch();
            for (const doc of olddays.docs.slice(i, i + 400))
                batch.delete(doc.ref);
            await batch.commit();
            deleted += Math.min(400, olddays.docs.length - i);
        }
    }
    return deleted;
}
async function runStaleCleanup(overrides) {
    const db = getDb();
    const r = Object.assign(Object.assign({}, DEFAULT_RETENTION), overrides);
    const result = {};
    result.logs = await purgeDateKeyed(db, 'logs', r.logsDays);
    result.signals = await purgeDateKeyed(db, 'signals', r.signalsDays);
    result.regime = await purgeDateKeyed(db, 'regime', r.regimeDays);
    result.corrTopN = await purgeDateKeyed(db, 'corrTopN', r.corrDays);
    result.paperOrders = await purgeDateKeyed(db, 'paperOrders', r.ordersDays);
    result.paperFills = await purgeDateKeyed(db, 'paperFills', r.fillsDays);
    result.features = await purgeFeatures(db, r.featuresDays);
    result.jobs = await purgeByTimestamp(db, 'jobs', 'startedAt', r.jobsDays);
    result.alerts = await purgeByTimestamp(db, 'alerts', 'createdAt', r.alertsDays);
    result.system_errors = await purgeByTimestamp(db, 'system_errors', 'createdAt', r.alertsDays);
    return result;
}
//# sourceMappingURL=cleanupStale.js.map