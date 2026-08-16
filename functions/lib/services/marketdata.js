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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMarketClosed = isMarketClosed;
exports.getNSEInstrumentsMap = getNSEInstrumentsMap;
exports.doFetchCandles = doFetchCandles;
exports.fetchCandlesTask = fetchCandlesTask;
exports.fetchHistoricalBars = fetchHistoricalBars;
exports.updateKiteToken = updateKiteToken;
exports.updateKiteCredentials = updateKiteCredentials;
exports.checkKiteHealth = checkKiteHealth;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const logger_1 = require("./logger");
const runtime_1 = require("../config/runtime");
const getDb = () => {
    if (admin.apps.length === 0) {
        admin.initializeApp();
        const db = admin.firestore();
        db.settings({ ignoreUndefinedProperties: true });
        return db;
    }
    return admin.firestore();
};
/**
 * V3.0: Convert UTC Date to IST dateId using arithmetic (no toLocaleString).
 */
function toISTDateId(utcDate) {
    const istMs = utcDate.getTime() + runtime_1.MARKET_HOURS.IST_OFFSET_HOURS * 3600000;
    const ist = new Date(istMs);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const d = String(ist.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}
/**
 * V3.0: Check if NSE market is closed (safe to run EOD).
 */
function isMarketClosed() {
    const nowMs = Date.now() + runtime_1.MARKET_HOURS.IST_OFFSET_HOURS * 3600000;
    const istNow = new Date(nowMs);
    const h = istNow.getUTCHours();
    const m = istNow.getUTCMinutes();
    const timeMinutes = h * 60 + m;
    const safeMinutes = runtime_1.MARKET_HOURS.EOD_SAFE_HOUR * 60 + runtime_1.MARKET_HOURS.EOD_SAFE_MINUTE;
    return timeMinutes >= safeMinutes;
}
let _kite = null;
let _kiteRequestTail = Promise.resolve();
let _lastKiteRequestAt = 0;
const KITE_MIN_REQUEST_INTERVAL_MS = 400;
async function scheduleKiteRequest(request) {
    const previous = _kiteRequestTail;
    let release;
    _kiteRequestTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        const waitMs = Math.max(0, KITE_MIN_REQUEST_INTERVAL_MS - (Date.now() - _lastKiteRequestAt));
        if (waitMs > 0)
            await new Promise(resolve => setTimeout(resolve, waitMs));
        _lastKiteRequestAt = Date.now();
        return await request();
    }
    finally {
        release();
    }
}
const getKite = async (apiKey, accessToken) => {
    if (!_kite || _kite.access_token !== accessToken) {
        const { KiteConnect } = await Promise.resolve().then(() => __importStar(require('kiteconnect')));
        _kite = new KiteConnect({ api_key: apiKey });
        _kite.setAccessToken(accessToken);
    }
    return _kite;
};
let _nseInstrumentsMap = null;
let _nseFetchPromise = null;
async function getNSEInstrumentsMap(apiKey, accessToken) {
    if (_nseInstrumentsMap)
        return _nseInstrumentsMap;
    if (_nseFetchPromise)
        return _nseFetchPromise;
    _nseFetchPromise = (async () => {
        console.log('[MarketData] Fetching NSE instrument list CSV from Kite...');
        try {
            const axios = (await Promise.resolve().then(() => __importStar(require('axios')))).default;
            const response = await axios.get('https://api.kite.trade/instruments/NSE', {
                timeout: 120000,
                responseType: 'text'
            });
            const lines = response.data.split('\n');
            const map = new Map();
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].split(',');
                if (parts.length >= 3) {
                    const token = parseInt(parts[0]);
                    const symbol = parts[2];
                    if (token && symbol)
                        map.set(symbol, token);
                }
            }
            _nseInstrumentsMap = map;
            _nseFetchPromise = null;
            console.log(`[MarketData] Cached ${_nseInstrumentsMap.size} NSE instruments from CSV.`);
            return _nseInstrumentsMap;
        }
        catch (err) {
            _nseFetchPromise = null;
            const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
            console.error(`[MarketData] Failed to fetch NSE instruments CSV: ${errMsg}`);
            throw err;
        }
    })();
    return _nseFetchPromise;
}
/**
 * Task Queue Trigger to fetch historical candles for a specific symbol.
 */
async function doFetchCandles(jobId, symbol, runDate, instrumentToken, forceDays) {
    console.log(`>>> [ENTRY POINT] doFetchCandles: Job=${jobId}, Symbol=${symbol}, Date=${runDate}`);
    const db = getDb();
    // 0. Safety Delay: Add randomized jitter (0-500ms) to spread the load across tasks
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 500)));
    // 1. Check credentials
    const settingsSnap = await db.collection('settings').doc('kite').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : null;
    const hasKite = !!((settings === null || settings === void 0 ? void 0 : settings.apiKey) && (settings === null || settings === void 0 ? void 0 : settings.accessToken));
    // 2. Absolute Delta Calculation
    const dateId = runDate.replace(/-/g, '');
    const lastBarSnap = await db.collection('barsD').doc(symbol).collection('days')
        .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
        .limit(1)
        .get();
    let startDate = new Date(runDate);
    startDate.setDate(startDate.getDate() - 60); // Default fallback if no data exists
    if (!lastBarSnap.empty && !forceDays) {
        const lastDateStr = lastBarSnap.docs[0].id;
        if (lastDateStr >= dateId) {
            console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Data already fetched up to ${lastDateStr} (>= ${dateId}). Skipping redundant fetch.`);
            return false;
        }
        const yr = parseInt(lastDateStr.substring(0, 4));
        const mo = parseInt(lastDateStr.substring(4, 6)) - 1;
        const dy = parseInt(lastDateStr.substring(6, 8));
        const lastDate = new Date(Date.UTC(yr, mo, dy));
        startDate = new Date(lastDate);
        startDate.setUTCDate(lastDate.getUTCDate() + 1);
        console.log(`[MarketData] Job ${jobId} symbol ${symbol}: LATEST BAR = ${lastDateStr}. STRICT DELTA FETCH from ${startDate.toISOString().split('T')[0]} to ${runDate}`);
    }
    else if (forceDays) {
        startDate = new Date(runDate);
        startDate.setDate(startDate.getDate() - forceDays);
        console.log(`[MarketData] Job ${jobId} symbol ${symbol}: DEEP SYNC activated. Force-fetching last ${forceDays} days (Start: ${startDate.toISOString().split('T')[0]}).`);
    }
    let realCandles = [];
    // V3.0: Primary fetch from Kite, fallback to NSE bhavcopy
    if (hasKite) {
        try {
            realCandles = await fetchFromKite(symbol, runDate, settings.apiKey, settings.accessToken, instrumentToken, jobId, startDate);
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
            await logger_1.logger.warn(`[MarketData] Kite fetch failed for ${symbol}, trying bhavcopy fallback.`, 'MarketData', { jobId, symbol, error: errorMsg });
            // Fallback to NSE bhavcopy
            try {
                realCandles = await fetchFromNSEBhavcopy(symbol, runDate);
                await logger_1.logger.info(`[MarketData] NSE bhavcopy fallback succeeded for ${symbol}: ${realCandles.length} bars`, 'MarketData', { jobId, symbol });
            }
            catch (bhavErr) {
                await logger_1.logger.error(`[MarketData] Both Kite and bhavcopy failed for ${symbol}.`, 'MarketData', { jobId, symbol });
                throw new Error(`All data sources failed for ${symbol}: Kite: ${errorMsg}, Bhavcopy: ${bhavErr instanceof Error ? bhavErr.message : String(bhavErr)}`);
            }
        }
    }
    else {
        // No Kite credentials — try bhavcopy only
        try {
            realCandles = await fetchFromNSEBhavcopy(symbol, runDate);
            await logger_1.logger.info(`[MarketData] NSE bhavcopy (no Kite) for ${symbol}: ${realCandles.length} bars`, 'MarketData', { jobId, symbol });
        }
        catch (bhavErr) {
            throw new Error(`No Kite credentials and bhavcopy failed for ${symbol}: ${bhavErr instanceof Error ? bhavErr.message : String(bhavErr)}`);
        }
    }
    // V3.0: Enhanced validation + corporate action detection
    const isIndex = symbol === 'NIFTY 50' || symbol.startsWith('^');
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Validating ${realCandles.length} raw candles.`);
    const validCandles = validateCandles(realCandles, isIndex);
    // V3.0: Detect potential corporate actions (splits/bonuses)
    if (validCandles.length > 0 && !lastBarSnap.empty) {
        const prevBar = lastBarSnap.docs[0].data();
        const latestCandle = validCandles[validCandles.length - 1];
        if (prevBar.close > 0) {
            const priceRatio = latestCandle.close / prevBar.close;
            if (priceRatio < 0.5 || priceRatio > 2.0) {
                await logger_1.logger.warn(`[MarketData] CORPORATE ACTION SUSPECTED for ${symbol}: price jumped ${((priceRatio - 1) * 100).toFixed(1)}% (${prevBar.close} → ${latestCandle.close}). Flagging for review.`, 'MarketData', { jobId, symbol, priceRatio });
                // Store flag for downstream consumers
                await db.collection('alerts').add({
                    type: 'CORPORATE_ACTION_SUSPECTED', symbol, dateId, priceRatio,
                    prevClose: prevBar.close, newClose: latestCandle.close,
                    createdAt: admin.firestore.Timestamp.now(), status: 'PENDING'
                });
            }
        }
    }
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: ${validCandles.length} valid candles after filter.`);
    // 3. Store the data in rolling window (barsD)
    if (validCandles.length === 0) {
        await logger_1.logger.warn(`No valid candles for ${symbol} around ${runDate} after fetch.`, 'MarketData', { jobId, symbol });
        console.log(`[MarketData] Job ${jobId} symbol ${symbol}: ABORTING write - zero valid candles.`);
        return false;
    }
    const batch = db.batch();
    for (const c of validCandles) {
        // V3.0: Robust IST dateId generation via UTC offset arithmetic
        const dateObj = c.timestamp.toDate();
        const cDateId = toISTDateId(dateObj);
        if (!symbol || !cDateId) {
            console.warn(`[MarketData] Skipping batch write: empty symbol(${symbol}) or cDateId(${cDateId})`);
            continue;
        }
        const docRef = db.collection('barsD').doc(symbol).collection('days').doc(cDateId);
        batch.set(docRef, Object.assign(Object.assign({}, c), { dateId: cDateId }));
    }
    // Set a field on the symbol document itself so it's not a "virtual" parent
    if (!symbol)
        return true;
    batch.set(db.collection('barsD').doc(symbol), {
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        type: symbol === 'NIFTY 50' ? 'INDEX' : 'EQUITY'
    }, { merge: true });
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Committing batch write for ${validCandles.length} candles.`);
    try {
        await batch.commit();
        console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Batch commit SUCCESS.`);
    }
    catch (err) {
        console.error(`[MarketData] Job ${jobId} symbol ${symbol}: Batch commit FAILED:`, err);
        throw err;
    }
    await logger_1.logger.info(`Uploaded ${validCandles.length} candles for ${symbol} (Historical Backfill)`, 'MarketData', { jobId, symbol });
    return true;
}
async function fetchCandlesTask(req, res) {
    const { jobId, symbol, runDate, forceDays } = req.body;
    try {
        await doFetchCandles(jobId, symbol, runDate, undefined, forceDays);
        res.status(200).send('Candles fetched');
    }
    catch (error) {
        await logger_1.logger.error(`Failed to fetch candles for ${symbol}: ${error}`, 'MarketData', { jobId, symbol, runDate });
        res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
    }
}
// fetchFromYahooFinance removed — replaced by NSE bhavcopy
/**
 * V3.0: NSE Bhavcopy fallback — fetches official EOD data from NSE website.
 * Only returns today's bar (bhavcopy is daily). Used as degraded-mode backup.
 */
async function fetchFromNSEBhavcopy(symbol, runDate) {
    const axios = (await Promise.resolve().then(() => __importStar(require('axios')))).default;
    const searchSymbol = symbol.endsWith('.NS') ? symbol.slice(0, -3) : symbol;
    // NSE bhavcopy URL format (CSV) — tries current day
    const d = new Date(runDate);
    const day = String(d.getDate()).padStart(2, '0');
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const mon = months[d.getMonth()];
    const year = d.getFullYear();
    // Try NSE equity bhavcopy endpoint
    const url = `https://archives.nseindia.com/content/historical/EQUITIES/${year}/${mon}/cm${day}${mon}${year}bhav.csv.zip`;
    try {
        const response = await axios.get(url, {
            timeout: 30000,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept-Encoding': 'gzip, deflate',
            }
        });
        // Parse CSV from zip (simplified — in production would use proper zip lib)
        // For now, log the attempt and return empty if zip parsing not available
        const AdmZip = (await Promise.resolve().then(() => __importStar(require('adm-zip')))).default;
        const zip = new AdmZip(Buffer.from(response.data));
        const entries = zip.getEntries();
        for (const entry of entries) {
            if (!entry.entryName.endsWith('.csv'))
                continue;
            const csv = entry.getData().toString('utf8');
            const lines = csv.split('\n');
            const header = lines[0].split(',').map((h) => h.trim());
            const symIdx = header.indexOf('SYMBOL');
            const openIdx = header.indexOf('OPEN');
            const highIdx = header.indexOf('HIGH');
            const lowIdx = header.indexOf('LOW');
            const closeIdx = header.indexOf('CLOSE');
            const volIdx = header.indexOf('TOTTRDQTY');
            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',').map((c) => c.trim());
                if (cols[symIdx] === searchSymbol) {
                    return [{
                            open: parseFloat(cols[openIdx]),
                            high: parseFloat(cols[highIdx]),
                            low: parseFloat(cols[lowIdx]),
                            close: parseFloat(cols[closeIdx]),
                            volume: parseInt(cols[volIdx]) || 0,
                            timestamp: firestore_1.Timestamp.fromDate(d)
                        }];
                }
            }
        }
        console.warn(`[MarketData] Symbol ${searchSymbol} not found in NSE bhavcopy for ${runDate}`);
        return [];
    }
    catch (err) {
        console.warn(`[MarketData] NSE bhavcopy fetch failed for ${runDate}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
async function fetchWithRetry(fn, symbol, retries = 3, delay = 1000) {
    var _a, _b, _c, _d;
    try {
        return await fn();
    }
    catch (err) {
        if (retries <= 0)
            throw err;
        const isRateLimit = (err === null || err === void 0 ? void 0 : err.status) === 429 || ((_a = err === null || err === void 0 ? void 0 : err.message) === null || _a === void 0 ? void 0 : _a.includes('Too many requests'));
        const isTimeout = ((_b = err === null || err === void 0 ? void 0 : err.message) === null || _b === void 0 ? void 0 : _b.includes('timeout')) ||
            ((_c = err === null || err === void 0 ? void 0 : err.message) === null || _c === void 0 ? void 0 : _c.includes('DEADLINE_EXCEEDED')) ||
            ((_d = err === null || err === void 0 ? void 0 : err.message) === null || _d === void 0 ? void 0 : _d.includes('ECONNABORTED')) ||
            (err === null || err === void 0 ? void 0 : err.error_type) === 'NetworkException';
        if (isRateLimit || isTimeout) {
            // Add ±500ms jitter to prevent "thundering herd"
            const jitter = Math.floor(Math.random() * 1000) - 500;
            const actualDelay = Math.max(100, delay + jitter);
            console.warn(`[MarketData] ${symbol} fetch failed (${err.message}): Retrying in ${actualDelay}ms... (${retries} left)`);
            await new Promise(resolve => setTimeout(resolve, actualDelay));
            return fetchWithRetry(fn, symbol, retries - 1, delay * 2);
        }
        throw err;
    }
}
async function fetchFromKite(symbol, runDate, apiKey, accessToken, instrumentToken, jobId, providedStartDate) {
    console.log(`>>> [KITE FETCH START] Symbol=${symbol}, Token=${instrumentToken}`);
    const kite = await getKite(apiKey, accessToken);
    let token = instrumentToken;
    if (!token) {
        if (symbol === 'NIFTY 50') {
            token = 256265; // Kite Constant for NSE Index
        }
        else {
            const instrumentsMap = await getNSEInstrumentsMap(apiKey, accessToken);
            const searchSymbol = symbol.endsWith('.NS') ? symbol.slice(0, -3) : symbol;
            token = instrumentsMap.get(searchSymbol);
            if (!token) {
                throw new Error(`Instrument not found in Kite NSE: ${symbol}`);
            }
        }
    }
    const endDate = new Date(runDate);
    const startDate = providedStartDate || new Date(runDate);
    if (!providedStartDate) {
        startDate.setDate(endDate.getDate() - 60);
    }
    await logger_1.logger.info(`Fetching data for ${symbol} from Kite: ${startDate.toISOString()} to ${endDate.toISOString()}`, 'MarketData', { jobId, symbol });
    const results = await fetchWithRetry(() => scheduleKiteRequest(() => kite.getHistoricalData(token, 'day', startDate, endDate)), symbol);
    await logger_1.logger.info(`Raw result count for ${symbol}: ${results.length}`, 'MarketData', { jobId, symbol });
    return results.map((row) => ({
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        timestamp: firestore_1.Timestamp.fromDate(row.date)
    }));
}
/** Fetch a bounded historical range for backfills without exposing Kite credentials. */
async function fetchHistoricalBars(symbol, startISO, endISO, apiKey, accessToken, instrumentToken) {
    return fetchFromKite(symbol, endISO, apiKey, accessToken, instrumentToken, 'historical-backfill', new Date(startISO));
}
async function updateKiteToken(req, res) {
    const db = getDb();
    let { requestToken, apiKey, apiSecret } = req.body;
    // Fall back to stored credentials if not provided
    if (!apiKey || !apiSecret) {
        const settingsSnap = await db.collection('settings').doc('kite').get();
        const stored = settingsSnap.data();
        if (!apiKey)
            apiKey = stored === null || stored === void 0 ? void 0 : stored.apiKey;
        if (!apiSecret)
            apiSecret = stored === null || stored === void 0 ? void 0 : stored.apiSecret;
    }
    if (!requestToken || !apiKey || !apiSecret) {
        res.status(400).send({ error: 'Missing requestToken, apiKey, or apiSecret' });
        return;
    }
    try {
        const { KiteConnect } = await Promise.resolve().then(() => __importStar(require('kiteconnect')));
        const kite = new KiteConnect({ api_key: apiKey });
        const response = await kite.generateSession(requestToken, apiSecret);
        await db.collection('settings').doc('kite').set({
            apiKey,
            apiSecret,
            accessToken: response.access_token,
            updatedAt: admin.firestore.Timestamp.now(),
            status: 'ACTIVE'
        }, { merge: true });
        res.status(200).send({ message: 'Kite session updated and ACTIVE' });
    }
    catch (error) {
        console.error('Kite session error:', error);
        await db.collection('settings').doc('kite').set({
            status: 'ERROR',
            lastError: error instanceof Error ? error.message : 'Unknown'
        }, { merge: true });
        res.status(500).send({ error: error instanceof Error ? error.message : 'Failed to update Kite session' });
    }
}
async function updateKiteCredentials(req, res) {
    const { apiKey, apiSecret, userId, password, totpSecret } = req.body;
    const db = getDb();
    const data = {
        updatedAt: admin.firestore.Timestamp.now()
    };
    if (apiKey)
        data.apiKey = apiKey;
    if (apiSecret)
        data.apiSecret = apiSecret;
    if (userId)
        data.userId = userId;
    if (password)
        data.password = password;
    if (totpSecret)
        data.totpSecret = totpSecret;
    if (typeof req.body.disableFallback === 'boolean')
        data.disableFallback = req.body.disableFallback;
    await db.collection('settings').doc('kite').set(data, { merge: true });
    res.status(200).send({ message: 'Kite credentials saved' });
}
async function checkKiteHealth(req, res) {
    const db = getDb();
    const snap = await db.collection('settings').doc('kite').get();
    const data = snap.data();
    if (!(data === null || data === void 0 ? void 0 : data.accessToken)) {
        res.status(200).send({ status: 'EXPIRED', reason: 'No token found' });
        return;
    }
    try {
        const { KiteConnect } = await Promise.resolve().then(() => __importStar(require('kiteconnect')));
        const kite = new KiteConnect({ api_key: data.apiKey });
        kite.setAccessToken(data.accessToken);
        await kite.getProfile();
        res.status(200).send({ status: 'ACTIVE' });
    }
    catch (err) {
        console.warn('[MarketData] Kite health check failed:', err);
        res.status(200).send({ status: 'EXPIRED', error: err instanceof Error ? err.message : 'Invalid session' });
    }
}
/**
 * V3.0: Enhanced candle validation — OHLC bounds, volume anomaly, zero-vol rejection.
 */
function validateCandles(bars, isIndex = false) {
    return bars.filter(bar => {
        // Basic sanity
        if (bar.close <= 0 || bar.high < bar.low)
            return false;
        // V3.0: OHLC ratio check — reject if high/low spread > 20% (likely circuit/bad data)
        if (bar.low > 0 && bar.high / bar.low > runtime_1.DATA_VALIDATION.MAX_OHLC_RATIO) {
            console.warn(`[MarketData] Rejecting bar: high/low ratio ${(bar.high / bar.low).toFixed(2)} exceeds ${runtime_1.DATA_VALIDATION.MAX_OHLC_RATIO}`);
            return false;
        }
        // V3.0: OHLC containment — close and open must be within [low, high]
        if (bar.open < bar.low * 0.999 || bar.open > bar.high * 1.001)
            return false;
        if (bar.close < bar.low * 0.999 || bar.close > bar.high * 1.001)
            return false;
        // V3.0: Minimum price filter
        if (bar.close < runtime_1.DATA_VALIDATION.MIN_CLOSE_INR)
            return false;
        // V3.0: Zero volume rejection for equities (indices have 0 volume in Kite)
        if (!isIndex && runtime_1.DATA_VALIDATION.ZERO_VOLUME_REJECT_EQUITY && bar.volume === 0)
            return false;
        // Allow non-negative volume for indices
        if (bar.volume < 0)
            return false;
        return true;
    });
}
//# sourceMappingURL=marketdata.js.map