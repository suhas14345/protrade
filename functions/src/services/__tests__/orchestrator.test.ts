import { doStartEodRun } from '../orchestrator';

// Mock logger
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

// Mock universe
jest.mock('../universe', () => ({
  getUniverseMembers: jest.fn().mockResolvedValue(['RELIANCE.NS', 'TCS.NS'])
}));

// Mock Cloud Tasks — prevents real GCP credential lookup
jest.mock('../tasks', () => ({
  taskClient: {
    enqueue: jest.fn().mockResolvedValue(undefined),
    enqueueDispatch: jest.fn().mockResolvedValue(undefined),
  }
}));

// isMarketClosed() is wall-clock dependent (IST time-of-day); pin it so the
// job-creation path is tested deterministically instead of by luck of the clock.
jest.mock('../marketdata', () => ({
  isMarketClosed: jest.fn(() => true),
}));

describe('Orchestrator Service', () => {
  let res: any;

  beforeEach(() => {
    jest.clearAllMocks();
    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis()
    };
  });

  it('should initialize a job and return 202 Accepted', async () => {
    const { mockFirestore } = global as any;
    const req = { 
      query: { date: '2026-03-22', universe: 'nifty50' } 
    };

    await doStartEodRun(req, res);

    expect(mockFirestore.collection).toHaveBeenCalledWith('jobs');
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({
      message: 'EOD run triggered',
      jobId: expect.any(String)
    }));
  });
});
