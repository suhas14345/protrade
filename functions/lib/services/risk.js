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
exports.riskApproveTask = void 0;
exports.doRiskApproval = doRiskApproval;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Task Queue Trigger to approve/reject signals and generate Paper Orders.
 */
async function doRiskApproval(jobId, symbol, runDate, signalId) {
    var _a;
    const db = getDb();
    await logger_1.logger.info(`[Job ${jobId}] Risk approval for signal ${signalId}`, 'Risk', { jobId, signalId });
    const dateId = runDate.replace(/-/g, '');
    // Load Signal and Regime
    const sigSnap = await db.collection('signals').doc(dateId).collection('items').doc(signalId).get();
    const regimeSnap = await db.collection('regime').doc(dateId).get();
    if (!sigSnap.exists || !regimeSnap.exists) {
        await logger_1.logger.warn(`Signal or Regime not found for ${signalId}`, 'Risk', { jobId, signalId });
        return;
    }
    const signal = sigSnap.data();
    const regime = regimeSnap.data();
    // 1. Hard Gates
    if (!regime.tradeAllowed) {
        await sigSnap.ref.update({ status: 'REJECTED', reasons: Object.assign(Object.assign({}, signal.reasons), { rejection: 'Regime says tradeAllowed=false' }) });
        return;
    }
    // 3. Adaptive Sizing & Heat Limits
    const portfolioSnap = await db.collection('portfolio').doc('default').get();
    const portfolioData = portfolioSnap.exists ? portfolioSnap.data() : { equity: 1000000, openRiskR: 0 };
    const equity = (portfolioData === null || portfolioData === void 0 ? void 0 : portfolioData.equity) || 1000000;
    const openRiskR = (portfolioData === null || portfolioData === void 0 ? void 0 : portfolioData.openRiskR) || 0;
    // Set Heat Limits per Regime
    const heatLimits = {
        TREND: 4.0,
        RANGE: 3.0,
        BEAR: 3.0,
        HIGH_VOL: 2.0,
        TRANSITION: 0.0
    };
    const currentHeatLimit = heatLimits[regime.marketState] || 3.0;
    if (openRiskR >= currentHeatLimit) {
        await sigSnap.ref.update({ status: 'REJECTED', reasons: Object.assign(Object.assign({}, signal.reasons), { rejection: `Portfolio heat limit reached: ${openRiskR} >= ${currentHeatLimit}` }) });
        return;
    }
    const baseRiskPct = 0.005; // 0.5% risk per trade
    let riskBudget = equity * baseRiskPct * regime.riskMultiplier;
    // Volatility Safety Valve (Symbol Level)
    const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
    if (featSnap.exists) {
        const feat = featSnap.data();
        if (feat.atrp > 1.5 * (feat.atrpMa100 || feat.atrp || 0)) {
            riskBudget *= 0.5; // 50% reduction on spikes
            await logger_1.logger.info(`Risk reduced for ${symbol} due to ATRP spike: ${(_a = feat.atrp) === null || _a === void 0 ? void 0 : _a.toFixed(2)}`, 'Risk', { jobId, symbol });
        }
    }
    const entryPriceAssumption = signal.reasons.close || signal.stopPrice;
    const stopDistance = Math.abs(entryPriceAssumption - (signal.stopPrice || 0));
    const intendedQty = stopDistance > 0 ? Math.floor(riskBudget / stopDistance) : 0;
    const riskAmount = intendedQty * stopDistance;
    // 4. Create Paper Order
    if (intendedQty > 0) {
        const orderId = `ord_${signalId}`;
        const order = {
            symbol: signal.symbol,
            side: signal.direction,
            orderType: signal.entryPlan.type,
            intendedQty,
            intendedEntryRef: 'OPEN',
            createdFromSignalId: signalId,
            risk: {
                plannedR: 1,
                riskAmount,
                stopDistance
            },
            status: 'CREATED'
        };
        await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).set(order);
        await sigSnap.ref.update({ status: 'ORDERED' });
        await logger_1.logger.info(`Order ${orderId} created for ${symbol} with Qty ${intendedQty}`, 'Risk', { jobId, symbol, orderId });
    }
    else {
        await sigSnap.ref.update({ status: 'REJECTED', reasons: Object.assign(Object.assign({}, signal.reasons), { rejection: 'Qty evaluates to 0' }) });
    }
}
exports.riskApproveTask = functionsV1.https.onRequest(async (req, res) => {
    const { jobId, symbol, runDate, signalId } = req.body;
    try {
        await doRiskApproval(jobId, symbol, runDate, signalId);
        res.status(200).send('Risk approval complete');
    }
    catch (error) {
        console.error(`Failed risk approval for ${signalId}:`, error);
        res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
    }
});
//# sourceMappingURL=risk.js.map