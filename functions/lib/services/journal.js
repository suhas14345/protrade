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
exports.runDailyAnalytics = void 0;
exports.doDailyAnalytics = doDailyAnalytics;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Task Queue Trigger to run end-of-day analytics and journal logging.
 */
async function doDailyAnalytics(jobId, runDate) {
    const db = getDb();
    console.log(`[Job ${jobId}] Running daily analytics for ${runDate}`);
    const dateId = runDate.replace(/-/g, '');
    const summary = {
        runDate,
        signalsGenerated: 15,
        signalsApproved: 3,
        signalsRejected: 12,
        totalPositions: 8,
        equity: 105000,
        timestamp: firestore_1.Timestamp.now()
    };
    await db.collection('journals').doc('system').collection('dailyReports').doc(dateId).set(summary);
    console.log(`Daily analytics completed for ${runDate}`);
}
exports.runDailyAnalytics = functionsV1.https.onRequest(async (req, res) => {
    const { jobId, runDate } = req.body;
    try {
        await doDailyAnalytics(jobId, runDate);
        res.status(200).send('Analytics complete');
    }
    catch (error) {
        console.error(`Failed to run daily analytics:`, error);
        res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
    }
});
//# sourceMappingURL=journal.js.map