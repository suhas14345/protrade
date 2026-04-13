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
const strategy_1 = require("../strategy");
const admin = __importStar(require("firebase-admin"));
// Mock logger
jest.mock('../logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));
describe('Strategy Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    it('should generate a PullbackEOD signal when conditions match', async () => {
        const { mockFirestore } = global;
        const mockFeatures = {
            ema20: 100,
            ema50: 90,
            ema200: 80, // V3.2: Structural uptrend (ema50 90 > ema200 80)
            low20: 95, // V3.2: 20-day low; close 98 is ~3.2% above — within 0-5%
            rsi14: 45, // In pullback range 40-55
            atr14: 2,
            barsCount: 50,
            rsScore: 65, // Must be >= MIN_RS_SCORE (60) to pass risk approval
            gapRiskScore: 0.1, // Well below reject threshold (0.8)
            vduActive: true, // V3.0: VDU is now a hard gate for PullbackEOD
            computedAt: admin.firestore.Timestamp.now()
        };
        const mockRegime = {
            marketState: 'TREND',
            tradeAllowed: true,
            riskMultiplier: 1.0,
            minSignalScore: 70
        };
        const mockAccount = {
            equity: 1000000,
            peakEquity: 1000000,
            baseRiskPct: 0.005,
            maxPositions: 10,
            strategyRiskWeights: { PullbackEOD: 1.0 },
            equityEMA25: 900000
        };
        // Timestamp must match runDate for checkSafety staleness validation
        const runDateTimestamp = {
            toMillis: () => new Date('2026-03-21T10:00:00Z').getTime(),
            toDate: () => new Date('2026-03-21T10:00:00Z')
        };
        const mockBar = {
            id: '20260321',
            close: 98, // Between ema50 (90) and ema20 (100) — satisfies EMA band touch
            high: 102,
            low: 95,
            volume: 2000000,
            timestamp: runDateTimestamp
        };
        // Mock get call sequence (in order of execution):
        // 1. sentinelRef.create (handled by jest.setup)
        // Promise.all: [features, regime, account, openPositions]
        // After bars, all remaining gets (event checks, symbolMeta, calendar) use default mock
        mockFirestore.get
            .mockResolvedValueOnce({ exists: true, data: () => mockFeatures }) // features
            .mockResolvedValueOnce({ exists: true, data: () => mockRegime }) // regime
            .mockResolvedValueOnce({ exists: true, data: () => mockAccount }) // account
            .mockResolvedValueOnce({ empty: true, docs: [] }) // openPositions
            .mockResolvedValueOnce({ empty: true, docs: [] }) // existing signals query
            .mockResolvedValueOnce({
            empty: false,
            docs: [{ id: '20260321', data: () => mockBar }]
        });
        // Default mock handles: event checks (all non-blocking), symbolMeta, calendar, corrTopN
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        // Assert signal was saved under signals/{dateId}/items/{signalId}
        // signalId = "TCS.NS_20260321_PullbackEOD"
        expect(mockFirestore.collection).toHaveBeenCalledWith('signals');
        expect(mockFirestore.doc).toHaveBeenCalledWith(expect.stringContaining('PullbackEOD'));
        expect(mockFirestore.set).toHaveBeenCalledWith(expect.objectContaining({
            direction: 'BUY',
            status: 'APPROVED'
        }));
    });
    it('should skip if trading is disabled by regime', async () => {
        const { mockFirestore } = global;
        const mockRegime = { tradeAllowed: false, marketState: 'BEAR' };
        // Promise.all: features, regime, account, openPositions
        mockFirestore.get
            .mockResolvedValueOnce({ exists: true, data: () => ({}) }) // features
            .mockResolvedValueOnce({ exists: true, data: () => mockRegime }) // regime
            .mockResolvedValueOnce({ exists: true, data: () => ({ equity: 1000000, strategyRiskWeights: {} }) }) // account
            .mockResolvedValueOnce({ empty: true, docs: [] }); // openPositions
        await (0, strategy_1.doEvaluateSignals)('test-job', 'SBIN.NS', '2026-03-21');
        // No signal with a trading direction should have been written
        expect(mockFirestore.set).not.toHaveBeenCalledWith(expect.objectContaining({ direction: expect.any(String) }));
    });
    // ── V3.2 Regression: PullbackEOD gate tests ───────────────────────
    /**
     * Helper: builds a full mock chain for strategy evaluation.
     * Override individual fields to test specific gates.
     */
    function buildMockChain(overrides = {}) {
        const features = Object.assign({ ema20: 100, ema50: 90, ema200: 80, low20: 95, rsi14: 45, atr14: 2, barsCount: 50, rsScore: 65, gapRiskScore: 0.1, vduActive: true, computedAt: admin.firestore.Timestamp.now() }, overrides.features);
        const regime = Object.assign({ marketState: 'TREND', tradeAllowed: true, riskMultiplier: 1.0, minSignalScore: 70 }, overrides.regime);
        const account = {
            equity: 1000000, peakEquity: 1000000,
            baseRiskPct: 0.005, maxPositions: 10,
            strategyRiskWeights: { PullbackEOD: 1.0 },
            equityEMA25: 900000,
        };
        const ts = {
            toMillis: () => new Date('2026-03-21T10:00:00Z').getTime(),
            toDate: () => new Date('2026-03-21T10:00:00Z'),
        };
        const bar = Object.assign({ id: '20260321', close: 98, high: 102, low: 95, volume: 2000000, timestamp: ts }, overrides.bar);
        const { mockFirestore: mf } = global;
        mf.get
            .mockResolvedValueOnce({ exists: true, data: () => features }) // features
            .mockResolvedValueOnce({ exists: true, data: () => regime }) // regime
            .mockResolvedValueOnce({ exists: true, data: () => account }) // account
            .mockResolvedValueOnce({ empty: true, docs: [] }) // openPositions
            .mockResolvedValueOnce({ empty: true, docs: [] }) // existing signals
            .mockResolvedValueOnce({
            empty: false,
            docs: [{ id: '20260321', data: () => bar }],
        });
    }
    it('V3.2: rejects PullbackEOD when ema50 < ema200 (structural downtrend)', async () => {
        const { mockFirestore } = global;
        buildMockChain({
            features: { ema50: 80, ema200: 100 }, // ema50 < ema200
        });
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        // Signal should be REJECTED or not created as PullbackEOD
        // Check that no APPROVED PullbackEOD signal was set
        const setCalls = mockFirestore.set.mock.calls;
        const approvedPullback = setCalls.find((c) => { var _a, _b; return ((_a = c[0]) === null || _a === void 0 ? void 0 : _a.strategy) === 'PullbackEOD' && ((_b = c[0]) === null || _b === void 0 ? void 0 : _b.status) === 'APPROVED'; });
        expect(approvedPullback).toBeUndefined();
    });
    it('V3.2: rejects PullbackEOD when close is >5% above low20', async () => {
        const { mockFirestore } = global;
        buildMockChain({
            features: { low20: 80 }, // close 98 is 22.5% above low20 80 — way beyond 5%
            bar: { close: 98 },
        });
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        const setCalls = mockFirestore.set.mock.calls;
        const approvedPullback = setCalls.find((c) => { var _a, _b; return ((_a = c[0]) === null || _a === void 0 ? void 0 : _a.strategy) === 'PullbackEOD' && ((_b = c[0]) === null || _b === void 0 ? void 0 : _b.status) === 'APPROVED'; });
        expect(approvedPullback).toBeUndefined();
    });
    it('V3.2: rejects PullbackEOD when close is below low20', async () => {
        const { mockFirestore } = global;
        buildMockChain({
            features: { low20: 100 }, // close 98 is below low20 100
            bar: { close: 98 },
        });
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        const setCalls = mockFirestore.set.mock.calls;
        const approvedPullback = setCalls.find((c) => { var _a, _b; return ((_a = c[0]) === null || _a === void 0 ? void 0 : _a.strategy) === 'PullbackEOD' && ((_b = c[0]) === null || _b === void 0 ? void 0 : _b.status) === 'APPROVED'; });
        expect(approvedPullback).toBeUndefined();
    });
    it('V3.2: allows PullbackEOD in BEAR regime with bucket A liquidity', async () => {
        const { mockFirestore } = global;
        buildMockChain({
            features: {
                liquidity: { bucket: 'A', medVol20: 500000 },
            },
            regime: { marketState: 'BEAR', tradeAllowed: true, riskMultiplier: 0.5, minSignalScore: 70 },
        });
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        // With BEAR + bucket A + all other gates passing, a signal should be created
        // (may be APPROVED or REJECTED_BY_RISK depending on score — but at least a signal doc)
        expect(mockFirestore.set).toHaveBeenCalled();
    });
    it('V3.2: rejects PullbackEOD in BEAR regime with bucket B (bear_liquidity gate)', async () => {
        const { mockFirestore } = global;
        buildMockChain({
            features: {
                liquidity: { bucket: 'B', medVol20: 500000 },
            },
            regime: { marketState: 'BEAR', tradeAllowed: true, riskMultiplier: 0.5, minSignalScore: 70 },
        });
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        const setCalls = mockFirestore.set.mock.calls;
        const approvedPullback = setCalls.find((c) => { var _a, _b; return ((_a = c[0]) === null || _a === void 0 ? void 0 : _a.strategy) === 'PullbackEOD' && ((_b = c[0]) === null || _b === void 0 ? void 0 : _b.status) === 'APPROVED'; });
        expect(approvedPullback).toBeUndefined();
    });
    it('V3.2: rejects PullbackEOD in BEAR regime with bucket C', async () => {
        const { mockFirestore } = global;
        buildMockChain({
            features: {
                liquidity: { bucket: 'C', medVol20: 100000 },
            },
            regime: { marketState: 'BEAR', tradeAllowed: true, riskMultiplier: 0.5, minSignalScore: 70 },
        });
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        const setCalls = mockFirestore.set.mock.calls;
        const approvedPullback = setCalls.find((c) => { var _a, _b; return ((_a = c[0]) === null || _a === void 0 ? void 0 : _a.strategy) === 'PullbackEOD' && ((_b = c[0]) === null || _b === void 0 ? void 0 : _b.status) === 'APPROVED'; });
        expect(approvedPullback).toBeUndefined();
    });
    it('V3.0: skips signal evaluation when RSI is unavailable (fail-closed)', async () => {
        const { mockFirestore } = global;
        buildMockChain({
            features: { rsi14: undefined }, // RSI unavailable
        });
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        // No signal should be created — RSI fail-closed should cause skip
        const setCalls = mockFirestore.set.mock.calls;
        const anySignal = setCalls.find((c) => { var _a, _b; return ((_a = c[0]) === null || _a === void 0 ? void 0 : _a.strategy) && ((_b = c[0]) === null || _b === void 0 ? void 0 : _b.direction); });
        expect(anySignal).toBeUndefined();
    });
    it('V3.0: rejects PullbackEOD when VDU is inactive (hard gate)', async () => {
        const { mockFirestore } = global;
        buildMockChain({
            features: { vduActive: false },
        });
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        const setCalls = mockFirestore.set.mock.calls;
        const approvedPullback = setCalls.find((c) => { var _a, _b; return ((_a = c[0]) === null || _a === void 0 ? void 0 : _a.strategy) === 'PullbackEOD' && ((_b = c[0]) === null || _b === void 0 ? void 0 : _b.status) === 'APPROVED'; });
        expect(approvedPullback).toBeUndefined();
    });
});
//# sourceMappingURL=strategy.test.js.map