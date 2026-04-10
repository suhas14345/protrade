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
 */
async function generateHeadlessRequestToken(userId, password, totpSecret, apiKey) {
    const instance = axios_1.default.create({
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
    if (!requestId)
        throw new Error('Failed to get request_id during login');
    // 2. 2FA / TOTP challenge
    const { otp: token } = await totp_generator_1.TOTP.generate(totpSecret);
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
    if (!location)
        throw new Error('Failed to get redirect location for request_token');
    const url = new URL(location);
    const requestToken = url.searchParams.get('request_token');
    if (!requestToken)
        throw new Error('request_token not found in redirect URL');
    return requestToken;
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