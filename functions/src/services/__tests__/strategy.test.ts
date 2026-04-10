import { doEvaluateSignals } from '../strategy';
import * as admin from 'firebase-admin';

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
    const { mockFirestore } = global as any;
    const mockFeatures = {
      ema20: 100,
      ema50: 90,
      rsi14: 45, // In pullback range 40-55
      atr14: 2,
      barsCount: 50,
      rsScore: 65,        // Must be >= MIN_RS_SCORE (60) to pass risk approval
      gapRiskScore: 0.1,  // Well below reject threshold (0.8)
      vduActive: true,   // V3.0: VDU is now a hard gate for PullbackEOD
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
        .mockResolvedValueOnce({ exists: true, data: () => mockFeatures })   // features
        .mockResolvedValueOnce({ exists: true, data: () => mockRegime })     // regime
        .mockResolvedValueOnce({ exists: true, data: () => mockAccount })    // account
        .mockResolvedValueOnce({ empty: true, docs: [] })                    // openPositions
        .mockResolvedValueOnce({ empty: true, docs: [] })                    // existing signals query
        .mockResolvedValueOnce({                                             // bars query
          empty: false,
          docs: [{ id: '20260321', data: () => mockBar }]
        });
    // Default mock handles: event checks (all non-blocking), symbolMeta, calendar, corrTopN

    await doEvaluateSignals('test-job', 'TCS.NS', '2026-03-21');

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
    const { mockFirestore } = global as any;
    const mockRegime = { tradeAllowed: false, marketState: 'BEAR' };

    // Promise.all: features, regime, account, openPositions
    mockFirestore.get
        .mockResolvedValueOnce({ exists: true, data: () => ({}) })              // features
        .mockResolvedValueOnce({ exists: true, data: () => mockRegime })        // regime
        .mockResolvedValueOnce({ exists: true, data: () => ({ equity: 1000000, strategyRiskWeights: {} }) }) // account
        .mockResolvedValueOnce({ empty: true, docs: [] });                      // openPositions

    await doEvaluateSignals('test-job', 'SBIN.NS', '2026-03-21');

    // No signal with a trading direction should have been written
    expect(mockFirestore.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ direction: expect.any(String) })
    );
  });
});
