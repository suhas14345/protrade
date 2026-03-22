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
const features_1 = require("../features");
const admin = __importStar(require("firebase-admin"));
// Mock technicalindicators
jest.mock('technicalindicators', () => ({
    EMA: { calculate: jest.fn(() => [110, 115]) },
    RSI: { calculate: jest.fn(() => [45, 52]) },
    ATR: { calculate: jest.fn(() => [2, 2.5]) },
    BollingerBands: { calculate: jest.fn(() => [{ middle: 112, lower: 108, upper: 116 }]) }
}));
// Mock logger
jest.mock('../logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));
describe('Features Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    it('should compute features correctly for a valid symbol', async () => {
        const { mockFirestore } = global;
        const mockBars = [
            { close: 100, high: 105, low: 95, volume: 1000, timestamp: admin.firestore.Timestamp.now() },
            { close: 110, high: 115, low: 105, volume: 1100, timestamp: admin.firestore.Timestamp.now() }
        ];
        mockFirestore.get
            .mockResolvedValueOnce({ exists: false }) // Initial skip check
            .mockResolvedValueOnce({ exists: false }) // lastFeatSnap check
            .mockResolvedValueOnce({
            empty: false,
            size: 30,
            docs: mockBars.map(b => ({ data: () => b, id: '20260321' }))
        }); // bars fetch
        await (0, features_1.doComputeFeatures)('test-job', 'RELIANCE.NS', '2026-03-21');
        // Assert features were saved
        expect(mockFirestore.collection).toHaveBeenCalledWith('features');
        expect(mockFirestore.set).toHaveBeenCalledWith(expect.objectContaining({
            ema20: 115,
            rsi14: 52,
            barsCount: 30
        }));
    });
    it('should skip if insufficient bars are found', async () => {
        const { mockFirestore } = global;
        mockFirestore.get
            .mockResolvedValueOnce({ exists: false })
            .mockResolvedValueOnce({ empty: false, size: 10, docs: [] }); // Only 10 bars
        await expect((0, features_1.doComputeFeatures)('test-job', 'SMALLCAP.NS', '2026-03-21'))
            .rejects.toThrow('Insufficient data');
    });
});
//# sourceMappingURL=features.test.js.map