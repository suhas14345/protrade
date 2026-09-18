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
exports.validateTotpSecretFormat = validateTotpSecretFormat;
exports.validateTotpSecret = validateTotpSecret;
exports.generateHeadlessRequestToken = generateHeadlessRequestToken;
exports.autoRenewKiteSessionHandler = autoRenewKiteSessionHandler;
const axios_1 = __importDefault(require("axios"));
const totp_generator_1 = require("totp-generator");
const admin = __importStar(require("firebase-admin"));
// Consecutive auto-renew failures before the scheduled renewal is disabled (circuit breaker).
const MAX_RENEW_FAILURES = Number(process.env.KITE_MAX_RENEW_FAILURES) || 2;
async function getDb() {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
}
/** Format-only TOTP secret check — never contacts Kite. */
function validateTotpSecretFormat(seed) {
    const s = (seed || '').trim();
    if (!s)
        return { valid: false, format: 'missing', length: 0 };
    if (/^[A-Z2-7]+=*$/i.test(s))
        return { valid: true, format: 'base32', length: s.length };
    if (/^[0-9]{4,8}$/.test(s))
        return { valid: false, format: 'digits', length: s.length };
    return { valid: false, format: 'invalid', length: s.length };
}
/**
 * Offline validation of a TOTP secret: checks base32 format and generates the current
 * OTP locally so it can be compared with the authenticator app — WITHOUT contacting Kite
 * (spends zero Kite login attempts). Falls back to the stored secret when none is passed.
 * The raw seed is never logged.
 */
async function validateTotpSecret(seedArg) {
    var _a;
    let seed = (seedArg || '').trim();
    let source = 'provided';
    if (!seed) {
        const db = await getDb();
        const snap = await db.collection('settings').doc('kite').get();
        seed = (((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.totpSecret) || '').trim();
        source = 'stored';
    }
    const fmt = validateTotpSecretFormat(seed);
    if (fmt.format === 'missing') {
        return Object.assign(Object.assign({}, fmt), { source, message: 'No TOTP secret provided or stored.' });
    }
    if (!fmt.valid) {
        const hint = fmt.format === 'digits'
            ? 'This looks like a 6-digit code — paste the base32 SEED from Kite (e.g. JBSWY3DPEHPK3PXP), not the rotating code.'
            : 'Not a valid base32 secret (allowed chars A–Z and 2–7).';
        return Object.assign(Object.assign({}, fmt), { source, message: hint });
    }
    try {
        const { otp } = await totp_generator_1.TOTP.generate(seed);
        return Object.assign(Object.assign({}, fmt), { otp, source, message: `Valid base32 seed. Current OTP: ${otp} — compare it with your Kite authenticator app before running a live renewal.` });
    }
    catch (e) {
        return Object.assign(Object.assign({}, fmt), { source, message: `Seed is base32 but OTP generation failed: ${e instanceof Error ? e.message : String(e)}` });
    }
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
async function autoRenewKiteSessionHandler(event = {}) {
    var _a;
    const db = await getDb();
    const manual = !!(event === null || event === void 0 ? void 0 : event.manual);
    const snap = await db.collection('settings').doc('kite').get();
    const data = snap.data();
    if (!(data === null || data === void 0 ? void 0 : data.userId) || !(data === null || data === void 0 ? void 0 : data.password) || !(data === null || data === void 0 ? void 0 : data.totpSecret) || !(data === null || data === void 0 ? void 0 : data.apiKey) || !(data === null || data === void 0 ? void 0 : data.apiSecret)) {
        console.warn('[KiteAuto] Missing credentials for auto-renewal');
        return { status: 'ERROR', message: 'Missing Kite credentials' };
    }
    // Circuit breaker: once disabled after repeated failures, skip the scheduled run so we
    // never hammer Kite with a bad TOTP (and risk account lockout). A manual renew bypasses it.
    if (data.autoRenewDisabled && !manual) {
        console.warn('[KiteAuto] Auto-renewal disabled after repeated failures — skipping scheduled run');
        return {
            status: 'SKIPPED',
            message: 'Auto-renewal is disabled after repeated failures. Fix credentials/TOTP on the dashboard to re-enable.',
            disabled: true,
            failCount: data.renewFailCount || 0,
        };
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
            lastAutoRenew: admin.firestore.Timestamp.now(),
            renewFailCount: 0,
            autoRenewDisabled: admin.firestore.FieldValue.delete(),
            lastError: admin.firestore.FieldValue.delete(),
        }, { merge: true });
        console.log('[KiteAuto] Successfully auto-renewed Kite session');
        return { status: 'ACTIVE', message: 'Kite session auto-renewed' };
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Auto-renewal failed';
        const axiosData = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.data;
        const detail = axiosData ? JSON.stringify(axiosData) : errMsg;
        const failCount = (data.renewFailCount || 0) + 1;
        const disable = failCount >= MAX_RENEW_FAILURES;
        console.error(`[KiteAuto] Auto-renewal failed (attempt ${failCount}/${MAX_RENEW_FAILURES}):`, detail);
        await db.collection('settings').doc('kite').set(Object.assign({ status: 'ERROR', lastError: detail.substring(0, 500), renewFailCount: failCount }, (disable ? { autoRenewDisabled: true } : {})), { merge: true });
        if (disable) {
            try {
                const { raiseAlert, AlertType } = await Promise.resolve().then(() => __importStar(require('./alerting')));
                await raiseAlert(AlertType.SESSION_EXPIRED, 'CRITICAL', `Kite auto-renewal disabled after ${failCount} consecutive failures. Fix credentials/TOTP on the dashboard to re-enable.`, { failCount });
            }
            catch ( /* alerting is best-effort */_b) { /* alerting is best-effort */ }
        }
        return { status: 'ERROR', message: detail.substring(0, 500), disabled: disable, failCount };
    }
}
//# sourceMappingURL=kite_automation.js.map