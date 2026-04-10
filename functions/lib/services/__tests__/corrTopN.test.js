"use strict";
/**
 * Tests for corrTopN.ts — Pearson correlation engine & cluster helpers.
 * All Firestore calls are mocked via jest.setup.js global mockFirestore.
 */
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
// Mock firebase-admin (already done in jest.setup.js)
// Mock logger
jest.mock('../logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
// Mock runtime config
jest.mock('../../config/runtime', () => ({
    CORR_CONFIG: {
        THRESHOLD: 0.75,
        LOOKBACK_DAYS: 62,
        TOP_N: 20,
        MAX_POSITIONS_PER_CLUSTER: 2,
        MAX_CLUSTER_RISK_R: 1.5,
    }
}));
// We test pure math helpers by importing the module and calling exports
const corrTopN_1 = require("../corrTopN");
const admin = __importStar(require("firebase-admin"));
// ─── Pearson helper (tested via doComputeCorrTopN behaviour indirectly) ────────
describe('getClusterInfo', () => {
    let db;
    beforeEach(() => {
        jest.clearAllMocks();
        db = admin.firestore();
    });
    it('returns zero cluster when no open positions', async () => {
        const result = await (0, corrTopN_1.getClusterInfo)(db, 'RELIANCE.NS', [], '20260407', 5000);
        expect(result.clusterPositionCount).toBe(0);
        expect(result.clusterHeatR).toBe(0);
        expect(result.clusterSymbols).toEqual([]);
    });
    it('returns zero cluster when corrTopN doc does not exist', async () => {
        // mockFirestore.get returns { exists: false } by default
        const openPositions = [{ symbol: 'TCS.NS', riskAmount: 1000 }];
        const result = await (0, corrTopN_1.getClusterInfo)(db, 'INFY.NS', openPositions, '20260407', 5000);
        expect(result.clusterPositionCount).toBe(0);
        expect(result.clusterHeatR).toBe(0);
    });
    it('counts correlated open positions correctly', async () => {
        const { mockFirestore } = global;
        // Mock corrTopN doc: INFY has TCS as high-corr peer
        const corrDoc = {
            symbol: 'INFY.NS',
            topCorrelated: [
                { symbol: 'TCS.NS', corr: 0.88 },
                { symbol: 'WIPRO.NS', corr: 0.82 },
                { symbol: 'HCLTECH.NS', corr: 0.71 }, // below threshold — should be ignored
            ]
        };
        mockFirestore.get.mockResolvedValueOnce({ exists: true, data: () => corrDoc });
        const openPositions = [
            { symbol: 'TCS.NS', riskAmount: 2500 },
            { symbol: 'WIPRO.NS', riskAmount: 3000 },
            { symbol: 'HDFC.NS', riskAmount: 1000 }, // uncorrelated
        ];
        const result = await (0, corrTopN_1.getClusterInfo)(db, 'INFY.NS', openPositions, '20260407', 5000);
        expect(result.clusterPositionCount).toBe(2); // TCS + WIPRO
        expect(result.clusterSymbols).toContain('TCS.NS');
        expect(result.clusterSymbols).toContain('WIPRO.NS');
        expect(result.clusterSymbols).not.toContain('HDFC.NS');
        // clusterHeatR = (2500 + 3000) / 5000 = 1.1R
        expect(result.clusterHeatR).toBeCloseTo(1.1);
    });
    it('handles missing riskAmount on open positions gracefully', async () => {
        const { mockFirestore } = global;
        const corrDoc = {
            symbol: 'RELIANCE.NS',
            topCorrelated: [{ symbol: 'ONGC.NS', corr: 0.80 }]
        };
        mockFirestore.get.mockResolvedValueOnce({ exists: true, data: () => corrDoc });
        // Position with no riskAmount
        const openPositions = [{ symbol: 'ONGC.NS' }];
        const result = await (0, corrTopN_1.getClusterInfo)(db, 'RELIANCE.NS', openPositions, '20260407', 5000);
        expect(result.clusterPositionCount).toBe(1);
        expect(result.clusterHeatR).toBe(0); // undefined riskAmount → 0
    });
});
describe('loadCorrPeers', () => {
    let db;
    beforeEach(() => {
        jest.clearAllMocks();
        db = admin.firestore();
    });
    it('returns empty array when doc does not exist', async () => {
        const peers = await (0, corrTopN_1.loadCorrPeers)(db, 'RELIANCE.NS', '20260407');
        expect(peers).toEqual([]);
    });
    it('returns topCorrelated array from doc', async () => {
        const { mockFirestore } = global;
        const corrDoc = {
            topCorrelated: [{ symbol: 'TCS.NS', corr: 0.9 }]
        };
        mockFirestore.get.mockResolvedValueOnce({ exists: true, data: () => corrDoc });
        const peers = await (0, corrTopN_1.loadCorrPeers)(db, 'INFY.NS', '20260407');
        expect(peers).toHaveLength(1);
        expect(peers[0].symbol).toBe('TCS.NS');
        expect(peers[0].corr).toBe(0.9);
    });
});
//# sourceMappingURL=corrTopN.test.js.map