import { checkKiteHealth, updateKiteToken } from '../marketdata';

// Mock kiteconnect
const mockKiteProfile = jest.fn();
const mockGenerateSession = jest.fn();
jest.mock('kiteconnect', () => {
  return {
    KiteConnect: jest.fn().mockImplementation(() => ({
      setAccessToken: jest.fn(),
      getProfile: mockKiteProfile,
      generateSession: mockGenerateSession
    }))
  };
});

describe('MarketData Service - Kite Integration', () => {
  let res: any;

  beforeEach(() => {
    jest.clearAllMocks();
    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis()
    };
  });

  describe('checkKiteHealth', () => {
    it('should return ACTIVE if Kite profile is fetched successfully', async () => {
      const { mockFirestore } = global as any;
      mockFirestore.get.mockResolvedValue({ 
        exists: true, 
        data: () => ({ accessToken: 'valid', apiKey: 'key' }) 
      });
      mockKiteProfile.mockResolvedValue({ user_id: 'S123' });

      await checkKiteHealth({}, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({ status: 'ACTIVE' });
    });

    it('should return EXPIRED if session is invalid', async () => {
      const { mockFirestore } = global as any;
      mockFirestore.get.mockResolvedValue({ 
        exists: true, 
        data: () => ({ accessToken: 'expired', apiKey: 'key' }) 
      });
      mockKiteProfile.mockRejectedValue(new Error('Token expired'));

      await checkKiteHealth({}, res);

      expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ status: 'EXPIRED' }));
    });
  });

  describe('updateKiteToken', () => {
    it('should generate session and save to Firestore', async () => {
      const { mockFirestore } = global as any;
      const mockReq = { 
        body: { requestToken: 'rt123', apiKey: 'ak', apiSecret: 'as' } 
      };
      mockGenerateSession.mockResolvedValue({ access_token: 'new_at' });

      await updateKiteToken(mockReq, res);

      expect(mockFirestore.collection).toHaveBeenCalledWith('settings');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({ message: 'Kite session updated and ACTIVE' });
    });
  });
});
