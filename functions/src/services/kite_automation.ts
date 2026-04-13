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
 *
 * Key: cookies from login & 2FA must be forwarded to the OAuth redirect
 * so Kite recognises the authenticated session.
 */
export async function generateHeadlessRequestToken(
  userId: string,
  password: string,
  totpSecret: string,
  apiKey: string
): Promise<string> {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const cookies: string[] = [];

  /** Accumulate Set-Cookie values (name=value only) */
  function collectCookies(res: any) {
    const sc: string[] | undefined = res.headers['set-cookie'];
    if (!sc) return;
    for (const c of sc) {
      const nameVal = c.split(';')[0];
      // Overwrite if same cookie name already exists
      const name = nameVal.split('=')[0];
      const idx = cookies.findIndex(ck => ck.startsWith(name + '='));
      if (idx >= 0) cookies[idx] = nameVal;
      else cookies.push(nameVal);
    }
  }

  function cookieHeader(): string { return cookies.join('; '); }

  // 1. Initial login request
  const loginRes = await axios.post('https://kite.zerodha.com/api/login',
    new URLSearchParams({ user_id: userId, password }).toString(),
    { headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  collectCookies(loginRes);

  const requestId = loginRes.data?.data?.request_id;
  if (!requestId) throw new Error('Failed to get request_id during login');

  // 2. 2FA / TOTP challenge
  const { otp: token } = await TOTP.generate(totpSecret);
  const twofaRes = await axios.post('https://kite.zerodha.com/api/twofa',
    new URLSearchParams({
      user_id: userId,
      request_id: requestId,
      twofa_value: token,
      skip_session: ''
    }).toString(),
    { headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() } }
  );
  collectCookies(twofaRes);

  // 3. OAuth — walk the redirect chain (login → finish → callback with request_token)
  //    Each hop may be a 302/303; we follow manually to keep cookies intact.
  let nextUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
  const maxHops = 5;

  for (let hop = 0; hop < maxHops; hop++) {
    const res = await axios.get(nextUrl, {
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': ua, Cookie: cookieHeader() }
    });
    collectCookies(res);

    const location = res.headers.location;
    if (!location) {
      throw new Error(`OAuth hop ${hop}: no redirect (status ${res.status}) from ${nextUrl.substring(0, 120)}`);
    }

    // Resolve relative URLs
    const resolved = location.startsWith('http') ? location : new URL(location, nextUrl).toString();
    const parsed = new URL(resolved);
    const requestToken = parsed.searchParams.get('request_token');
    if (requestToken) return requestToken;

    nextUrl = resolved;
  }

  throw new Error('Exhausted redirect hops without finding request_token');
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
