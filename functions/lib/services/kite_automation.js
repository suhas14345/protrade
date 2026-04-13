"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateHeadlessRequestToken = generateHeadlessRequestToken;
exports.autoRenewKiteSessionHandler = autoRenewKiteSessionHandler;
const axios_1 = __importDefault(require("axios"));
const totp_generator_1 = require("totp-generator");
const admin = __importStar(require("firebase-admin"));
async function getDb() {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
}
/**
 * Simulates a headless login to Zerodha Kite to obtain a request_token.
 * Requires: userId, password, totpSecret, apiKey.
 *
 * Key: cookies from login & 2FA must be forwarded to the OAuth redirect
 * so Kite recognises the authenticated session.
 */
async function generateHeadlessRequestToken(userId, password, totpSecret, apiKey) {
    var _a, _b;
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const cookies = [];
    /** Accumulate Set-Cookie values (name=value only) */
    function collectCookies(res) {
        const sc = res.headers['set-cookie'];
        if (!sc)
            return;
        for (const c of sc) {
            const nameVal = c.split(';')[0];
            // Overwrite if same cookie name already exists
            const name = nameVal.split('=')[0];
            const idx = cookies.findIndex(ck => ck.startsWith(name + '='));
            if (idx >= 0)
                cookies[idx] = nameVal;
            else
                cookies.push(nameVal);
        }
    }
    function cookieHeader() { return cookies.join('; '); }
    // 1. Initial login request
    const loginRes = await axios_1.default.post('https://kite.zerodha.com/api/login', new URLSearchParams({ user_id: userId, password }).toString(), { headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded' } });
    collectCookies(loginRes);
    const requestId = (_b = (_a = loginRes.data) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.request_id;
    if (!requestId)
        throw new Error('Failed to get request_id during login');
    // 2. 2FA / TOTP challenge
    const { otp: token } = await totp_generator_1.TOTP.generate(totpSecret);
    const twofaRes = await axios_1.default.post('https://kite.zerodha.com/api/twofa', new URLSearchParams({
        user_id: userId,
        request_id: requestId,
        twofa_value: token,
        skip_session: ''
    }).toString(), { headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() } });
    collectCookies(twofaRes);
    // 3. OAuth — walk the redirect chain (login → finish → callback with request_token)
    //    Each hop may be a 302/303; we follow manually to keep cookies intact.
    let nextUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
    const maxHops = 5;
    for (let hop = 0; hop < maxHops; hop++) {
        const res = await axios_1.default.get(nextUrl, {
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
        if (requestToken)
            return requestToken;
        nextUrl = resolved;
    }
    throw new Error('Exhausted redirect hops without finding request_token');
}
async function autoRenewKiteSessionHandler(event) {
    var _a;
    const db = await getDb();
    const snap = await db.collection('settings').doc('kite').get();
    const data = snap.data();
    if (!(data === null || data === void 0 ? void 0 : data.userId) || !(data === null || data === void 0 ? void 0 : data.password) || !(data === null || data === void 0 ? void 0 : data.totpSecret) || !(data === null || data === void 0 ? void 0 : data.apiKey) || !(data === null || data === void 0 ? void 0 : data.apiSecret)) {
        console.warn('[KiteAuto] Missing credentials for auto-renewal');
        return;
    }
    try {
        const requestToken = await generateHeadlessRequestToken(data.userId, data.password, data.totpSecret, data.apiKey);
        const { KiteConnect } = await Promise.resolve().then(() => __importStar(require('kiteconnect')));
        const kite = new KiteConnect({ api_key: data.apiKey });
        const response = await kite.generateSession(requestToken, data.apiSecret);
        await db.collection('settings').doc('kite').set({
            accessToken: response.access_token,
            updatedAt: admin.firestore.Timestamp.now(),
            status: 'ACTIVE',
            lastAutoRenew: admin.firestore.Timestamp.now()
        }, { merge: true });
        console.log('[KiteAuto] Successfully auto-renewed Kite session');
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Auto-renewal failed';
        const axiosData = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.data;
        const detail = axiosData ? JSON.stringify(axiosData) : errMsg;
        console.error('[KiteAuto] Auto-renewal failed:', detail);
        await db.collection('settings').doc('kite').set({
            status: 'ERROR',
            lastError: detail.substring(0, 500)
        }, { merge: true });
    }
}
//# sourceMappingURL=kite_automation.js.map