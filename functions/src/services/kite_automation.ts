import axios from 'axios';
import { TOTP } from 'totp-generator';
import * as admin from 'firebase-admin';

async function getDb() {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
}

/**
 * Simulates a headless login to Zerodha Kite to obtain a request_token.
 * Requires: userId, password, totpSecret, apiKey.
 */
export async function generateHeadlessRequestToken(
  userId: string,
  password: string,
  totpSecret: string,
  apiKey: string
): Promise<string> {
  const instance = axios.create({
    baseURL: 'https://kite.zerodha.com',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
  });

  // 1. Initial login request
  const loginRes = await instance.post('/api/login', new URLSearchParams({
    user_id: userId,
    password: password
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const requestId = loginRes.data.data.request_id;
  if (!requestId) throw new Error('Failed to get request_id during login');

  // 2. 2FA / TOTP challenge
  const { otp: token } = await TOTP.generate(totpSecret);
  await instance.post('/api/twofa', new URLSearchParams({
    user_id: userId,
    request_id: requestId,
    twofa_value: token,
    skip_session: ''
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  // Extract enctoken from cookies if available, or just follow the redirect to authorized app
  // Kite Connect OAuth flow requires redirecting to https://kite.zerodha.com/connect/login?api_key=...
  // Usually, once logged in (cookies set), visiting this URL returns the request_token in a redirect.

  const authUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
  const redirectRes = await instance.get(authUrl, {
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400
  });

  const location = redirectRes.headers.location;
  if (!location) throw new Error('Failed to get redirect location for request_token');

  const url = new URL(location);
  const requestToken = url.searchParams.get('request_token');
  if (!requestToken) throw new Error('request_token not found in redirect URL');

  return requestToken;
}

export async function autoRenewKiteSessionHandler(event: any) {
  const db = await getDb();
  const snap = await db.collection('settings').doc('kite').get();
  const data = snap.data();

  if (!data?.userId || !data?.password || !data?.totpSecret || !data?.apiKey || !data?.apiSecret) {
    console.warn('[KiteAuto] Missing credentials for auto-renewal');
    return;
  }

  try {
    const requestToken = await generateHeadlessRequestToken(
      data.userId,
      data.password,
      data.totpSecret,
      data.apiKey
    );

    const { KiteConnect } = await import('kiteconnect');
    const kite = new KiteConnect({ api_key: data.apiKey });
    const response = await kite.generateSession(requestToken, data.apiSecret);

    await db.collection('settings').doc('kite').set({
      accessToken: response.access_token,
      updatedAt: admin.firestore.Timestamp.now(),
      status: 'ACTIVE',
      lastAutoRenew: admin.firestore.Timestamp.now()
    }, { merge: true });

    console.log('[KiteAuto] Successfully auto-renewed Kite session');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Auto-renewal failed';
    const axiosData = (err as any)?.response?.data;
    const detail = axiosData ? JSON.stringify(axiosData) : errMsg;
    console.error('[KiteAuto] Auto-renewal failed:', detail);
    await db.collection('settings').doc('kite').set({
      status: 'ERROR',
      lastError: detail.substring(0, 500)
    }, { merge: true });
  }
}
