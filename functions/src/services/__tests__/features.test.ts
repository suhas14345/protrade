import { doComputeFeatures, computeSma200Rising, computeVcpVolumeDryUp } from '../features';
import * as admin from 'firebase-admin';

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
    const { mockFirestore } = global as any;
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

    await doComputeFeatures('test-job', 'RELIANCE.NS', '2026-03-21');

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
    const { mockFirestore } = global as any;
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

    await doComputeFeatures('test-job', 'REGRESS.NS', '2026-03-21');

    const savedDoc = mockFirestore.set.mock.calls[mockFirestore.set.mock.calls.length - 1][0];
    const undefinedFields = Object.keys(savedDoc).filter((k) => savedDoc[k] === undefined);
    expect(undefinedFields).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(savedDoc, 'rsScore')).toBe(false);
  });

  it('should skip if insufficient bars are found', async () => {
    const { mockFirestore } = global as any;
    mockFirestore.get
        .mockResolvedValueOnce({ exists: false })
        .mockResolvedValueOnce({ empty: false, size: 10, docs: [] }); // Only 10 bars

    await expect(doComputeFeatures('test-job', 'SMALLCAP.NS', '2026-03-21'))
      .rejects.toThrow('Insufficient data');
  });
});

describe('computeSma200Rising (adaptive 200-SMA slope)', () => {
  // A strictly rising series: the last-200 average always exceeds any earlier 200-window.
  const rising = (n: number) => Array.from({ length: n }, (_, i) => 100 + i);
  const falling = (n: number) => Array.from({ length: n }, (_, i) => 100 - i);

  it('detects a rising 200-SMA with only 212 bars (the real-world case)', () => {
    // Regression: the old `>= 200 + 20` guard returned false here, disabling all signals.
    expect(computeSma200Rising(rising(212), 20)).toBe(true);
  });

  it('detects a rising 200-SMA at the full lookback', () => {
    expect(computeSma200Rising(rising(260), 20)).toBe(true);
  });

  it('returns false for a falling 200-SMA', () => {
    expect(computeSma200Rising(falling(240), 20)).toBe(false);
  });

  it('fails closed below the minimal slope window (< 205 bars)', () => {
    expect(computeSma200Rising(rising(204), 20)).toBe(false);
    expect(computeSma200Rising(rising(200), 20)).toBe(false);
  });

  it('caps the lookback at available history (adaptive)', () => {
    // 206 bars → effective lookback 6, still a valid rising check.
    expect(computeSma200Rising(rising(206), 20)).toBe(true);
  });
});

describe('computeVcpVolumeDryUp', () => {
  const barsWithVolumes = (volumes: number[]) => volumes.map((volume) => ({ volume }));

  it('accepts a materially quieter, progressively drying final contraction before a high-volume breakout', () => {
    const volumes = [
      ...Array(40).fill(1_000_000),
      ...Array(5).fill(800_000),
      ...Array(5).fill(500_000),
      2_000_000,
    ];

    const result = computeVcpVolumeDryUp(barsWithVolumes(volumes));

    expect(result.passed).toBe(true);
    expect(result.ratio).toBeCloseTo(0.65);
  });

  it('rejects a trivial reduction that is not a meaningful dry-up', () => {
    const volumes = [
      ...Array(40).fill(1_000_000),
      ...Array(5).fill(990_000),
      ...Array(5).fill(980_000),
      2_000_000,
    ];

    expect(computeVcpVolumeDryUp(barsWithVolumes(volumes)).passed).toBe(false);
  });

  it('rejects a final contraction whose volume increases into the pivot', () => {
    const volumes = [
      ...Array(40).fill(1_000_000),
      ...Array(5).fill(500_000),
      ...Array(5).fill(800_000),
      2_000_000,
    ];

    expect(computeVcpVolumeDryUp(barsWithVolumes(volumes)).passed).toBe(false);
  });

  it('excludes the breakout bar from the dry-up calculation', () => {
    const volumes = [
      ...Array(40).fill(1_000_000),
      ...Array(5).fill(800_000),
      ...Array(5).fill(500_000),
      5_000_000,
    ];

    expect(computeVcpVolumeDryUp(barsWithVolumes(volumes)).passed).toBe(true);
  });
});
