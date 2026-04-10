/**
 * Tests for corrTopN.ts — Pearson correlation engine & cluster helpers.
 * All Firestore calls are mocked via jest.setup.js global mockFirestore.
 */

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
import { getClusterInfo, loadCorrPeers, CorrPeer } from '../corrTopN';
import * as admin from 'firebase-admin';

// ─── Pearson helper (tested via doComputeCorrTopN behaviour indirectly) ────────

describe('getClusterInfo', () => {
  let db: any;

  beforeEach(() => {
    jest.clearAllMocks();
    db = (admin.firestore as any)();
  });

  it('returns zero cluster when no open positions', async () => {
    const result = await getClusterInfo(db, 'RELIANCE.NS', [], '20260407', 5000);
    expect(result.clusterPositionCount).toBe(0);
    expect(result.clusterHeatR).toBe(0);
    expect(result.clusterSymbols).toEqual([]);
  });

  it('returns zero cluster when corrTopN doc does not exist', async () => {
    // mockFirestore.get returns { exists: false } by default
    const openPositions = [{ symbol: 'TCS.NS', riskAmount: 1000 }];
    const result = await getClusterInfo(db, 'INFY.NS', openPositions, '20260407', 5000);
    expect(result.clusterPositionCount).toBe(0);
    expect(result.clusterHeatR).toBe(0);
  });

  it('counts correlated open positions correctly', async () => {
    const { mockFirestore } = global as any;

    // Mock corrTopN doc: INFY has TCS as high-corr peer
    const corrDoc = {
      symbol: 'INFY.NS',
      topCorrelated: [
        { symbol: 'TCS.NS', corr: 0.88 },
        { symbol: 'WIPRO.NS', corr: 0.82 },
        { symbol: 'HCLTECH.NS', corr: 0.71 }, // below threshold — should be ignored
      ] as CorrPeer[]
    };
    mockFirestore.get.mockResolvedValueOnce({ exists: true, data: () => corrDoc });

    const openPositions = [
      { symbol: 'TCS.NS', riskAmount: 2500 },
      { symbol: 'WIPRO.NS', riskAmount: 3000 },
      { symbol: 'HDFC.NS', riskAmount: 1000 }, // uncorrelated
    ];

    const result = await getClusterInfo(db, 'INFY.NS', openPositions, '20260407', 5000);

    expect(result.clusterPositionCount).toBe(2); // TCS + WIPRO
    expect(result.clusterSymbols).toContain('TCS.NS');
    expect(result.clusterSymbols).toContain('WIPRO.NS');
    expect(result.clusterSymbols).not.toContain('HDFC.NS');
    // clusterHeatR = (2500 + 3000) / 5000 = 1.1R
    expect(result.clusterHeatR).toBeCloseTo(1.1);
  });

  it('handles missing riskAmount on open positions gracefully', async () => {
    const { mockFirestore } = global as any;
    const corrDoc = {
      symbol: 'RELIANCE.NS',
      topCorrelated: [{ symbol: 'ONGC.NS', corr: 0.80 }] as CorrPeer[]
    };
    mockFirestore.get.mockResolvedValueOnce({ exists: true, data: () => corrDoc });

    // Position with no riskAmount
    const openPositions = [{ symbol: 'ONGC.NS' }];
    const result = await getClusterInfo(db, 'RELIANCE.NS', openPositions, '20260407', 5000);
    expect(result.clusterPositionCount).toBe(1);
    expect(result.clusterHeatR).toBe(0); // undefined riskAmount → 0
  });
});

describe('loadCorrPeers', () => {
  let db: any;

  beforeEach(() => {
    jest.clearAllMocks();
    db = (admin.firestore as any)();
  });

  it('returns empty array when doc does not exist', async () => {
    const peers = await loadCorrPeers(db, 'RELIANCE.NS', '20260407');
    expect(peers).toEqual([]);
  });

  it('returns topCorrelated array from doc', async () => {
    const { mockFirestore } = global as any;
    const corrDoc = {
      topCorrelated: [{ symbol: 'TCS.NS', corr: 0.9 }]
    };
    mockFirestore.get.mockResolvedValueOnce({ exists: true, data: () => corrDoc });

    const peers = await loadCorrPeers(db, 'INFY.NS', '20260407');
    expect(peers).toHaveLength(1);
    expect(peers[0].symbol).toBe('TCS.NS');
    expect(peers[0].corr).toBe(0.9);
  });
});
