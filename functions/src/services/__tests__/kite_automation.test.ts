import { generateHeadlessRequestToken } from '../kite_automation';
import axios from 'axios';
import { TOTP } from 'totp-generator';

import { validateTotpSecretFormat } from '../kite_automation';

jest.mock('axios');
jest.mock('totp-generator');

describe('Kite Automation Service - Headless Login', () => {
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should follow login flow, propagate cookies, and return request token', async () => {
    // 1. Login — returns request_id and sets cookies
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { request_id: 'rid123' } },
      headers: { 'set-cookie': ['kf_session=abc; Path=/; HttpOnly', 'public_token=xyz; Path=/'] }
    });

    // 2. Mock TOTP generation (v2: sync, returns { otp, expires })
    (TOTP.generate as jest.Mock).mockResolvedValue({ otp: '123456' });

    // 3. 2FA — returns enctoken cookie
    mockedAxios.post.mockResolvedValueOnce({
      data: {},
      headers: { 'set-cookie': ['enctoken=enc123; Path=/; HttpOnly'] }
    });

    // 4. OAuth hop 1 — /connect/login redirects to /connect/finish (no request_token yet)
    mockedAxios.get.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://kite.zerodha.com/connect/finish?api_key=apikey&sess_id=xyz' }
    });

    // 5. OAuth hop 2 — /connect/finish redirects to callback with request_token
    mockedAxios.get.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://callback.url/?request_token=rt123&status=success' }
    });

    const token = await generateHeadlessRequestToken('user', 'pass', 'secret', 'apikey');

    expect(token).toBe('rt123');
    // Should have made 2 GET requests (hop chain)
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);

    // Verify 2FA call includes login cookies
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://kite.zerodha.com/api/twofa',
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: expect.stringContaining('kf_session=abc') })
      })
    );

    // Verify both hops include all cookies
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/connect/login'),
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: expect.stringContaining('enctoken=enc123') })
      })
    );
  });

  it('should throw error if request_id is missing', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { data: {} }, headers: {} });

    await expect(generateHeadlessRequestToken('user', 'pass', 'secret', 'apikey'))
      .rejects.toThrow('Failed to get request_id');
  });

  it('should include redirect URL in error when request_token missing after all hops', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { request_id: 'rid1' } }, headers: {}
    });
    (TOTP.generate as jest.Mock).mockResolvedValue({ otp: '111111' });
    mockedAxios.post.mockResolvedValueOnce({ data: {}, headers: {} });
    // 5 hops, none with request_token, last has no location → error
    for (let i = 0; i < 4; i++) {
      mockedAxios.get.mockResolvedValueOnce({
        status: 302, headers: { location: `https://kite.zerodha.com/step${i + 1}` }
      });
    }
    mockedAxios.get.mockResolvedValueOnce({ status: 200, headers: {} });

    await expect(generateHeadlessRequestToken('user', 'pass', 'secret', 'apikey'))
      .rejects.toThrow(/no redirect.*status 200/);
  });

  it('should throw descriptive error when redirect chain exhausted', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { request_id: 'rid1' } }, headers: {}
    });
    (TOTP.generate as jest.Mock).mockResolvedValue({ otp: '222222' });
    mockedAxios.post.mockResolvedValueOnce({ data: {}, headers: {} });
    // 5 hops, all redirecting but no request_token
    for (let i = 0; i < 5; i++) {
      mockedAxios.get.mockResolvedValueOnce({
        status: 302, headers: { location: `https://kite.zerodha.com/loop${i}` }
      });
    }

    await expect(generateHeadlessRequestToken('user', 'pass', 'secret', 'apikey'))
      .rejects.toThrow(/Exhausted redirect hops/);
  });
});

describe('validateTotpSecretFormat', () => {
  it('accepts a valid 32-char base32 seed', () => {
    const r = validateTotpSecretFormat('LFJVRL4JTFODGGQMOUUIBJNU2KFBC6K4');
    expect(r).toEqual({ valid: true, format: 'base32', length: 32 });
  });

  it('accepts a short base32 seed with padding', () => {
    expect(validateTotpSecretFormat('JBSWY3DPEHPK3PXP').valid).toBe(true);
  });

  it('rejects a 6-digit rotating code (common mistake)', () => {
    const r = validateTotpSecretFormat('123456');
    expect(r.valid).toBe(false);
    expect(r.format).toBe('digits');
  });

  it('rejects garbage / non-base32 characters', () => {
    expect(validateTotpSecretFormat('not a secret!').format).toBe('invalid');
  });

  it('reports missing for empty input', () => {
    expect(validateTotpSecretFormat('  ').format).toBe('missing');
  });
});
