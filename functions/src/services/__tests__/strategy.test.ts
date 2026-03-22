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

    await doEvaluateSignals('test-job', 'TCS.NS', '2026-03-21');

    // Assert signal was saved
    expect(mockFirestore.collection).toHaveBeenCalledWith('signals');
    expect(mockFirestore.doc).toHaveBeenCalledWith(expect.stringContaining('PullbackEOD'));
    
    expect(mockFirestore.set).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'BUY',
      status: 'NEW'
    }));
  });

  it('should skip if trading is disabled by regime', async () => {
    const { mockFirestore } = global as any;
    const mockRegime = { tradeAllowed: false, marketState: 'BEAR' };

    mockFirestore.get
        .mockResolvedValueOnce({ exists: false }) // sig check
        .mockResolvedValueOnce({ exists: true, data: () => ({}) }) // features fetch
        .mockResolvedValueOnce({ exists: true, data: () => mockRegime }); // regime fetch

    await doEvaluateSignals('test-job', 'SBIN.NS', '2026-03-21');
    expect(mockFirestore.collection('signals').doc().collection('items').doc().set).not.toHaveBeenCalled();
  });
});
