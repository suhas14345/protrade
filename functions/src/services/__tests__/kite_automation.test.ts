import { generateHeadlessRequestToken } from '../kite_automation';
import axios from 'axios';
import { TOTP } from 'totp-generator';

jest.mock('axios');
jest.mock('totp-generator');

describe('Kite Automation Service - Headless Login', () => {
  const mockedAxios = axios as jest.Mocked<typeof axios>;
  
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.create.mockReturnValue(mockedAxios as any);
  });

  it('should follow the login flow and return a request token', async () => {
    // 1. Mock login response
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { request_id: 'rid123' } }
    });

    // 2. Mock TOTP generation
    (TOTP.generate as jest.Mock).mockResolvedValue({ otp: '123456' });

    // 3. Mock 2FA post
    mockedAxios.post.mockResolvedValueOnce({});

    // 4. Mock redirect to get request_token
    mockedAxios.get.mockResolvedValueOnce({
      headers: { location: 'https://callback.url/?request_token=rt123' }
    });

    const token = await generateHeadlessRequestToken('user', 'pass', 'secret', 'apikey');

    expect(token).toBe('rt123');
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/login', expect.any(String), expect.any(Object));
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/twofa', expect.any(String), expect.any(Object));
  });

  it('should throw error if request_id is missing', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { data: {} } });

    await expect(generateHeadlessRequestToken('user', 'pass', 'secret', 'apikey'))
      .rejects.toThrow('Failed to get request_id');
  });
});
