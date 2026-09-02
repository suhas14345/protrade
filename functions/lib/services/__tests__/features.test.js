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
        // 30 bars so the >=25 guard passes; docs.length matches size (a real
        // Firestore snapshot can never report a size that disagrees with its docs).
        const mockBars = Array.from({ length: 30 }, (_, i) => ({
            close: 100 + i, high: 105 + i, low: 95 + i, volume: 1000 + i * 10,
            timestamp: admin.firestore.Timestamp.now(),
        }));
        mockFirestore.get
            .mockResolvedValueOnce({ exists: false }) // Initial skip check
            .mockResolvedValueOnce({ exists: false }) // lastFeatSnap check
            .mockResolvedValueOnce({
            empty: false,
            size: 30,
            docs: mockBars.map((b, i) => ({ data: () => b, id: `2026032${i % 10}` }))
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
    // Regression: features.ts used to write `rsScore: undefined`. Firestore rejects
    // undefined values unless ignoreUndefinedProperties is set, and in the live SEPA
    // init order it was not — so this aborted the FETCH stage and broke every EOD run.
    it('regression: never writes an undefined field (rsScore omitted until RS pass)', async () => {
        const { mockFirestore } = global;
        const mockBars = Array.from({ length: 30 }, (_, i) => ({
            close: 100 + i, high: 105 + i, low: 95 + i, volume: 1000 + i * 10,
            timestamp: admin.firestore.Timestamp.now(),
        }));
        mockFirestore.get
            .mockResolvedValueOnce({ exists: false })
            .mockResolvedValueOnce({ exists: false })
            .mockResolvedValueOnce({
            empty: false,
            size: 30,
            docs: mockBars.map((b, i) => ({ data: () => b, id: `2026032${i % 10}` })),
        });
        await (0, features_1.doComputeFeatures)('test-job', 'REGRESS.NS', '2026-03-21');
        const savedDoc = mockFirestore.set.mock.calls[mockFirestore.set.mock.calls.length - 1][0];
        const undefinedFields = Object.keys(savedDoc).filter((k) => savedDoc[k] === undefined);
        expect(undefinedFields).toEqual([]);
        expect(Object.prototype.hasOwnProperty.call(savedDoc, 'rsScore')).toBe(false);
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
describe('computeSma200Rising (adaptive 200-SMA slope)', () => {
    // A strictly rising series: the last-200 average always exceeds any earlier 200-window.
    const rising = (n) => Array.from({ length: n }, (_, i) => 100 + i);
    const falling = (n) => Array.from({ length: n }, (_, i) => 100 - i);
    it('detects a rising 200-SMA with only 212 bars (the real-world case)', () => {
        // Regression: the old `>= 200 + 20` guard returned false here, disabling all signals.
        expect((0, features_1.computeSma200Rising)(rising(212), 20)).toBe(true);
    });
    it('detects a rising 200-SMA at the full lookback', () => {
        expect((0, features_1.computeSma200Rising)(rising(260), 20)).toBe(true);
    });
    it('returns false for a falling 200-SMA', () => {
        expect((0, features_1.computeSma200Rising)(falling(240), 20)).toBe(false);
    });
    it('fails closed below the minimal slope window (< 205 bars)', () => {
        expect((0, features_1.computeSma200Rising)(rising(204), 20)).toBe(false);
        expect((0, features_1.computeSma200Rising)(rising(200), 20)).toBe(false);
    });
    it('caps the lookback at available history (adaptive)', () => {
        // 206 bars → effective lookback 6, still a valid rising check.
        expect((0, features_1.computeSma200Rising)(rising(206), 20)).toBe(true);
    });
});
describe('computeVcpVolumeDryUp', () => {
    const barsWithVolumes = (volumes) => volumes.map((volume) => ({ volume }));
    it('accepts a materially quieter, progressively drying final contraction before a high-volume breakout', () => {
        const volumes = [
            ...Array(40).fill(1000000),
            ...Array(5).fill(800000),
            ...Array(5).fill(500000),
            2000000,
        ];
        const result = (0, features_1.computeVcpVolumeDryUp)(barsWithVolumes(volumes));
        expect(result.passed).toBe(true);
        expect(result.ratio).toBeCloseTo(0.65);
    });
    it('rejects a trivial reduction that is not a meaningful dry-up', () => {
        const volumes = [
            ...Array(40).fill(1000000),
            ...Array(5).fill(990000),
            ...Array(5).fill(980000),
            2000000,
        ];
        expect((0, features_1.computeVcpVolumeDryUp)(barsWithVolumes(volumes)).passed).toBe(false);
    });
    it('rejects a final contraction whose volume increases into the pivot', () => {
        const volumes = [
            ...Array(40).fill(1000000),
            ...Array(5).fill(500000),
            ...Array(5).fill(800000),
            2000000,
        ];
        expect((0, features_1.computeVcpVolumeDryUp)(barsWithVolumes(volumes)).passed).toBe(false);
    });
    it('excludes the breakout bar from the dry-up calculation', () => {
        const volumes = [
            ...Array(40).fill(1000000),
            ...Array(5).fill(800000),
            ...Array(5).fill(500000),
            5000000,
        ];
        expect((0, features_1.computeVcpVolumeDryUp)(barsWithVolumes(volumes)).passed).toBe(true);
    });
});
//# sourceMappingURL=features.test.js.map