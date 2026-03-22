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
exports.systemAnalysis = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
exports.systemAnalysis = (0, https_1.onRequest)({ cors: true }, async (req, res) => {
    const db = getDb();
    const date = req.query.date || '2026-03-17';
    const dateId = date.replace(/-/g, '');
    try {
        const regimeSnap = await db.collection('regime').doc(dateId).get();
        const regime = regimeSnap.data();
        const features = [];
        const featDocs = await db.collection('features').limit(40).get();
        for (const doc of featDocs.docs) {
            const symbol = doc.id;
            const daySnap = await doc.ref.collection('days').doc(dateId).get();
            if (daySnap.exists) {
                const featData = daySnap.data();
                const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
                features.push({
                    symbol,
                    features: featData,
                    bar: barSnap.exists ? barSnap.data() : null
                });
            }
        }
        res.json({
            date,
            regime,
            analysisCount: features.length,
            samples: features
        });
    }
    catch (err) {
        res.status(500).send(err instanceof Error ? err.message : String(err));
    }
});
//# sourceMappingURL=analysis.js.map