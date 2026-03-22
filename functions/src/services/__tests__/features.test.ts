import { doComputeFeatures } from '../features';
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

    await doComputeFeatures('test-job', 'RELIANCE.NS', '2026-03-21');

    // Assert features were saved
    expect(mockFirestore.collection).toHaveBeenCalledWith('features');
    expect(mockFirestore.set).toHaveBeenCalledWith(expect.objectContaining({
      ema20: 115,
      rsi14: 52,
      barsCount: 30
    }));
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
