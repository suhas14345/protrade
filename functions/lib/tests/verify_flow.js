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
const admin = __importStar(require("firebase-admin"));
const regime_1 = require("../services/regime");
const strategy_1 = require("../services/strategy");
const firestore_1 = require("firebase-admin/firestore");
async function runVerification() {
    if (admin.apps.length === 0)
        admin.initializeApp();
    const db = admin.firestore();
    const testDate = '2026-03-19';
    const dateId = testDate.replace(/-/g, '');
    const symbol = 'RELIANCE';
    const indexSymbol = 'NIFTY 50';
    console.log(`--- Starting Verification for ${testDate} ---`);
    // 1. Ensure Index Data exists
    console.log('Checking index features...');
    const featRef = db.collection('features').doc(indexSymbol).collection('days').doc(dateId);
    await featRef.set({
        ema20: 22000,
        ema50: 21500,
        ema200: 20000,
        atrp: 1.0,
        atrpMa100: 0.8,
        trendState: 'UP',
        computedAt: firestore_1.Timestamp.now()
    });
    console.log('Checking index bar...');
    const barRef = db.collection('barsD').doc(indexSymbol).collection('days').doc(dateId);
    await barRef.set({
        close: 22100,
        high: 22200,
        low: 22050,
        volume: 1000000,
        timestamp: firestore_1.Timestamp.now(),
        dateId
    });
    // 2. Trigger Regime Computation
    console.log('Triggering doComputeRegime...');
    const regime = await (0, regime_1.doComputeRegime)(testDate, 'test_job', indexSymbol);
    console.log('Regime Result:', JSON.stringify(regime, null, 2));
    if (regime.marketState === 'TRANSITION') {
        console.error('FAIL: Regime still in TRANSITION');
    }
    else {
        console.log('SUCCESS: Regime computed as', regime.marketState);
    }
    // 3. Ensure Symbol Data exists for Signal Generation
    console.log(`Setting up features for ${symbol}...`);
    await db.collection('features').doc(symbol).collection('days').doc(dateId).set({
        ema20: 2970,
        ema50: 2950,
        rsi14: 48,
        atr14: 50,
        bbLower: 2900,
        computedAt: firestore_1.Timestamp.now()
    });
    console.log(`Setting up bar for ${symbol}...`);
    await db.collection('barsD').doc(symbol).collection('days').doc(dateId).set({
        close: 2985,
        high: 3012,
        low: 2975,
        volume: 500000,
        timestamp: firestore_1.Timestamp.now(),
        dateId
    });
    // 4. Trigger Signal Evaluation
    console.log('Triggering doEvaluateSignals...');
    await (0, strategy_1.doEvaluateSignals)('test_job', symbol, testDate);
    // 5. Verify Signal in Firestore
    const sigSnap = await db.collection('signals').doc(dateId).collection('items').where('symbol', '==', symbol).get();
    if (sigSnap.empty) {
        console.error('FAIL: No signals generated');
    }
    else {
        console.log(`SUCCESS: ${sigSnap.size} signals generated for ${symbol}`);
        sigSnap.docs.forEach(d => console.log('Signal:', d.id, d.data().strategy));
    }
}
runVerification().catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
});
//# sourceMappingURL=verify_flow.js.map