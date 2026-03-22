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
            rsi14: 45, // In pullback range 40-55
            atr14: 2,
            barsCount: 50,
            computedAt: admin.firestore.Timestamp.now()
        };
        const mockRegime = {
            marketState: 'TREND',
            tradeAllowed: true,
            riskMultiplier: 1.0,
            minSignalScore: 70
        };
        const mockBar = {
            id: '20260321',
            close: 98, // Touches/near EMA band [90, 100]
            high: 102,
            low: 95,
            timestamp: admin.firestore.Timestamp.now()
        };
        mockFirestore.get
            .mockResolvedValueOnce({ exists: false }) // existing sig check
            .mockResolvedValueOnce({ exists: true, data: () => mockFeatures }) // features fetch
            .mockResolvedValueOnce({ exists: true, data: () => mockRegime }) // regime fetch
            .mockResolvedValueOnce({
            empty: false,
            docs: [{ id: '20260321', data: () => mockBar }]
        }); // bars fetch
        await (0, strategy_1.doEvaluateSignals)('test-job', 'TCS.NS', '2026-03-21');
        // Assert signal was saved
        expect(mockFirestore.collection).toHaveBeenCalledWith('signals');
        expect(mockFirestore.doc).toHaveBeenCalledWith(expect.stringContaining('PullbackEOD'));
        expect(mockFirestore.set).toHaveBeenCalledWith(expect.objectContaining({
            direction: 'BUY',
            status: 'NEW'
        }));
    });
    it('should skip if trading is disabled by regime', async () => {
        const { mockFirestore } = global;
        const mockRegime = { tradeAllowed: false, marketState: 'BEAR' };
        mockFirestore.get
            .mockResolvedValueOnce({ exists: false }) // sig check
            .mockResolvedValueOnce({ exists: true, data: () => ({}) }) // features fetch
            .mockResolvedValueOnce({ exists: true, data: () => mockRegime }); // regime fetch
        await (0, strategy_1.doEvaluateSignals)('test-job', 'SBIN.NS', '2026-03-21');
        expect(mockFirestore.collection('signals').doc().collection('items').doc().set).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=strategy.test.js.map