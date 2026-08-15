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
exports.manageTradesTask = void 0;
exports.doManageTrades = doManageTrades;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const calendar_1 = require("./calendar");
const runtime_1 = require("../config/runtime");
const barCache_1 = require("./barCache");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * V2.3: Get exit profile for a strategy (falls back to PullbackEOD defaults)
 */
function getExitProfile(strategy) {
    return runtime_1.EXIT_PROFILES[strategy || 'PullbackEOD'] || runtime_1.EXIT_PROFILES['PullbackEOD'];
}
/**
 * Manage existing OPEN positions with V2.3 per-strategy exit profiles
 */
async function doManageTrades(dateId, jobId) {
    const db = getDb();
    const positionsSnap = await db.collection('portfolio').doc('default').collection('positions')
        .where('status', '==', 'OPEN')
        .get();
    if (positionsSnap.empty)
        return;
    for (const doc of positionsSnap.docs) {
        const pos = doc.data();
        const symbol = pos.symbol;
        const profile = getExitProfile(pos.strategy);
        const currentBar = await (0, barCache_1.getBarOn)(db, symbol, dateId);
        if (!currentBar)
            continue;
        const currentClose = Number(currentBar.close);
        const currentHigh = Number(currentBar.high);
        const currentLow = Number(currentBar.low);
        const atrAtEntry = pos.atrAtEntry || 1.0;
        const priceDiff = pos.direction === 'BUY'
            ? (currentHigh - pos.avgEntryPrice)
            : (pos.avgEntryPrice - currentLow);
        const mfeAtr = Math.max(pos.mfeAtr || 0, priceDiff / atrAtEntry);
        // V2.3: Trailing stop logic (for Pullback and Breakout strategies)
        let currentStopPrice = pos.stopPrice;
        let trailingActive = pos.trailingStopActive || false;
        let trailingStopPrice = pos.trailingStopPrice || pos.stopPrice;
        if (profile.useTrailingStop && mfeAtr >= profile.trailingActivationAtr) {
            trailingActive = true;
            if (pos.direction === 'BUY') {
                const newTrail = currentHigh - (profile.trailingStopAtr * atrAtEntry);
                trailingStopPrice = Math.max(trailingStopPrice, newTrail);
                currentStopPrice = Math.max(currentStopPrice, trailingStopPrice);
            }
            else {
                const newTrail = currentLow + (profile.trailingStopAtr * atrAtEntry);
                trailingStopPrice = Math.min(trailingStopPrice, newTrail);
                currentStopPrice = Math.min(currentStopPrice, trailingStopPrice);
            }
        }
        await doc.ref.update({
            mfeAtr,
            stopPrice: currentStopPrice,
            trailingStopActive: trailingActive,
            trailingStopPrice: trailingActive ? trailingStopPrice : null,
            lastUpdatedAt: admin.firestore.Timestamp.now()
        });
        let exitTriggered = false;
        let exitType = undefined;
        // 1. Stop loss check (uses trailing stop if active)
        if (pos.direction === 'BUY' && currentClose <= currentStopPrice) {
            exitTriggered = true;
            exitType = 'EXIT_STOP';
        }
        else if (pos.direction === 'SELL' && currentClose >= currentStopPrice) {
            exitTriggered = true;
            exitType = 'EXIT_STOP';
        }
        // 2. Target check
        const targetPrice = pos.targets && pos.targets.length > 0 ? pos.targets[0] : null;
        if (!exitTriggered && targetPrice) {
            if (pos.direction === 'BUY' && currentClose >= targetPrice) {
                exitTriggered = true;
                exitType = 'EXIT_TARGET';
            }
            else if (pos.direction === 'SELL' && currentClose <= targetPrice) {
                exitTriggered = true;
                exitType = 'EXIT_TARGET';
            }
        }
        // 3. Time stop — per-strategy hold period
        if (!exitTriggered && pos.entryDateId) {
            const [entryDay, currentDay] = await Promise.all([
                calendar_1.CalendarService.getCalendarDay(pos.entryDateId),
                calendar_1.CalendarService.getCalendarDay(dateId)
            ]);
            if (entryDay && currentDay) {
                const heldDays = currentDay.tradingIndex - entryDay.tradingIndex;
                if (heldDays >= profile.timeStopDays) {
                    exitTriggered = true;
                    exitType = 'EXIT_TIME';
                }
            }
        }
        // 4. Partial profit — per-strategy thresholds
        if (!exitTriggered && !pos.partialTaken && mfeAtr >= profile.partialProfitAtr) {
            const partialQty = Math.floor(pos.qty * profile.partialFraction);
            if (partialQty > 0) {
                await queueExitOrder(db, pos, doc.ref.path, 'PARTIAL_PROFIT', dateId, jobId, true, partialQty);
                // Move stop to breakeven after partial
                await doc.ref.update({ partialTaken: true, stopPrice: pos.avgEntryPrice });
            }
        }
        if (exitTriggered) {
            await queueExitOrder(db, pos, doc.ref.path, exitType, dateId, jobId);
        }
    }
}
async function queueExitOrder(db, pos, posPath, type, dateId, jobId, isPartial = false, overrideQty) {
    const orderId = `EXIT_${pos.symbol}_${dateId}_${type}`;
    const qty = overrideQty !== null && overrideQty !== void 0 ? overrideQty : (isPartial ? Math.floor(pos.qty / 2) : pos.qty);
    if (qty <= 0)
        return;
    const exitOrder = {
        symbol: pos.symbol,
        orderType: 'EXIT',
        side: pos.direction === 'BUY' ? 'SELL' : 'BUY',
        intendedQty: qty,
        intendedEntryRef: 'OPEN',
        createdFromSignalId: pos.signalId || 'MANUAL',
        risk: {
            plannedR: 1,
            riskAmount: pos.riskAmount || 0,
            stopDistance: 0
        },
        status: 'ACCEPTED',
        exitType: type,
        parentPositionPath: posPath,
        createdAt: admin.firestore.Timestamp.now(),
        jobId
    };
    await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).set(exitOrder);
    console.log(`[TradeManager] Queued ${type} for ${pos.symbol} (Qty: ${qty}, Strategy: ${pos.strategy || 'legacy'})`);
}
exports.manageTradesTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId, jobId } = req.body || {};
    try {
        await doManageTrades(String(dateId), String(jobId));
        res.status(200).send('OK');
    }
    catch (e) {
        res.status(500).send(e.message);
    }
});
//# sourceMappingURL=tradeManager.js.map