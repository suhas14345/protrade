"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/services/logger.ts
var logger_exports = {};
__export(logger_exports, {
  log: () => log,
  logger: () => logger
});
async function log(level, message, context, metadata) {
  const db = getDb();
  const entry = {
    level,
    message,
    context,
    metadata,
    timestamp: import_firestore.Timestamp.now()
  };
  try {
    const dateId = (/* @__PURE__ */ new Date()).toISOString().split("T")[0].replace(/-/g, "");
    await db.collection("logs").doc(dateId).collection("entries").add(entry);
    if (level === "ERROR") {
      console.error(`[${context || "SYSTEM"}] ${message}`, metadata);
      await db.collection("system_errors").add({
        ...entry,
        createdAt: import_firestore.Timestamp.now()
      });
      appendToFileLog("ERROR", message, context, metadata);
    } else if (level === "WARN") {
      console.warn(`[${context || "SYSTEM"}] ${message}`, metadata);
      appendToFileLog("WARN", message, context, metadata);
    } else {
      console.log(`[${context || "SYSTEM"}] ${message}`, metadata);
    }
  } catch (err) {
    console.error("CRITICAL: Logging service failed", err);
  }
}
function appendToFileLog(level, message, context, metadata) {
  try {
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, "runtime_errors.log");
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const logLine = `[${timestamp}] [${level}] [${context || "SYSTEM"}] ${message} ${metadata ? JSON.stringify(metadata) : ""}
`;
    fs.appendFileSync(logFile, logLine);
  } catch (err) {
    console.error("Failed to write to local log file:", err);
  }
}
var admin, import_firestore, fs, path, getDb, logger;
var init_logger = __esm({
  "src/services/logger.ts"() {
    "use strict";
    admin = __toESM(require("firebase-admin"));
    import_firestore = require("firebase-admin/firestore");
    fs = __toESM(require("fs"));
    path = __toESM(require("path"));
    getDb = () => {
      if (admin.apps.length === 0) admin.initializeApp();
      return admin.firestore();
    };
    logger = {
      info: (msg, ctx, meta) => log("INFO", msg, ctx, meta),
      warn: (msg, ctx, meta) => log("WARN", msg, ctx, meta),
      error: (msg, ctx, meta) => log("ERROR", msg, ctx, meta),
      debug: (msg, ctx, meta) => log("DEBUG", msg, ctx, meta)
    };
  }
});

// src/services/marketdata.ts
var marketdata_exports = {};
__export(marketdata_exports, {
  checkKiteHealth: () => checkKiteHealth,
  doFetchCandles: () => doFetchCandles,
  fetchCandlesTask: () => fetchCandlesTask,
  getNSEInstruments: () => getNSEInstruments,
  updateKiteCredentials: () => updateKiteCredentials,
  updateKiteToken: () => updateKiteToken
});
async function getNSEInstruments(apiKey, accessToken) {
  if (_nseInstruments) return _nseInstruments;
  console.log("[MarketData] Fetching NSE instrument list CSV from Kite...");
  try {
    const axios = (await import("axios")).default;
    const response = await axios.get("https://api.kite.trade/instruments/NSE", {
      timeout: 12e4,
      responseType: "text"
    });
    const lines = response.data.split("\n");
    const instruments = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length >= 3) {
        instruments.push({
          instrument_token: parseInt(parts[0]),
          tradingsymbol: parts[2]
        });
      }
    }
    _nseInstruments = instruments;
    console.log(`[MarketData] Cached ${_nseInstruments.length} NSE instruments from CSV.`);
    return _nseInstruments;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    console.error(`[MarketData] CRITICAL: Failed to fetch NSE instruments CSV: ${errMsg}`);
    throw err;
  }
}
async function doFetchCandles(jobId, symbol, runDate, instrumentToken) {
  console.log(`>>> [ENTRY POINT] doFetchCandles: Job=${jobId}, Symbol=${symbol}, Date=${runDate}`);
  const db = getDb2();
  const dateObj = new Date(runDate);
  const dayOfWeek = dateObj.getUTCDay();
  let checkDates = [runDate.replace(/-/g, "")];
  if (dayOfWeek === 6) {
    const fri = new Date(dateObj);
    fri.setDate(dateObj.getDate() - 1);
    checkDates.push(fri.toISOString().split("T")[0].replace(/-/g, ""));
  } else if (dayOfWeek === 0) {
    const fri = new Date(dateObj);
    fri.setDate(dateObj.getDate() - 2);
    checkDates.push(fri.toISOString().split("T")[0].replace(/-/g, ""));
  }
  for (const dId of checkDates) {
    const snap = await db.collection("barsD").doc(symbol).collection("days").doc(dId).get();
    if (snap.exists) {
      const historySnap = await db.collection("barsD").doc(symbol).collection("days").where(admin2.firestore.FieldPath.documentId(), "<=", dId).limit(30).get();
      if (historySnap.size >= 25) {
        console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Data for ${dId} (Ref: ${runDate}) and sufficient history exist. Skipping duplicate fetch.`);
        return false;
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 500)));
  const settingsSnap = await db.collection("settings").doc("kite").get();
  const settings = settingsSnap.exists ? settingsSnap.data() : null;
  if (!settings?.apiKey || !settings?.accessToken) {
    throw new Error(`Kite credentials missing or inactive for ${symbol}. Yahoo fallback is disabled.`);
  }
  const dateId = runDate.replace(/-/g, "");
  const lastBarSnap = await db.collection("barsD").doc(symbol).collection("days").where(admin2.firestore.FieldPath.documentId(), "<", dateId).orderBy(admin2.firestore.FieldPath.documentId(), "desc").limit(1).get();
  let startDate = new Date(runDate);
  startDate.setDate(startDate.getDate() - 60);
  if (!lastBarSnap.empty) {
    const lastDateStr = lastBarSnap.docs[0].id;
    const yr = parseInt(lastDateStr.substring(0, 4));
    const mo = parseInt(lastDateStr.substring(4, 6)) - 1;
    const dy = parseInt(lastDateStr.substring(6, 8));
    const lastDate = new Date(yr, mo, dy);
    startDate = new Date(lastDate);
    startDate.setDate(lastDate.getDate() + 1);
    const today = new Date(runDate);
    if (startDate > today) {
      console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Firestore is already up to date (Last bar: ${lastDateStr}). Skipping fetch.`);
      return false;
    }
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: DELTA FETCH activated. Fetching from ${startDate.toISOString().split("T")[0]} to ${runDate}`);
  }
  let realCandles = [];
  try {
    realCandles = await fetchFromKite(symbol, runDate, settings.apiKey, settings.accessToken, instrumentToken, jobId, startDate);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
    await logger.error(`[MarketData] Kite fetch failed for ${symbol}.`, "MarketData", { jobId, symbol, error: errorMsg });
    throw new Error(`Kite fetch failed for ${symbol}: ${errorMsg}`);
  }
  console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Validating ${realCandles.length} raw candles.`);
  const validCandles = validateCandles(realCandles);
  console.log(`[MarketData] Job ${jobId} symbol ${symbol}: ${validCandles.length} valid candles after filter.`);
  if (validCandles.length === 0) {
    await logger.warn(`No valid candles for ${symbol} around ${runDate} after fetch.`, "MarketData", { jobId, symbol });
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: ABORTING write - zero valid candles.`);
    return false;
  }
  const batch = db.batch();
  for (const c of validCandles) {
    const dateObj2 = c.timestamp.toDate();
    const istDate = new Date(dateObj2.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, "0");
    const day = String(istDate.getDate()).padStart(2, "0");
    const cDateId = `${year}${month}${day}`;
    const docRef = db.collection("barsD").doc(symbol).collection("days").doc(cDateId);
    batch.set(docRef, { ...c, dateId: cDateId });
  }
  batch.set(db.collection("barsD").doc(symbol), {
    lastUpdated: admin2.firestore.FieldValue.serverTimestamp(),
    type: symbol === "NIFTY 50" ? "INDEX" : "EQUITY"
  }, { merge: true });
  console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Committing batch write for ${validCandles.length} candles.`);
  try {
    await batch.commit();
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Batch commit SUCCESS.`);
  } catch (err) {
    console.error(`[MarketData] Job ${jobId} symbol ${symbol}: Batch commit FAILED:`, err);
    throw err;
  }
  await logger.info(`Uploaded ${validCandles.length} candles for ${symbol} (Historical Backfill)`, "MarketData", { jobId, symbol });
  return true;
}
async function fetchCandlesTask(req, res) {
  const { jobId, symbol, runDate } = req.body;
  try {
    await doFetchCandles(jobId, symbol, runDate);
    res.status(200).send("Candles fetched");
  } catch (error) {
    await logger.error(`Failed to fetch candles for ${symbol}: ${error}`, "MarketData", { jobId, symbol, runDate });
    res.status(500).send(error instanceof Error ? error.message : "Unknown error");
  }
}
async function fetchWithRetry(fn, symbol, retries = 3, delay = 1e3) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    const isRateLimit = err?.status === 429 || err?.message?.includes("Too many requests");
    const isTimeout = err?.message?.includes("timeout") || err?.message?.includes("DEADLINE_EXCEEDED") || err?.message?.includes("ECONNABORTED") || err?.error_type === "NetworkException";
    if (isRateLimit || isTimeout) {
      const jitter = Math.floor(Math.random() * 1e3) - 500;
      const actualDelay = Math.max(100, delay + jitter);
      console.warn(`[MarketData] ${symbol} fetch failed (${err.message}): Retrying in ${actualDelay}ms... (${retries} left)`);
      await new Promise((resolve) => setTimeout(resolve, actualDelay));
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
    if (symbol === "NIFTY 50") {
      token = 256265;
    } else {
      const instruments = await getNSEInstruments(apiKey, accessToken);
      if (!instruments) throw new Error("NSE Instruments list is empty or unreachable");
      const searchSymbol = symbol.endsWith(".NS") ? symbol.slice(0, -3) : symbol;
      const instrument = instruments.find((i) => i.tradingsymbol === searchSymbol);
      if (!instrument) {
        throw new Error(`Instrument not found in Kite NSE: ${symbol}`);
      }
      token = instrument.instrument_token;
    }
  }
  const endDate = new Date(runDate);
  const startDate = providedStartDate || new Date(runDate);
  if (!providedStartDate) {
    startDate.setDate(endDate.getDate() - 60);
  }
  await logger.info(`Fetching data for ${symbol} from Kite: ${startDate.toISOString()} to ${endDate.toISOString()}`, "MarketData", { jobId, symbol });
  const results = await fetchWithRetry(() => kite.getHistoricalData(token, "day", startDate, endDate), symbol);
  await logger.info(`Raw result count for ${symbol}: ${results.length}`, "MarketData", { jobId, symbol });
  return results.map((row) => ({
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    timestamp: import_firestore2.Timestamp.fromDate(row.date)
  }));
}
async function updateKiteToken(req, res) {
  const { requestToken, apiKey, apiSecret } = req.body;
  const db = getDb2();
  try {
    const { KiteConnect } = await import("kiteconnect");
    const kite = new KiteConnect({ api_key: apiKey });
    const response = await kite.generateSession(requestToken, apiSecret);
    await db.collection("settings").doc("kite").set({
      apiKey,
      apiSecret,
      accessToken: response.access_token,
      updatedAt: admin2.firestore.Timestamp.now(),
      status: "ACTIVE"
    }, { merge: true });
    res.status(200).send({ message: "Kite session updated and ACTIVE" });
  } catch (error) {
    console.error("Kite session error:", error);
    await db.collection("settings").doc("kite").set({
      status: "ERROR",
      lastError: error instanceof Error ? error.message : "Unknown"
    }, { merge: true });
    res.status(500).send({ error: error instanceof Error ? error.message : "Failed to update Kite session" });
  }
}
async function updateKiteCredentials(req, res) {
  const { apiKey, apiSecret, userId, password, totpSecret } = req.body;
  const db = getDb2();
  const data = {
    apiKey,
    apiSecret,
    updatedAt: admin2.firestore.Timestamp.now()
  };
  if (userId) data.userId = userId;
  if (password) data.password = password;
  if (totpSecret) data.totpSecret = totpSecret;
  if (typeof req.body.disableFallback === "boolean") data.disableFallback = req.body.disableFallback;
  await db.collection("settings").doc("kite").set(data, { merge: true });
  res.status(200).send({ message: "Kite credentials saved" });
}
async function checkKiteHealth(req, res) {
  const db = getDb2();
  const snap = await db.collection("settings").doc("kite").get();
  const data = snap.data();
  if (!data?.accessToken) {
    res.status(200).send({ status: "EXPIRED", reason: "No token found" });
    return;
  }
  try {
    const { KiteConnect } = await import("kiteconnect");
    const kite = new KiteConnect({ api_key: data.apiKey });
    kite.setAccessToken(data.accessToken);
    await kite.getProfile();
    res.status(200).send({ status: "ACTIVE" });
  } catch (err) {
    console.warn("[MarketData] Kite health check failed:", err);
    res.status(200).send({ status: "EXPIRED", error: err instanceof Error ? err.message : "Invalid session" });
  }
}
function validateCandles(bars) {
  return bars.filter((bar) => bar.volume >= 0 && bar.high >= bar.low && bar.close > 0);
}
var admin2, import_firestore2, getDb2, _kite, getKite, _nseInstruments;
var init_marketdata = __esm({
  "src/services/marketdata.ts"() {
    "use strict";
    admin2 = __toESM(require("firebase-admin"));
    import_firestore2 = require("firebase-admin/firestore");
    init_logger();
    getDb2 = () => {
      if (admin2.apps.length === 0) {
        admin2.initializeApp();
        const db = admin2.firestore();
        db.settings({ ignoreUndefinedProperties: true });
        return db;
      }
      return admin2.firestore();
    };
    _kite = null;
    getKite = async (apiKey, accessToken) => {
      if (!_kite || _kite.access_token !== accessToken) {
        const { KiteConnect } = await import("kiteconnect");
        _kite = new KiteConnect({ api_key: apiKey });
        _kite.setAccessToken(accessToken);
      }
      return _kite;
    };
    _nseInstruments = null;
  }
});

// src/services/features.ts
var features_exports = {};
__export(features_exports, {
  computeFeaturesTask: () => computeFeaturesTask,
  doComputeFeatures: () => doComputeFeatures
});
async function doComputeFeatures(jobId, symbol, runDate) {
  const db = getDb3();
  const dateId = runDate.replace(/-/g, "");
  const dateObj = new Date(runDate);
  const dayOfWeek = dateObj.getUTCDay();
  let checkDates = [runDate.replace(/-/g, "")];
  if (dayOfWeek === 6) {
    const fri = new Date(dateObj);
    fri.setDate(dateObj.getDate() - 1);
    checkDates.push(fri.toISOString().split("T")[0].replace(/-/g, ""));
  } else if (dayOfWeek === 0) {
    const fri = new Date(dateObj);
    fri.setDate(dateObj.getDate() - 2);
    checkDates.push(fri.toISOString().split("T")[0].replace(/-/g, ""));
  }
  for (const dId of checkDates) {
    const featSnap = await db.collection("features").doc(symbol).collection("days").doc(dId).get();
    if (featSnap.exists) {
      console.log(`[Features] Job ${jobId} symbol ${symbol}: Features for ${dId} (Ref: ${runDate}) already exist. Skipping computation.`);
      return;
    }
  }
  console.log(`[Job ${jobId}] Computing features for ${symbol} up to ${runDate}`);
  const barsSnap = await db.collection("barsD").doc(symbol).collection("days").where(admin3.firestore.FieldPath.documentId(), "<=", dateId).orderBy(admin3.firestore.FieldPath.documentId(), "asc").get();
  if (barsSnap.empty || barsSnap.size < 25) {
    const errorMsg = `[Features Fail] Insufficient data for ${symbol}. Found ${barsSnap.size} bars. Needs 25.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  const allBars = barsSnap.docs.map((d) => d.data());
  allBars.sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
  const bars = allBars.slice(-200);
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const ti = require("technicalindicators");
  if (!ti) {
    console.error(`[Job ${jobId}] [CRITICAL] technicalindicators library NOT LOADED`);
    throw new Error("technicalindicators library not available");
  }
  const { EMA, RSI, ATR, BollingerBands } = ti;
  const getSafePeriod = (requested, length) => Math.max(2, Math.min(requested, length - 1));
  const ema20Arr = EMA.calculate({ period: getSafePeriod(20, closes.length), values: closes });
  const ema50Arr = EMA.calculate({ period: getSafePeriod(50, closes.length), values: closes });
  const ema200Arr = EMA.calculate({ period: getSafePeriod(200, closes.length), values: closes });
  const rsiArr = RSI.calculate({ period: getSafePeriod(14, closes.length), values: closes });
  const atrArr = ATR.calculate({ period: getSafePeriod(14, closes.length), high: highs, low: lows, close: closes });
  const bbArr = BollingerBands.calculate({ period: getSafePeriod(20, closes.length), stdDev: 2, values: closes });
  const currentClose = closes[closes.length - 1];
  const ema20 = ema20Arr.length > 0 ? ema20Arr[ema20Arr.length - 1] : currentClose;
  const ema50 = ema50Arr.length > 0 ? ema50Arr[ema50Arr.length - 1] : currentClose * 0.98;
  const ema200 = ema200Arr.length > 0 ? ema200Arr[ema200Arr.length - 1] : currentClose * 0.95;
  const rsi14 = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
  const atr14 = atrArr.length > 0 ? atrArr[atrArr.length - 1] : currentClose * 0.02;
  const bb = bbArr.length > 0 ? bbArr[bbArr.length - 1] : { middle: currentClose, lower: currentClose * 0.95, upper: currentClose * 1.05 };
  const atrp = atr14 / currentClose * 100;
  const last100Atrps = atrArr.slice(-100).map((a, i) => a / closes[closes.length - atrArr.length + i] * 100);
  const atrpMa100 = last100Atrps.length > 0 ? last100Atrps.reduce((a, b) => a + b, 0) / last100Atrps.length : atrp;
  const swings = calculateSwings(bars, 3);
  const srZones = identifySRZones(swings);
  let trendState = "RANGE";
  const lastSwingHigh = swings.highs.length > 0 ? swings.highs[swings.highs.length - 1].price : 0;
  const lastSwingLow = swings.lows.length > 0 ? swings.lows[swings.lows.length - 1].price : 0;
  const prevSwingHigh = swings.highs.length > 1 ? swings.highs[swings.highs.length - 2].price : 0;
  const prevSwingLow = swings.lows.length > 1 ? swings.lows[swings.lows.length - 2].price : 0;
  if (ema20 > ema50 && currentClose > ema20 && lastSwingHigh > prevSwingHigh && lastSwingLow > prevSwingLow) {
    trendState = "UP";
  } else if (ema20 < ema50 && currentClose < ema20 && lastSwingHigh < prevSwingHigh && lastSwingLow < prevSwingLow) {
    trendState = "DOWN";
  }
  const featureDoc = {
    ema20,
    ema50,
    ema200,
    rsi14,
    atr14,
    atrp,
    atrpMa100,
    atrPct: atrp,
    bbMid: bb.middle,
    bbLower: bb.lower,
    bbUpper: bb.upper,
    trendState,
    computedAt: import_firestore3.Timestamp.now(),
    swing: {
      lastSwingHigh,
      lastSwingLow
    },
    srZones,
    returns: {
      ret1d: closes[closes.length - 1] / closes[closes.length - 2] - 1,
      ret5d: closes[closes.length - 1] / (closes[closes.length - 6] || closes[0]) - 1,
      ret20d: closes[closes.length - 1] / (closes[closes.length - 21] || closes[0]) - 1
    },
    barsCount: barsSnap.size,
    // Added for dashboard inventory grouping
    patterns: []
    // Patterns logic can be expanded if needed
  };
  await db.collection("features").doc(symbol).collection("days").doc(dateId).set(featureDoc);
  await logger.info(`Features computed for ${symbol}: Trend=${trendState}, RSI=${rsi14.toFixed(2)}`, "Features", { jobId, symbol });
}
function calculateSwings(bars, window = 3) {
  const highs = [];
  const lows = [];
  for (let i = window; i < bars.length - window; i++) {
    const currentHigh = bars[i].high;
    const currentLow = bars[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= window; j++) {
      if (bars[i - j].high >= currentHigh || bars[i + j].high > currentHigh) isHigh = false;
      if (bars[i - j].low <= currentLow || bars[i + j].low < currentLow) isLow = false;
    }
    if (isHigh) highs.push({ price: currentHigh, index: i });
    if (isLow) lows.push({ price: currentLow, index: i });
  }
  return { highs, lows };
}
function identifySRZones(swings) {
  const prices = [...swings.highs, ...swings.lows].map((s) => s.price);
  if (prices.length < 2) return [];
  const zones = [];
  const sorted = prices.sort((a, b) => a - b);
  let currentZone = { low: sorted[0], high: sorted[0], prices: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= currentZone.high * 1.01) {
      currentZone.high = sorted[i];
      currentZone.prices.push(sorted[i]);
    } else {
      zones.push({
        low: currentZone.low * 0.995,
        high: currentZone.high * 1.005,
        strength: currentZone.prices.length
      });
      currentZone = { low: sorted[i], high: sorted[i], prices: [sorted[i]] };
    }
  }
  return zones.sort((a, b) => b.strength - a.strength).slice(0, 5);
}
var functionsV1, admin3, import_firestore3, getDb3, computeFeaturesTask;
var init_features = __esm({
  "src/services/features.ts"() {
    "use strict";
    functionsV1 = __toESM(require("firebase-functions"));
    admin3 = __toESM(require("firebase-admin"));
    import_firestore3 = require("firebase-admin/firestore");
    init_logger();
    getDb3 = () => {
      if (admin3.apps.length === 0) admin3.initializeApp();
      return admin3.firestore();
    };
    computeFeaturesTask = functionsV1.https.onRequest(async (req, res) => {
      const { jobId, symbol, runDate } = req.body;
      try {
        await doComputeFeatures(jobId, symbol, runDate);
        res.status(200).send("Features computed");
      } catch (error) {
        console.error(`Failed to compute features for ${symbol}:`, error);
        res.status(500).send(error instanceof Error ? error.message : "Unknown error");
      }
    });
  }
});

// src/services/regime.ts
var regime_exports = {};
__export(regime_exports, {
  computeRegimeTask: () => computeRegimeTask,
  doComputeRegime: () => doComputeRegime
});
async function getLatestBarOnOrBefore(db, symbol, dateId) {
  const snap = await db.collection("barsD").doc(symbol).collection("days").where(admin4.firestore.FieldPath.documentId(), "<=", dateId).orderBy(admin4.firestore.FieldPath.documentId(), "asc").get();
  if (snap.empty) return null;
  const doc = snap.docs[snap.docs.length - 1];
  return { id: doc.id, ...doc.data() };
}
async function getEma200SlopeNeg(db, symbol, dateId, lookbackBars = 20) {
  const snap = await db.collection("features").doc(symbol).collection("days").where(admin4.firestore.FieldPath.documentId(), "<=", dateId).orderBy(admin4.firestore.FieldPath.documentId(), "asc").get();
  if (snap.empty || snap.size < lookbackBars + 1) return null;
  const docs = snap.docs.slice(-(lookbackBars + 1));
  const first = docs[0].data();
  const last = docs[docs.length - 1].data();
  const ema200First = Number(first.ema200);
  const ema200Last = Number(last.ema200);
  if (!Number.isFinite(ema200First) || !Number.isFinite(ema200Last)) return null;
  return ema200Last - ema200First < 0;
}
async function doComputeRegime(date, jobId, providedIndexSymbol) {
  const db = getDb4();
  const dateId = toDateId(date);
  console.log(`Computing Market Regime for ${date}`);
  let indexSymbol = providedIndexSymbol;
  if (!indexSymbol) {
    const settingsSnap = await db.collection("settings").doc("kite").get();
    const settings = settingsSnap.data();
    indexSymbol = settings?.accessToken ? "NIFTY 50" : "^NSEI";
  }
  const dateObj = /* @__PURE__ */ new Date(date + "T00:00:00Z");
  const dayOfWeek = dateObj.getUTCDay();
  let checkDates = [dateId];
  if (dayOfWeek === 6) {
    const fri = new Date(dateObj.getTime() - 864e5);
    checkDates.push(fri.toISOString().split("T")[0].replace(/-/g, ""));
  } else if (dayOfWeek === 0) {
    const fri = new Date(dateObj.getTime() - 2 * 864e5);
    checkDates.push(fri.toISOString().split("T")[0].replace(/-/g, ""));
  }
  let indexFeatSnap = null;
  let effectiveDateId = dateId;
  for (const dId of checkDates) {
    const snap = await db.collection("features").doc(indexSymbol).collection("days").doc(dId).get();
    if (snap.exists) {
      indexFeatSnap = snap;
      effectiveDateId = dId;
      await logger.info(`[Regime] Found effective features on ${dId}`, "Regime", { jobId, indexSymbol, dId });
      break;
    }
  }
  if (!indexFeatSnap) {
    indexFeatSnap = await db.collection("features").doc(indexSymbol).collection("days").doc(dateId).get();
    effectiveDateId = dateId;
  }
  const latestIndexBar = await getLatestBarOnOrBefore(db, indexSymbol, dateId);
  let marketState = "TRANSITION";
  let riskMultiplier = 0;
  let notes = `Computing regime for ${indexSymbol} on ${date} (using ${effectiveDateId})`;
  if (indexFeatSnap && latestIndexBar) {
    const feat = indexFeatSnap.data();
    const ema20 = Number(feat.ema20);
    const ema50 = Number(feat.ema50);
    const ema200 = Number(feat.ema200);
    const atrp = Number(feat.atrp);
    const atrpMa100 = Number(feat.atrpMa100);
    const trendState = String(feat.trendState || "");
    const currentClose = Number(latestIndexBar.close);
    const hasEma200 = Number.isFinite(ema200) && ema200 > 0;
    const hasVol = Number.isFinite(atrp) && Number.isFinite(atrpMa100) && atrpMa100 > 0;
    const hasClose = Number.isFinite(currentClose) && currentClose > 0;
    const isEma200Bear = hasClose && hasEma200 && currentClose < ema200;
    const isEmaTrendBear = ema20 > 0 && ema50 > 0 && ema20 < ema50;
    const ema200SlopeNeg = await getEma200SlopeNeg(db, indexSymbol, effectiveDateId, 20);
    if (isEma200Bear && (ema200SlopeNeg ?? true)) {
      marketState = "BEAR";
      riskMultiplier = 0.5;
      notes = ema200SlopeNeg === null ? "Index below EMA200. (EMA200 slope unavailable; using position only.)" : "Index below EMA200 with negative EMA200 slope. Long-term bearish bias active.";
    } else if (isEmaTrendBear) {
      marketState = "BEAR";
      riskMultiplier = 0.75;
      notes = "Index EMA20 < EMA50. Short-term bearish trend active.";
    } else if (hasVol && atrp > 1.5 * atrpMa100) {
      marketState = "HIGH_VOL";
      riskMultiplier = 0.5;
      notes = "Volatility spike detected on Index.";
    } else if (trendState === "UP") {
      marketState = "TREND";
      riskMultiplier = 1;
      notes = "Index in confirmed uptrend.";
    } else {
      marketState = "RANGE";
      riskMultiplier = 1;
      notes = "Default range regime.";
    }
  } else {
    const errorParts = [];
    if (!indexFeatSnap) {
      errorParts.push(`Features missing for ${indexSymbol}`);
    }
    if (!latestIndexBar) {
      errorParts.push(`Latest bar missing for ${indexSymbol}`);
    }
    const errorMsg = `[Regime Fail] ${errorParts.join(" & ")} on ${date}. Cannot proceed safely.`;
    await logger.error(errorMsg, "Regime", { jobId, indexSymbol, date, dateId });
    const failRegime = {
      marketState: "TRANSITION",
      tradeAllowed: false,
      riskMultiplier: 0,
      maxNewPositions: 0,
      minSignalScore: 100,
      notes: errorMsg
    };
    await db.collection("regime").doc(dateId).set(failRegime);
    throw new Error(errorMsg);
  }
  const regimeDoc = {
    marketState,
    tradeAllowed: true,
    // Data exists, so trading is theoretically allowed (subject to regime details)
    riskMultiplier,
    // Tighter max positions during stress
    maxNewPositions: marketState === "BEAR" || marketState === "HIGH_VOL" ? 2 : 5,
    // Keep constant for now; you can later adjust per regime/strategy
    minSignalScore: 60,
    notes,
    reason: notes,
    // Consistent with reporting.ts
    metrics: {
      close: Number(latestIndexBar.close),
      ema200: indexFeatSnap.data()?.ema200,
      ema200Slope: await getEma200SlopeNeg(db, indexSymbol, effectiveDateId, 20) === true ? -0.01 : 0.01,
      // Mock slope value for display
      ema20: indexFeatSnap.data()?.ema20
    },
    // Placeholder breadth – recommend making these null/derived later
    breadth: {
      pctAboveEMA50: 65,
      pctAboveEMA200: 70,
      newHighs20: 45,
      newLows20: 5
    }
  };
  await db.collection("regime").doc(dateId).set(regimeDoc);
  if (jobId) {
    await db.collection("jobs").doc(jobId).update({
      marketState,
      updatedAt: admin4.firestore.Timestamp.now()
    });
  }
  return regimeDoc;
}
var functionsV12, admin4, getDb4, toDateId, computeRegimeTask;
var init_regime = __esm({
  "src/services/regime.ts"() {
    "use strict";
    functionsV12 = __toESM(require("firebase-functions"));
    admin4 = __toESM(require("firebase-admin"));
    init_logger();
    getDb4 = () => {
      if (admin4.apps.length === 0) admin4.initializeApp();
      return admin4.firestore();
    };
    toDateId = (date) => date.replace(/-/g, "");
    computeRegimeTask = functionsV12.https.onRequest(async (req, res) => {
      const { date, jobId } = req.query;
      if (!date || typeof date !== "string") {
        res.status(400).send('Missing "date" parameter');
        return;
      }
      try {
        const regimeDoc = await doComputeRegime(date, typeof jobId === "string" ? jobId : void 0);
        res.status(200).send({ message: "Regime computed", regimeDoc });
      } catch (error) {
        console.error("Failed to compute regime:", error);
        res.status(500).send("Internal Error");
      }
    });
  }
});

// src/services/aggregateStats.ts
var aggregateStats_exports = {};
__export(aggregateStats_exports, {
  aggregateStatsTask: () => aggregateStatsTask,
  doAggregateStats: () => doAggregateStats
});
async function doAggregateStats(dateId) {
  const db = getDb5();
  console.log(`[AggregateStats] Aggregating performance for ${dateId}`);
  const signalsSnap = await db.collection("signals").doc(dateId).collection("items").get();
  const groups = {};
  for (const doc of signalsSnap.docs) {
    const signal = doc.data();
    const key = `${signal.strategy}_${signal.reasons.marketState || "UNKNOWN"}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(signal);
  }
  for (const [key, signals] of Object.entries(groups)) {
    const [strategy, marketState] = key.split("_");
    const monitored = signals.filter((s) => s.monitor && s.monitor.r5 !== void 0);
    if (monitored.length === 0) continue;
    const r5List = monitored.map((s) => s.monitor.r5);
    const mfeList = monitored.map((s) => s.monitor.mfeR || 0);
    const maeList = monitored.map((s) => s.monitor.maeR || 0);
    const countSignals = signals.length;
    const avgR5 = r5List.reduce((a, b) => a + b, 0) / r5List.length;
    const medianR5 = r5List.sort((a, b) => a - b)[Math.floor(r5List.length / 2)];
    const avgMFE = mfeList.reduce((a, b) => a + b, 0) / mfeList.length;
    const avgMAE = maeList.reduce((a, b) => a + b, 0) / maeList.length;
    const wins = r5List.filter((r) => r > 0).length;
    const conservativeWinRate = wins / r5List.length * 100;
    const avgWin = r5List.filter((r) => r > 0).reduce((a, b) => a + b, 0) / (wins || 1);
    const avgLoss = Math.abs(r5List.filter((r) => r <= 0).reduce((a, b) => a + b, 0) / (monitored.length - wins || 1));
    const expectancy = conservativeWinRate / 100 * avgWin - (1 - conservativeWinRate / 100) * avgLoss;
    const stats = {
      countSignals,
      countMonitored: monitored.length,
      avgR5,
      medianR5,
      avgMFE,
      avgMAE,
      conservativeWinRate,
      expectancy,
      updatedAt: admin5.firestore.Timestamp.now()
    };
    const path2 = `stats/strategies/${strategy}/regimes/${marketState}/days/${dateId}`;
    await db.doc(path2).set(stats);
    console.log(`[AggregateStats] Updated stats for ${strategy} in ${marketState}: Expectancy=${expectancy.toFixed(2)}`);
  }
}
var functionsV13, admin5, getDb5, aggregateStatsTask;
var init_aggregateStats = __esm({
  "src/services/aggregateStats.ts"() {
    "use strict";
    functionsV13 = __toESM(require("firebase-functions"));
    admin5 = __toESM(require("firebase-admin"));
    getDb5 = () => {
      if (admin5.apps.length === 0) admin5.initializeApp();
      return admin5.firestore();
    };
    aggregateStatsTask = functionsV13.https.onRequest(async (req, res) => {
      const { dateId } = req.body;
      try {
        await doAggregateStats(dateId);
        res.status(200).send("Stats aggregated");
      } catch (error) {
        console.error("Stats aggregation failed:", error);
        res.status(500).send("Internal Error");
      }
    });
  }
});

// src/services/journal.ts
var journal_exports = {};
__export(journal_exports, {
  doDailyAnalytics: () => doDailyAnalytics,
  runDailyAnalytics: () => runDailyAnalytics
});
async function doDailyAnalytics(jobId, runDate) {
  const db = getDb6();
  console.log(`[Job ${jobId}] Running daily analytics for ${runDate}`);
  const dateId = runDate.replace(/-/g, "");
  const summary = {
    runDate,
    signalsGenerated: 15,
    signalsApproved: 3,
    signalsRejected: 12,
    totalPositions: 8,
    equity: 105e3,
    timestamp: import_firestore4.Timestamp.now()
  };
  await db.collection("journals").doc("system").collection("dailyReports").doc(dateId).set(summary);
  console.log(`Daily analytics completed for ${runDate}`);
}
var functionsV14, admin6, import_firestore4, getDb6, runDailyAnalytics;
var init_journal = __esm({
  "src/services/journal.ts"() {
    "use strict";
    functionsV14 = __toESM(require("firebase-functions"));
    admin6 = __toESM(require("firebase-admin"));
    import_firestore4 = require("firebase-admin/firestore");
    getDb6 = () => {
      if (admin6.apps.length === 0) admin6.initializeApp();
      return admin6.firestore();
    };
    runDailyAnalytics = functionsV14.https.onRequest(async (req, res) => {
      const { jobId, runDate } = req.body;
      try {
        await doDailyAnalytics(jobId, runDate);
        res.status(200).send("Analytics complete");
      } catch (error) {
        console.error(`Failed to run daily analytics:`, error);
        res.status(500).send(error instanceof Error ? error.message : "Unknown error");
      }
    });
  }
});

// src/services/reporting.ts
var reporting_exports = {};
__export(reporting_exports, {
  generateJobReport: () => generateJobReport
});
async function generateJobReport(jobId, runDate) {
  const db = getDb7();
  const dateId = runDate.replace(/-/g, "");
  const jobSnap = await db.collection("jobs").doc(jobId).get();
  const jobData = jobSnap.data();
  if (!jobData) throw new Error(`Job ${jobId} not found`);
  const regimeSnap = await db.collection("regime").doc(dateId).get();
  const regimeData = regimeSnap.data();
  const signalsSnap = await db.collection("signals").doc(dateId).collection("items").get();
  const signals = signalsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  let report = `# Run Analysis Report: ${runDate}
`;
  report += `**Job ID:** ${jobId}
`;
  report += `**Status:** ${jobData.status}
`;
  report += `**Market State:** ${jobData.marketState || "UNKNOWN"}

`;
  report += `## 1. Summary Overview
`;
  report += `- **Universe:** ${jobData.universeId || "N/A"}
`;
  report += `- **Data Source:** ${jobData.dataSource || "KITE"}
`;
  report += `- **Total Symbols:** ${jobData.counts?.total || 0}
`;
  report += `- **Successful:** ${jobData.counts?.done || 0}
`;
  report += `- **Failed:** ${jobData.counts?.failed || 0}
`;
  report += `- **Signals Generated:** ${signals.length}
`;
  report += `
## 2. Market Regime Analysis
`;
  if (regimeData) {
    report += `**Current State:** ${regimeData.marketState}

`;
    report += `### Reasoning & Technical Context
`;
    report += `${regimeData.reason || "Calculated based on index SMA/EMA slopes."}

`;
    if (regimeData.metrics) {
      report += `| Metric | Value | Reference |
`;
      report += `|--------|-------|-----------|
`;
      report += `| Index Close | ${regimeData.metrics.close?.toFixed(2) || "N/A"} | Market Level |
`;
      report += `| EMA 200 | ${regimeData.metrics.ema200?.toFixed(2) || "N/A"} | Major Trend |
`;
      report += `| EMA 200 Slope | ${regimeData.metrics.ema200Slope?.toFixed(4) || "N/A"} | Momentum |
`;
      if (regimeData.metrics.ema20) {
        report += `| EMA 20 | ${regimeData.metrics.ema20?.toFixed(2) || "N/A"} | Short Term |
`;
      }
    }
  } else {
    report += `*Regime data not found for this date.*
`;
  }
  report += `
## 3. Signal Portfolio (End-to-End)
`;
  if (signals.length > 0) {
    report += `| Symbol | Strategy | Side | Status | Score | RSI | Volatility | Reasoning |
`;
    report += `|--------|----------|------|--------|-------|-----|------------|-----------|
`;
    for (const sig of signals) {
      const feat = sig.features || {};
      const score = sig.score || "N/A";
      const rsi = feat.rsi14 ? feat.rsi14.toFixed(1) : "N/A";
      const vol = feat.atrPct ? (feat.atrPct * 100).toFixed(2) + "%" : "N/A";
      const reason = sig.reason || "Meets strategy criteria";
      report += `| ${sig.symbol} | ${sig.strategy} | ${sig.direction || "N/A"} | ${sig.status} | ${score} | ${rsi} | ${vol} | ${reason} |
`;
    }
  } else {
    report += `*No signals were generated in this run after evaluating the entire universe.*
`;
  }
  report += `

--- Report generated at ${(/* @__PURE__ */ new Date()).toISOString()} ---`;
  await db.collection("jobs").doc(jobId).collection("reports").doc("final").set({
    content: report,
    format: "markdown",
    createdAt: import_firestore5.Timestamp.now()
  });
  const { logger: logger2 } = await Promise.resolve().then(() => (init_logger(), logger_exports));
  logger2.info(`[Reporting] Generated report for job ${jobId}`, "Reporting", { jobId });
  return report;
}
var admin7, import_firestore5, getDb7;
var init_reporting = __esm({
  "src/services/reporting.ts"() {
    "use strict";
    admin7 = __toESM(require("firebase-admin"));
    import_firestore5 = require("firebase-admin/firestore");
    getDb7 = () => {
      if (admin7.apps.length === 0) admin7.initializeApp();
      return admin7.firestore();
    };
  }
});

// src/config/runtime.ts
var RUNTIME_CONFIG;
var init_runtime = __esm({
  "src/config/runtime.ts"() {
    "use strict";
    RUNTIME_CONFIG = {
      TRADING_ENABLED: true,
      PAPER_ONLY: true,
      MAX_DATA_STALENESS_MINUTES: 1e4,
      // ~7 days (handles future tests/holidays)
      MAX_DAILY_NEW_ENTRIES: 5,
      USE_WEEKLY_BIAS: false
    };
  }
});

// src/services/safety.ts
function checkSafety(lastBar) {
  if (!RUNTIME_CONFIG.TRADING_ENABLED) {
    throw new Error("TRADING_DISABLED: Kill switch is active.");
  }
  if (lastBar) {
    const now = Date.now();
    const barTime = lastBar.timestamp.toMillis();
    const stalenessMinutes = (now - barTime) / (1e3 * 60);
    if (stalenessMinutes > RUNTIME_CONFIG.MAX_DATA_STALENESS_MINUTES) {
      throw new Error(`DATA_STALE: Last bar is ${stalenessMinutes.toFixed(0)} minutes old (threshold: ${RUNTIME_CONFIG.MAX_DATA_STALENESS_MINUTES}).`);
    }
  }
}
var init_safety = __esm({
  "src/services/safety.ts"() {
    "use strict";
    init_runtime();
  }
});

// src/services/strategy.ts
var strategy_exports = {};
__export(strategy_exports, {
  doEvaluateSignals: () => doEvaluateSignals,
  evaluateSignalsTask: () => evaluateSignalsTask
});
async function getRecentBarsOnOrBefore(db, symbol, dateId, limit) {
  const snap = await db.collection("barsD").doc(symbol).collection("days").where(admin8.firestore.FieldPath.documentId(), "<=", dateId).get();
  if (snap.empty) return [];
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id)).slice(-limit);
}
function isFinitePos(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0;
}
async function doEvaluateSignals(jobId, symbol, runDate) {
  const db = getDb8();
  const dateId = toDateId2(runDate);
  const checkId = `${symbol}_${dateId}_PullbackEOD`;
  const existingSig = await db.collection("signals").doc(dateId).collection("items").doc(checkId).get();
  if (existingSig.exists) {
    console.log(`[Strategy] Job ${jobId} symbol ${symbol}: Signals for ${runDate} already exist. Skipping.`);
    return;
  }
  console.log(`[Job ${jobId}] Evaluating signals for ${symbol} on ${runDate}`);
  const featSnap = await db.collection("features").doc(symbol).collection("days").doc(dateId).get();
  if (!featSnap.exists) {
    await logger.warn(`Features not found for ${symbol} on ${runDate}`, "Strategy", { jobId, symbol });
    return;
  }
  const features = featSnap.data();
  const regimeSnap = await db.collection("regime").doc(dateId).get();
  if (!regimeSnap.exists) {
    await logger.warn(`Regime not found for ${runDate}`, "Strategy", { jobId });
    return;
  }
  const regime = regimeSnap.data();
  if (!regime.tradeAllowed) {
    console.log(`Trading disabled for ${runDate} (marketState=${regime.marketState}). Skipping ${symbol}.`);
    return;
  }
  const bars = await getRecentBarsOnOrBefore(db, symbol, dateId, 30);
  if (bars.length === 0) {
    await logger.warn(`No bars found for ${symbol} on or before ${runDate}`, "Strategy", { jobId, symbol });
    return;
  }
  const lastBar = bars[bars.length - 1];
  checkSafety(lastBar);
  if (lastBar.id > dateId) {
    await logger.error(`Latest bar for ${symbol} is ${lastBar.id}, which is AFTER ${dateId}. Data integrity error; skipping.`, "Strategy", { jobId, symbol });
    return;
  }
  if (lastBar.id < dateId) {
    console.log(`[Strategy] Job ${jobId} symbol ${symbol}: Using latest available bar ${lastBar.id} for run date ${dateId} (Weekend/Holiday).`);
  }
  const ema20 = Number(features.ema20);
  const ema50 = Number(features.ema50);
  const rsi = Number(features.rsi14 ?? features.rsi14 ?? features.rsi ?? 50);
  const atr = Number(features.atr14);
  const bbLower = Number(features.bbLower);
  const currentClose = Number(lastBar.close);
  if (!isFinitePos(currentClose) || !isFinitePos(ema20) || !isFinitePos(ema50) || !Number.isFinite(rsi) || !isFinitePos(atr)) {
    await logger.warn(`Missing/invalid indicators for ${symbol} on ${runDate}. Skipping.`, "Strategy", { jobId, symbol });
    return;
  }
  const touchedEmaBand = () => {
    const lower = Math.min(ema20, ema50);
    const upper = Math.max(ema20, ema50);
    const touched = Number(lastBar.low) <= upper && Number(lastBar.high) >= lower;
    const nearEma20 = Math.abs(currentClose - ema20) / ema20 <= 5e-3;
    return touched || nearEma20;
  };
  let weeklyTrendOk = true;
  if (RUNTIME_CONFIG.USE_WEEKLY_BIAS) {
    const date = new Date(runDate);
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
    const weekId = `${d.getUTCFullYear()}${weekNo.toString().padStart(2, "0")}`;
    const weeklyFeatSnap = await db.collection("features").doc(symbol).collection("weeks").where(admin8.firestore.FieldPath.documentId(), "<=", weekId).limit(1).get();
    if (!weeklyFeatSnap.empty) {
      const weeklyFeat = weeklyFeatSnap.docs[0].data();
      const wEma20 = weeklyFeat.ema20 || 0;
      const wEma50 = weeklyFeat.ema50 || 0;
      weeklyTrendOk = wEma20 > wEma50;
    }
  }
  const isLongPullback = (regime.marketState === "TREND" || regime.marketState === "RANGE") && ema20 > ema50 && touchedEmaBand() && rsi >= 40 && rsi <= 55;
  let isBreakout = false;
  if (regime.marketState === "TREND" && ema20 > ema50 && bars.length >= 21) {
    const prev20 = bars.slice(-21, -1);
    const prev20High = Math.max(...prev20.map((b) => Number(b.high)));
    isBreakout = currentClose > prev20High;
  }
  const isMeanReversion = regime.marketState === "RANGE" && isFinitePos(bbLower) && currentClose < bbLower && rsi < 30;
  const isShortBounce = (regime.marketState === "BEAR" || regime.marketState === "HIGH_VOL") && ema20 < ema50 && touchedEmaBand() && rsi >= 45 && rsi <= 65;
  const activeStrategies = [
    { condition: isLongPullback && weeklyTrendOk, name: "PullbackEOD", direction: "BUY" },
    { condition: isShortBounce, name: "ShortBounceEOD", direction: "SELL" },
    { condition: isBreakout && weeklyTrendOk, name: "BreakoutCloseEOD", direction: "BUY" },
    { condition: isMeanReversion && weeklyTrendOk, name: "MeanReversionEOD", direction: "BUY" }
  ].filter((s) => s.condition);
  if (activeStrategies.length === 0) return;
  for (const strat of activeStrategies) {
    const score = 80;
    if (typeof regime.minSignalScore === "number" && score < regime.minSignalScore) {
      continue;
    }
    const stopPrice = strat.direction === "BUY" ? currentClose - atr * 2 : currentClose + atr * 2;
    const targetPrice = strat.direction === "BUY" ? currentClose + atr * 3 : currentClose - atr * 3;
    const signal = {
      symbol,
      direction: strat.direction,
      strategy: strat.name,
      score,
      features,
      // You’re using NEXT_OPEN; for production you may want to compute stop/targets off fill.
      entryPlan: { type: "NEXT_OPEN" },
      stopPrice,
      targets: [targetPrice],
      rr: 1.5,
      checklist: { regimeAligned: true, indicatorMatch: true },
      reasons: {
        rsi,
        close: currentClose,
        ema20,
        ema50,
        marketState: regime.marketState
      },
      status: "NEW"
      // If your Signal model allows extra fields, these are useful:
      // createdAt: admin.firestore.Timestamp.now(),
      // runDateId: dateId,
      // riskMultiplierAtSignal: regime.riskMultiplier
    };
    const signalId = `${symbol}_${dateId}_${strat.name}`;
    await db.collection("signals").doc(dateId).collection("items").doc(signalId).set(signal);
    await logger.info(`Generated ${strat.name} signal for ${symbol} at ${currentClose}`, "Strategy", { jobId, symbol });
  }
}
var functionsV15, admin8, getDb8, toDateId2, evaluateSignalsTask;
var init_strategy = __esm({
  "src/services/strategy.ts"() {
    "use strict";
    functionsV15 = __toESM(require("firebase-functions"));
    admin8 = __toESM(require("firebase-admin"));
    init_runtime();
    init_safety();
    init_logger();
    getDb8 = () => {
      if (admin8.apps.length === 0) admin8.initializeApp();
      return admin8.firestore();
    };
    toDateId2 = (date) => date.replace(/-/g, "");
    evaluateSignalsTask = functionsV15.https.onRequest(async (req, res) => {
      const { jobId, symbol, runDate } = req.body || {};
      if (!jobId || !symbol || !runDate) {
        res.status(400).send("Missing required fields: jobId, symbol, runDate");
        return;
      }
      try {
        await doEvaluateSignals(String(jobId), String(symbol), String(runDate));
        res.status(200).send("Signals evaluated");
      } catch (error) {
        console.error(`Failed to evaluate signals for ${symbol}:`, error);
        res.status(500).send(error instanceof Error ? error.message : "Unknown error");
      }
    });
  }
});

// src/services/risk.ts
var risk_exports = {};
__export(risk_exports, {
  doRiskApproval: () => doRiskApproval,
  riskApproveTask: () => riskApproveTask
});
async function doRiskApproval(jobId, symbol, runDate, signalId) {
  const db = getDb9();
  await logger.info(`[Job ${jobId}] Risk approval for signal ${signalId}`, "Risk", { jobId, signalId });
  const dateId = runDate.replace(/-/g, "");
  const sigSnap = await db.collection("signals").doc(dateId).collection("items").doc(signalId).get();
  const regimeSnap = await db.collection("regime").doc(dateId).get();
  if (!sigSnap.exists || !regimeSnap.exists) {
    await logger.warn(`Signal or Regime not found for ${signalId}`, "Risk", { jobId, signalId });
    return;
  }
  const signal = sigSnap.data();
  const regime = regimeSnap.data();
  if (!regime.tradeAllowed) {
    await sigSnap.ref.update({ status: "REJECTED", reasons: { ...signal.reasons, rejection: "Regime says tradeAllowed=false" } });
    return;
  }
  const portfolioSnap = await db.collection("portfolio").doc("default").get();
  const portfolioData = portfolioSnap.exists ? portfolioSnap.data() : { equity: 1e6, openRiskR: 0 };
  const equity = portfolioData?.equity || 1e6;
  const openRiskR = portfolioData?.openRiskR || 0;
  const heatLimits = {
    TREND: 4,
    RANGE: 3,
    BEAR: 3,
    HIGH_VOL: 2,
    TRANSITION: 0
  };
  const currentHeatLimit = heatLimits[regime.marketState] || 3;
  if (openRiskR >= currentHeatLimit) {
    await sigSnap.ref.update({ status: "REJECTED", reasons: { ...signal.reasons, rejection: `Portfolio heat limit reached: ${openRiskR} >= ${currentHeatLimit}` } });
    return;
  }
  const baseRiskPct = 5e-3;
  let riskBudget = equity * baseRiskPct * regime.riskMultiplier;
  const featSnap = await db.collection("features").doc(symbol).collection("days").doc(dateId).get();
  if (featSnap.exists) {
    const feat = featSnap.data();
    if (feat.atrp > 1.5 * (feat.atrpMa100 || feat.atrp || 0)) {
      riskBudget *= 0.5;
      await logger.info(`Risk reduced for ${symbol} due to ATRP spike: ${feat.atrp?.toFixed(2)}`, "Risk", { jobId, symbol });
    }
  }
  const entryPriceAssumption = signal.reasons.close || signal.stopPrice;
  const stopDistance = Math.abs(entryPriceAssumption - (signal.stopPrice || 0));
  const intendedQty = stopDistance > 0 ? Math.floor(riskBudget / stopDistance) : 0;
  const riskAmount = intendedQty * stopDistance;
  if (intendedQty > 0) {
    const orderId = `ord_${signalId}`;
    const order = {
      symbol: signal.symbol,
      side: signal.direction,
      orderType: signal.entryPlan.type,
      intendedQty,
      intendedEntryRef: "OPEN",
      createdFromSignalId: signalId,
      risk: {
        plannedR: 1,
        riskAmount,
        stopDistance
      },
      status: "CREATED"
    };
    await db.collection("paperOrders").doc(dateId).collection("items").doc(orderId).set(order);
    await sigSnap.ref.update({ status: "ORDERED" });
    await logger.info(`Order ${orderId} created for ${symbol} with Qty ${intendedQty}`, "Risk", { jobId, symbol, orderId });
  } else {
    await sigSnap.ref.update({ status: "REJECTED", reasons: { ...signal.reasons, rejection: "Qty evaluates to 0" } });
  }
}
var functionsV16, admin9, getDb9, riskApproveTask;
var init_risk = __esm({
  "src/services/risk.ts"() {
    "use strict";
    functionsV16 = __toESM(require("firebase-functions"));
    admin9 = __toESM(require("firebase-admin"));
    init_logger();
    getDb9 = () => {
      if (admin9.apps.length === 0) admin9.initializeApp();
      return admin9.firestore();
    };
    riskApproveTask = functionsV16.https.onRequest(async (req, res) => {
      const { jobId, symbol, runDate, signalId } = req.body;
      try {
        await doRiskApproval(jobId, symbol, runDate, signalId);
        res.status(200).send("Risk approval complete");
      } catch (error) {
        console.error(`Failed risk approval for ${signalId}:`, error);
        res.status(500).send(error instanceof Error ? error.message : "Unknown error");
      }
    });
  }
});

// src/services/paperBroker.ts
var paperBroker_exports = {};
__export(paperBroker_exports, {
  doExitSimulation: () => doExitSimulation,
  doOpenFillSimulation: () => doOpenFillSimulation,
  doPlaceOrders: () => doPlaceOrders,
  doSimulateFills: () => doSimulateFills,
  placeOrdersTask: () => placeOrdersTask,
  simulateFillsTask: () => simulateFillsTask
});
async function doPlaceOrders(dateId, jobId) {
  const db = getDb10();
  console.log(`[PaperBroker] Placing orders for ${dateId}`);
  checkSafety();
  const signalsSnap = await db.collection("signals").doc(dateId).collection("items").where("riskApproval.status", "==", "APPROVED").get();
  for (const doc of signalsSnap.docs) {
    const signal = doc.data();
    const signalId = doc.id;
    if (signal.execution?.status) continue;
    const orderId = signalId;
    const order = {
      symbol: signal.symbol,
      side: "BUY",
      orderType: "NEXT_OPEN",
      intendedQty: signal.riskApproval?.sizedQty || 0,
      intendedEntryRef: "OPEN",
      createdFromSignalId: signalId,
      risk: {
        plannedR: 1,
        // Fixed R for now
        riskAmount: signal.riskApproval?.riskAmount || 0,
        stopDistance: Math.abs((signal.reasons.close || 0) - signal.stopPrice)
      },
      status: "ACCEPTED"
    };
    await db.collection("paperOrders").doc(dateId).collection("items").doc(orderId).set(order);
    await db.collection("signals").doc(dateId).collection("items").doc(signalId).update({
      status: "ORDERED",
      execution: {
        status: "ORDERED",
        orderId
      }
    });
    console.log(`[PaperBroker] Order placed for ${signal.symbol}: ${orderId}`);
  }
  if (jobId) {
    await db.collection("jobs").doc(jobId).update({
      stage: "ORDERS",
      updatedAt: admin10.firestore.Timestamp.now()
    });
  }
}
async function doSimulateFills(dateId, nextDateId) {
  const db = getDb10();
  console.log(`[PaperBroker] Simulating fills for orders on ${dateId} using bars from ${nextDateId}`);
  checkSafety();
  const ordersSnap = await db.collection("paperOrders").doc(dateId).collection("items").where("status", "==", "ACCEPTED").get();
  for (const doc of ordersSnap.docs) {
    const order = doc.data();
    const orderId = doc.id;
    const nextBarSnap = await db.collection("barsD").doc(order.symbol).collection("days").doc(nextDateId).get();
    if (!nextBarSnap.exists) {
      console.warn(`[PaperBroker] Next day bar missing for ${order.symbol} on ${nextDateId}. Skipping fill.`);
      continue;
    }
    const nextBar = nextBarSnap.exists ? nextBarSnap.data() : null;
    if (!nextBar) continue;
    const signalSnap = await db.collection("signals").doc(dateId).collection("items").doc(order.createdFromSignalId).get();
    const signal = signalSnap.data();
    const prevClose = signal.reasons.close;
    const atr = signal.reasons.atr14 || 0;
    const openGap = Math.abs(nextBar.open - prevClose);
    if (openGap > 1.5 * atr) {
      await db.collection("paperOrders").doc(dateId).collection("items").doc(orderId).update({ status: "CANCELLED", reason: "GapTooLarge" });
      await db.collection("signals").doc(dateId).collection("items").doc(order.createdFromSignalId).update({ status: "CANCELLED" });
      console.log(`[PaperBroker] Order ${orderId} CANCELLED due to gap: ${openGap.toFixed(2)} > 1.5*ATR`);
      continue;
    }
    const slippage = Math.min(5e-4 * nextBar.open, 0.1 * atr);
    const fillPrice = nextBar.open + slippage;
    const feeBps = 10;
    const feeEstimate = order.intendedQty * fillPrice * feeBps / 1e4;
    const fillId = `fill_${orderId}`;
    const fill = {
      orderId,
      symbol: order.symbol,
      fillPrice,
      fillQty: order.intendedQty,
      slippageBps: 5,
      // Approximate
      feeEstimate,
      fillType: "ENTRY",
      timestamp: admin10.firestore.Timestamp.now()
    };
    await db.collection("paperFills").doc(nextDateId).collection("items").doc(fillId).set(fill);
    await db.collection("paperOrders").doc(dateId).collection("items").doc(orderId).update({ status: "FILLED" });
    await db.collection("signals").doc(dateId).collection("items").doc(order.createdFromSignalId).update({
      status: "IN_TRADE",
      execution: {
        status: "FILLED",
        orderId,
        fillId,
        entryPrice: fillPrice,
        entryDateId: nextDateId
      }
    });
    await db.collection("portfolio").doc("default").collection("positions").doc(order.symbol).set({
      symbol: order.symbol,
      avgEntryPrice: fillPrice,
      qty: order.intendedQty,
      stopPrice: signal.stopPrice,
      targets: signal.targets,
      status: "OPEN",
      openedAt: admin10.firestore.Timestamp.now(),
      lastUpdatedAt: admin10.firestore.Timestamp.now(),
      entryFillId: fillId
    });
    console.log(`[PaperBroker] Order ${orderId} FILLED at ${fillPrice.toFixed(2)}`);
  }
}
async function doOpenFillSimulation(jobId, runDate, symbol) {
  const db = getDb10();
  console.log(`[Job ${jobId}] Simulating open fills for ${symbol} on ${runDate}`);
  const dateId = runDate.replace(/-/g, "");
  const prevDate = new Date(runDate);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevDateId = prevDate.toISOString().split("T")[0].replace(/-/g, "");
  const ordersSnap = await db.collection("paperOrders").doc(prevDateId).collection("items").where("symbol", "==", symbol).where("status", "==", "ACCEPTED").get();
  const batch = db.batch();
  for (const doc of ordersSnap.docs) {
    const order = doc.data();
    const barSnap = await db.collection("barsD").doc(symbol).collection("days").doc(dateId).get();
    if (!barSnap.exists) continue;
    const bar = barSnap.data();
    const sigSnap = await db.collection("signals").doc(prevDateId).collection("items").doc(order.createdFromSignalId).get();
    if (!sigSnap.exists) continue;
    const signal = sigSnap.data();
    const fillPrice = bar.open * 1.0005;
    const fillId = `fill_${doc.id}`;
    const fill = {
      orderId: doc.id,
      symbol,
      fillPrice,
      fillQty: order.intendedQty,
      slippageBps: 5,
      feeEstimate: 20,
      fillType: "ENTRY",
      timestamp: import_firestore6.Timestamp.now()
    };
    const position = {
      symbol,
      avgEntryPrice: fillPrice,
      qty: order.intendedQty,
      stopPrice: signal.stopPrice,
      targets: signal.targets,
      status: "OPEN",
      unrealizedPnl: 0,
      realizedPnl: 0,
      openedAt: import_firestore6.Timestamp.now(),
      lastUpdatedAt: import_firestore6.Timestamp.now(),
      entryFillId: fillId
    };
    batch.set(db.collection("paperFills").doc(dateId).collection("items").doc(fillId), fill);
    batch.set(db.collection("positions").doc(symbol), position);
    batch.update(doc.ref, { status: "FILLED" });
    batch.update(sigSnap.ref, {
      status: "IN_TRADE",
      execution: {
        status: "FILLED",
        orderId: doc.id,
        fillId,
        entryPrice: fillPrice,
        entryDateId: dateId
      }
    });
  }
  await batch.commit();
}
async function doExitSimulation(jobId, runDate, symbol) {
  const db = getDb10();
  console.log(`[Job ${jobId}] Simulating exits for ${symbol} on ${runDate}`);
  const dateId = runDate.replace(/-/g, "");
  const barSnap = await db.collection("barsD").doc(symbol).collection("days").doc(dateId).get();
  if (!barSnap.exists) return;
  const bar = barSnap.data();
  const posSnap = await db.collection("positions").doc(symbol).get();
  if (!posSnap.exists || posSnap.data()?.status !== "OPEN") return;
  const pos = posSnap.data();
  let exitType = null;
  let exitPrice = 0;
  if (bar.low <= pos.stopPrice) {
    exitType = "EXIT_STOP";
    exitPrice = pos.stopPrice;
  } else if (pos.targets.some((t) => bar.high >= t)) {
    exitType = "EXIT_TARGET";
    exitPrice = pos.targets[0];
  }
  if (exitType) {
    const fillId = `exit_${Date.now()}`;
    const fill = {
      orderId: "MANUAL_EXIT",
      symbol,
      fillPrice: exitPrice,
      fillQty: pos.qty,
      slippageBps: 0,
      feeEstimate: 20,
      fillType: exitType,
      timestamp: import_firestore6.Timestamp.now()
    };
    const realizedPnl = (exitPrice - pos.avgEntryPrice) * pos.qty;
    await db.collection("paperFills").doc(dateId).collection("items").doc(fillId).set(fill);
    await posSnap.ref.update({
      status: "CLOSED",
      realizedPnl,
      closedAt: import_firestore6.Timestamp.now(),
      lastUpdatedAt: import_firestore6.Timestamp.now(),
      exitFillId: fillId,
      exitReason: exitType
    });
  } else {
    const unrealizedPnl = (bar.close - pos.avgEntryPrice) * pos.qty;
    await posSnap.ref.update({ unrealizedPnl, lastUpdatedAt: import_firestore6.Timestamp.now() });
  }
}
var functionsV17, admin10, import_firestore6, getDb10, placeOrdersTask, simulateFillsTask;
var init_paperBroker = __esm({
  "src/services/paperBroker.ts"() {
    "use strict";
    functionsV17 = __toESM(require("firebase-functions"));
    admin10 = __toESM(require("firebase-admin"));
    init_safety();
    import_firestore6 = require("firebase-admin/firestore");
    getDb10 = () => {
      if (admin10.apps.length === 0) admin10.initializeApp();
      return admin10.firestore();
    };
    placeOrdersTask = functionsV17.https.onRequest(async (req, res) => {
      const { dateId, jobId } = req.body;
      try {
        await doPlaceOrders(dateId, jobId);
        res.status(200).send("Orders placed");
      } catch (error) {
        console.error("Order placement failed:", error);
        res.status(500).send("Internal Error");
      }
    });
    simulateFillsTask = functionsV17.https.onRequest(async (req, res) => {
      const { dateId, nextDateId } = req.body;
      try {
        await doSimulateFills(dateId, nextDateId);
        res.status(200).send("Fills simulated");
      } catch (error) {
        console.error("Fill simulation failed:", error);
        res.status(500).send("Internal Error");
      }
    });
  }
});

// src/index.ts
var index_exports = {};
__export(index_exports, {
  auditJobs: () => auditJobs2,
  checkKiteHealth: () => checkKiteHealth2,
  cleanupData: () => cleanupData2,
  cleanupUniverse: () => cleanupUniverse2,
  computeFeaturesTask: () => computeFeaturesTask2,
  diagnostics: () => diagnostics2,
  downloadReport: () => downloadReport2,
  evaluateSignalsTask: () => evaluateSignalsTask2,
  fetchCandlesTask: () => fetchCandlesTask2,
  manageTradesTask: () => manageTradesTask2,
  probeInventory: () => probeInventory2,
  probeLogs: () => probeLogs,
  processMorningSymbolTask: () => processMorningSymbolTask2,
  processStageTask: () => processStageTask,
  processSymbolTask: () => processSymbolTask2,
  purgeJobs: () => purgeJobs2,
  riskApproveTask: () => riskApproveTask2,
  seedUniverse: () => seedUniverse2,
  startEodRun: () => startEodRun,
  startMorningExecution: () => startMorningExecution,
  terminateJob: () => terminateJob2,
  updateKiteCredentials: () => updateKiteCredentials2,
  updateKitetoken: () => updateKitetoken,
  updateUniverseFromCsv: () => updateUniverseFromCsv2,
  validateUniverseCsv: () => validateUniverseCsv2
});
module.exports = __toCommonJS(index_exports);
var import_https3 = require("firebase-functions/v2/https");

// src/services/orchestrator.ts
var admin11 = __toESM(require("firebase-admin"));
var import_firestore7 = require("firebase-admin/firestore");
init_logger();

// src/services/tasks.ts
var import_tasks = require("@google-cloud/tasks");
var TaskClient = class {
  constructor() {
    this.client = new import_tasks.CloudTasksClient();
    this.project = process.env.GCLOUD_PROJECT || "suhas-ag";
    this.location = "us-central1";
  }
  /**
   * Internal helper for createTask with retries
   */
  async createTaskWithRetry(request, retries = 3, delay = 1e3) {
    try {
      const [response] = await this.client.createTask(request);
      return response;
    } catch (err) {
      const isTransient = err.message?.includes("DEADLINE_EXCEEDED") || err.message?.includes("name resolution") || err.code === 4 || // DEADLINE_EXCEEDED
      err.code === 14;
      if (isTransient && retries > 0) {
        console.warn(`[TaskClient] Transient error enqueuing task. Retrying in ${delay}ms... (${retries} left). Error: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.createTaskWithRetry(request, retries - 1, delay * 2);
      }
      throw err;
    }
  }
  /**
   * Enqueue a task to a specific Cloud Function (Task Queue)
   */
  async enqueue(functionName, payload) {
    const parent = this.client.queuePath(this.project, this.location, functionName);
    const task = {
      httpRequest: {
        httpMethod: "POST",
        url: `https://${this.location}-${this.project}.cloudfunctions.net/${functionName}`,
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        headers: {
          "Content-Type": "application/json"
        },
        oidcToken: {
          serviceAccountEmail: `${this.project}@appspot.gserviceaccount.com`
        }
      }
    };
    return this.createTaskWithRetry({ parent, task });
  }
  /**
   * Enqueue a dispatch-style task (for onTaskDispatched functions)
   */
  async enqueueDispatch(queueName, payload) {
    const parent = this.client.queuePath(this.project, this.location, queueName);
    const task = {
      dispatchDeadline: { seconds: 60 * 10 },
      // 10 mins
      httpRequest: {
        httpMethod: "POST",
        url: `https://${this.location}-${this.project}.cloudfunctions.net/${queueName}`,
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        headers: {
          "Content-Type": "application/json"
        },
        oidcToken: {
          serviceAccountEmail: `${this.project}@appspot.gserviceaccount.com`
        }
      }
    };
    return this.createTaskWithRetry({ parent, task });
  }
};
var taskClient = new TaskClient();

// src/services/orchestrator.ts
var getDb11 = () => {
  if (admin11.apps.length === 0) {
    admin11.initializeApp();
    const db = admin11.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db;
  }
  return admin11.firestore();
};
var toDateId3 = (date) => date.replace(/-/g, "");
async function getInstrumentTokenMap(apiKey, accessToken) {
  const { getNSEInstruments: getNSEInstruments2 } = await Promise.resolve().then(() => (init_marketdata(), marketdata_exports));
  const instruments = await getNSEInstruments2(apiKey, accessToken);
  const map = {};
  instruments.forEach((i) => {
    map[i.tradingsymbol] = i.instrument_token;
    map[i.tradingsymbol + ".NS"] = i.instrument_token;
  });
  return map;
}
async function doStartEodRun(req, res) {
  const { date, universe = "nifty50" } = req.query;
  if (!date) {
    res.status(400).send({ error: 'Missing "date" query parameter (YYYY-MM-DD)' });
    return;
  }
  const jobId = `eod_${date}_${universe}_${Date.now()}`;
  const db = getDb11();
  const runningJobs = await db.collection("jobs").where("status", "==", "RUNNING").limit(1).get();
  if (!runningJobs.empty) {
    res.status(409).send({
      error: "Job in progress",
      message: "Another job is currently RUNNING. Please wait or terminate it before starting a new one.",
      runningJobId: runningJobs.docs[0].id
    });
    return;
  }
  await db.collection("jobs").doc(jobId).set({
    id: jobId,
    runDate: date,
    universeId: universe,
    type: "EOD_RUN",
    stage: "STARTING",
    status: "RUNNING",
    counts: { total: 0, done: 0, failed: 0 },
    startedAt: admin11.firestore.Timestamp.now(),
    updatedAt: admin11.firestore.Timestamp.now(),
    dataSource: "KITE",
    versionHash: "v3.7Atomic"
  });
  (async () => {
    try {
      await runEodLogic(date, jobId, universe);
      console.log(`[Job ${jobId}] EOD run completed successfully`);
    } catch (err) {
      console.error(`[Job ${jobId}] Critical execution error:`, err);
    }
  })();
  res.status(202).send({
    message: "EOD run triggered successfully",
    jobId,
    trackingUrl: `/jobs/${jobId}`
  });
}
async function doStartMorningExecution(req, res) {
  const { date, universe = "nifty50" } = req.query;
  if (!date) {
    res.status(400).send({ error: 'Missing "date" query parameter' });
    return;
  }
  const jobId = `morning_${date}_${universe}_${Date.now()}`;
  const db = getDb11();
  const runningJobs = await db.collection("jobs").where("status", "==", "RUNNING").limit(1).get();
  if (!runningJobs.empty) {
    res.status(409).send({
      error: "Job in progress",
      message: "Cannot start morning execution while another job is RUNNING.",
      runningJobId: runningJobs.docs[0].id
    });
    return;
  }
  await db.collection("jobs").doc(jobId).set({
    id: jobId,
    runDate: date,
    universeId: universe,
    type: "OPEN_SIM_RUN",
    stage: "STARTING",
    status: "RUNNING",
    counts: { total: 0, done: 0, failed: 0 },
    startedAt: admin11.firestore.Timestamp.now(),
    updatedAt: admin11.firestore.Timestamp.now(),
    dataSource: "KITE",
    versionHash: "v3.7Atomic"
  });
  (async () => {
    try {
      await runMorningLogic(date, jobId, universe);
      console.log(`[Job ${jobId}] Morning execution completed successfully`);
    } catch (err) {
      console.error(`[Job ${jobId}] Morning execution failed:`, err);
    }
  })();
  res.status(202).send({
    message: "Morning execution triggered successfully",
    jobId
  });
}
async function terminateJob(req, res) {
  console.log("[Terminate] Triggered", {
    method: req.method,
    body: req.body,
    query: req.query
  });
  const jobId = req.body?.jobId || req.query?.jobId || req.body?.job_id || req.query?.job_id;
  if (!jobId || typeof jobId !== "string") {
    res.status(400).send({ error: "Missing or invalid jobId" });
    return;
  }
  const db = getDb11();
  const docRef = db.collection("jobs").doc(jobId);
  const snap = await docRef.get();
  if (!snap.exists) {
    res.status(404).send({ error: `Job ${jobId} not found` });
    return;
  }
  await docRef.update({
    status: "FAILED",
    errorMessage: "Terminated by user",
    updatedAt: import_firestore7.Timestamp.now()
  });
  res.status(200).send({ message: "Job termination signal sent", jobId });
}
async function runEodLogic(targetDate, targetJobId, targetUniverse = "nifty50") {
  await logger.info(`>>> [V13] runEodLogic ENTER`, "Orchestrator", { targetDate, targetJobId, targetUniverse });
  console.log(`>>> [CRITICAL LOG] runEodLogic: Date=${targetDate}, JobID=${targetJobId}, Universe=${targetUniverse}`);
  const db = getDb11();
  const settingsSnap = await db.collection("settings").doc("kite").get();
  const settingsData = settingsSnap.data();
  let tokenMap = {};
  if (settingsData?.apiKey && settingsData?.accessToken && settingsData?.status === "ACTIVE") {
    try {
      tokenMap = await getInstrumentTokenMap(settingsData.apiKey, settingsData.accessToken);
    } catch (err) {
      console.error(`[Job ${targetJobId}] Instrument cache fail: ${err}`);
    }
  }
  const universeSnap = await db.collection("universes").doc(targetUniverse).collection("members").get();
  const indexSymbol = "^NSEI";
  const symbols = universeSnap.docs.map((d) => d.id).filter((s) => s !== indexSymbol);
  await db.collection("jobs").doc(targetJobId).update({
    "counts.total": symbols.length,
    stage: "FETCH"
  });
  try {
    const { doFetchCandles: doFetchCandles2 } = await Promise.resolve().then(() => (init_marketdata(), marketdata_exports));
    const { doComputeFeatures: doComputeFeatures2 } = await Promise.resolve().then(() => (init_features(), features_exports));
    const { doComputeRegime: doComputeRegime2 } = await Promise.resolve().then(() => (init_regime(), regime_exports));
    const indexSymbol2 = "^NSEI";
    const kiteIndexSymbol = "NIFTY 50";
    const targetIndex = settingsData?.accessToken ? kiteIndexSymbol : indexSymbol2;
    try {
      await doFetchCandles2(targetJobId, targetIndex, targetDate, tokenMap[targetIndex]);
      await doComputeFeatures2(targetJobId, targetIndex, targetDate);
      await db.collection("jobs").doc(targetJobId).update({ stage: "REGIME" });
      await doComputeRegime2(targetDate, targetJobId, targetIndex);
    } catch (err) {
      console.error(`Index stage failed for ${targetIndex}: ${err}. Continuing to symbol loop.`);
    }
    const dateId = targetDate.replace(/-/g, "");
    const recentIndexSnap = await db.collection("barsD").doc(targetIndex).collection("days").where(admin11.firestore.FieldPath.documentId(), "<=", dateId).orderBy(admin11.firestore.FieldPath.documentId(), "desc").limit(1).get();
    const mostRecentBar = recentIndexSnap.docs[0];
    const isHoliday = (() => {
      if (!mostRecentBar) return true;
      const mostRecentDateId = mostRecentBar.id;
      const fiveDaysAgo = new Date(targetDate);
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
      const fiveDaysAgoId = fiveDaysAgo.toISOString().split("T")[0].replace(/-/g, "");
      return mostRecentDateId < fiveDaysAgoId;
    })();
    if (isHoliday) {
      const msg = `[Job ${targetJobId}] Aborting run: ${targetDate} appears to be a holiday or has no index data (most recent: ${mostRecentBar?.id ?? "none"}).`;
      console.warn(msg);
      await db.collection("jobs").doc(targetJobId).update({
        stage: "COMPLETED",
        status: "SKIPPED",
        error: msg,
        updatedAt: admin11.firestore.Timestamp.now()
      });
      return;
    }
    console.log(`[Job ${targetJobId}] Index check passed. Most recent bar: ${mostRecentBar?.id}. Proceeding with symbol dispatch.`);
    await db.collection("jobs").doc(targetJobId).update({ stage: "SIGNALS" });
    console.log(`[Job ${targetJobId}] Dispatching ${symbols.length} tasks at 350ms intervals...`);
    for (const symbol of symbols) {
      await taskClient.enqueueDispatch("processSymbolTask", {
        jobId: targetJobId,
        symbol,
        date: targetDate,
        token: tokenMap[symbol],
        universe: targetUniverse
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    console.log(`[Job ${targetJobId}] All ${symbols.length} tasks dispatched successfully.`);
    const { doAggregateStats: doAggregateStats2 } = await Promise.resolve().then(() => (init_aggregateStats(), aggregateStats_exports));
    const { doDailyAnalytics: doDailyAnalytics2 } = await Promise.resolve().then(() => (init_journal(), journal_exports));
    await db.collection("jobs").doc(targetJobId).update({ stage: "DONE" });
    try {
      await doAggregateStats2(dateId);
      await doDailyAnalytics2(targetJobId, targetDate);
      const { generateJobReport: generateJobReport2 } = await Promise.resolve().then(() => (init_reporting(), reporting_exports));
      await generateJobReport2(targetJobId, targetDate);
    } catch (err) {
      console.error(`Post-run analysis fail: ${err}`);
    }
    await db.collection("jobs").doc(targetJobId).update({ status: "DONE", updatedAt: import_firestore7.Timestamp.now() });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Job ${targetJobId}] CRITICAL FAIL: ${errMsg}`);
    await db.collection("jobs").doc(targetJobId).update({
      status: "FAILED",
      errorMessage: errMsg,
      updatedAt: import_firestore7.Timestamp.now()
    });
    throw err;
  }
}
async function runMorningLogic(targetDate, targetJobId, targetUniverse = "nifty50") {
  const db = getDb11();
  const newJob = {
    runDate: targetDate,
    universeId: targetUniverse,
    type: "OPEN_SIM_RUN",
    stage: "FETCH",
    status: "RUNNING",
    counts: { total: 0, done: 0, failed: 0 },
    startedAt: import_firestore7.Timestamp.now(),
    updatedAt: import_firestore7.Timestamp.now(),
    dataSource: "KITE",
    versionHash: "v3.7Atomic"
  };
  const universeSnap = await db.collection("universes").doc(targetUniverse).collection("members").get();
  const symbols = universeSnap.docs.map((d) => d.id);
  newJob.counts.total = symbols.length;
  await db.collection("jobs").doc(targetJobId).set(newJob);
  try {
    await db.collection("jobs").doc(targetJobId).update({ stage: "ORDERS" });
    const taskPromises = symbols.map(
      (symbol) => taskClient.enqueueDispatch("processMorningSymbolTask", {
        jobId: targetJobId,
        date: targetDate,
        symbol
      })
    );
    await Promise.all(taskPromises);
    console.log(`[Morning Job ${targetJobId}] Dispatched ${taskPromises.length} symbol tasks.`);
    await db.collection("jobs").doc(targetJobId).update({ stage: "DONE", status: "DONE", updatedAt: import_firestore7.Timestamp.now() });
    try {
      const { generateJobReport: generateJobReport2 } = await Promise.resolve().then(() => (init_reporting(), reporting_exports));
      await generateJobReport2(targetJobId, targetDate);
    } catch (repErr) {
      console.error(`[Morning] Report generation failed for ${targetJobId}: ${repErr}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Morning Job ${targetJobId}] CRITICAL FAIL: ${errMsg}`);
    await db.collection("jobs").doc(targetJobId).update({
      status: "FAILED",
      errorMessage: errMsg,
      updatedAt: import_firestore7.Timestamp.now()
    });
    throw err;
  }
}
async function processSymbolTask(req) {
  console.log(">>> [V2-PUB] processSymbolTask ENTER", req.body);
  const { jobId, symbol, date, token } = req.body;
  if (!jobId || !symbol || !date) {
    console.error("[processSymbolTask] Missing required parameters", req.body);
    return;
  }
  const db = getDb11();
  const dateId = toDateId3(date);
  try {
    const { doFetchCandles: doFetchCandles2 } = await Promise.resolve().then(() => (init_marketdata(), marketdata_exports));
    const { doComputeFeatures: doComputeFeatures2 } = await Promise.resolve().then(() => (init_features(), features_exports));
    const { doEvaluateSignals: doEvaluateSignals2 } = await Promise.resolve().then(() => (init_strategy(), strategy_exports));
    const { doRiskApproval: doRiskApproval2 } = await Promise.resolve().then(() => (init_risk(), risk_exports));
    await doFetchCandles2(jobId, symbol, date, token);
    await doComputeFeatures2(jobId, symbol, date);
    await doEvaluateSignals2(jobId, symbol, date);
    const sigSnap = await db.collection("signals").doc(dateId).collection("items").where("symbol", "==", symbol).get();
    for (const sigDoc of sigSnap.docs) {
      if (sigDoc.data().status === "NEW") {
        await doRiskApproval2(jobId, symbol, date, sigDoc.id);
      }
    }
    const jobRef = db.collection("jobs").doc(jobId);
    const updatedJob = await db.runTransaction(async (t) => {
      const doc = await t.get(jobRef);
      if (!doc.exists) return null;
      const data = doc.data();
      const newDone = (data.counts?.done || 0) + 1;
      t.update(jobRef, {
        "counts.done": newDone,
        updatedAt: import_firestore7.Timestamp.now()
      });
      return { ...data, counts: { ...data.counts, done: newDone } };
    });
    if (updatedJob && updatedJob.counts.done + (updatedJob.counts.failed || 0) >= updatedJob.counts.total) {
      console.log(`[Job ${jobId}] Final symbol processed. Triggering wrap-up.`);
      const { doAggregateStats: doAggregateStats2 } = await Promise.resolve().then(() => (init_aggregateStats(), aggregateStats_exports));
      const { doDailyAnalytics: doDailyAnalytics2 } = await Promise.resolve().then(() => (init_journal(), journal_exports));
      const { generateJobReport: generateJobReport2 } = await Promise.resolve().then(() => (init_reporting(), reporting_exports));
      await jobRef.update({ stage: "DONE" });
      await doAggregateStats2(dateId);
      await doDailyAnalytics2(jobId, date);
      await generateJobReport2(jobId, date);
      await jobRef.update({ status: "DONE", updatedAt: import_firestore7.Timestamp.now() });
    }
  } catch (err) {
    console.error(`[Job ${jobId}] Failed for ${symbol}:`, err);
    await db.collection("jobs").doc(jobId).update({
      "counts.failed": admin11.firestore.FieldValue.increment(1),
      updatedAt: import_firestore7.Timestamp.now()
    });
  }
}
async function processMorningSymbolTask(req) {
  console.log(">>> [V2-PUB] processMorningSymbolTask ENTER", req.body);
  const { jobId, date, symbol } = req.body;
  if (!jobId || !symbol || !date) return;
  const db = getDb11();
  const jobRef = db.collection("jobs").doc(jobId);
  try {
    const { doOpenFillSimulation: doOpenFillSimulation2 } = await Promise.resolve().then(() => (init_paperBroker(), paperBroker_exports));
    await doOpenFillSimulation2(jobId, date, symbol);
    const updatedJob = await db.runTransaction(async (t) => {
      const doc = await t.get(jobRef);
      if (!doc.exists) return null;
      const data = doc.data();
      const newDone = (data.counts?.done || 0) + 1;
      t.update(jobRef, {
        "counts.done": newDone,
        updatedAt: import_firestore7.Timestamp.now()
      });
      return { ...data, counts: { ...data.counts, done: newDone } };
    });
    if (updatedJob && updatedJob.counts.done + (updatedJob.counts.failed || 0) >= updatedJob.counts.total) {
      console.log(`[Morning Job ${jobId}] All symbols processed. Wrapping up.`);
      await jobRef.update({ stage: "DONE", status: "DONE", updatedAt: import_firestore7.Timestamp.now() });
      try {
        const { generateJobReport: generateJobReport2 } = await Promise.resolve().then(() => (init_reporting(), reporting_exports));
        await generateJobReport2(jobId, date);
      } catch (repErr) {
        console.error(`[Morning] Report generation failed: ${repErr}`);
      }
    }
  } catch (err) {
    console.error(`[Morning Job ${jobId}] Failed for ${symbol}:`, err);
    await jobRef.update({
      "counts.failed": admin11.firestore.FieldValue.increment(1),
      updatedAt: import_firestore7.Timestamp.now()
    });
  }
}

// src/services/maintenance.ts
var import_https = require("firebase-functions/v2/https");
var admin12 = __toESM(require("firebase-admin"));
var getDb12 = () => {
  if (admin12.apps.length === 0) admin12.initializeApp();
  return admin12.firestore();
};
var cleanupData = (0, import_https.onRequest)({ timeoutSeconds: 540, memory: "512MiB" }, async (req, res) => {
  const db = getDb12();
  const results = {};
  try {
    const jobsSnap = await db.collection("jobs").get();
    const jobBatch = db.batch();
    jobsSnap.docs.forEach((doc) => jobBatch.delete(doc.ref));
    await jobBatch.commit();
    results.jobsDeleted = jobsSnap.size;
    const logsSnap = await db.collection("logs").get();
    for (const logDoc of logsSnap.docs) {
      const entriesSnap = await logDoc.ref.collection("entries").get();
      const entriesBatch = db.batch();
      entriesSnap.docs.forEach((doc) => entriesBatch.delete(doc.ref));
      await entriesBatch.commit();
      await logDoc.ref.delete();
    }
    results.logsDeleted = logsSnap.size;
    const signalsSnap = await db.collection("signals").get();
    for (const sigDoc of signalsSnap.docs) {
      const itemsSnap = await sigDoc.ref.collection("items").get();
      const itemsBatch = db.batch();
      itemsSnap.docs.forEach((doc) => itemsBatch.delete(doc.ref));
      await itemsBatch.commit();
      await sigDoc.ref.delete();
    }
    results.signalsDeleted = signalsSnap.size;
    const featuresSnap = await db.collection("features").get();
    for (const featDoc of featuresSnap.docs) {
      const daysSnap = await featDoc.ref.collection("days").get();
      const daysBatch = db.batch();
      daysSnap.docs.forEach((doc) => daysBatch.delete(doc.ref));
      await daysBatch.commit();
      await featDoc.ref.delete();
    }
    results.featuresDeleted = featuresSnap.size;
    res.status(200).send({
      message: "Workspace cleaned successfully",
      stats: results
    });
  } catch (error) {
    console.error("Failed to cleanup data:", error);
    res.status(500).send({
      error: "Failed to cleanup data",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});
var auditJobs = (0, import_https.onRequest)({ cors: true }, async (req, res) => {
  const db = getDb12();
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1e3);
  try {
    const stuckJobsSnap = await db.collection("jobs").where("status", "==", "RUNNING").get();
    const stuckJobs = stuckJobsSnap.docs.filter((doc) => {
      const data = doc.data();
      return data.updatedAt && data.updatedAt.toMillis() < fifteenMinsAgo.getTime();
    });
    if (stuckJobs.length === 0) {
      res.status(200).send({ message: "No stuck jobs found" });
      return;
    }
    const batch = db.batch();
    stuckJobs.forEach((doc) => {
      batch.update(doc.ref, {
        status: "FAILED",
        errorMessage: "Stuck process: No updates for 15+ minutes",
        updatedAt: admin12.firestore.Timestamp.now()
      });
    });
    await batch.commit();
    res.status(200).send({
      message: `Audited ${stuckJobsSnap.size} stuck jobs`,
      jobIds: stuckJobsSnap.docs.map((d) => d.id)
    });
  } catch (err) {
    console.error("Audit failed:", err);
    res.status(500).send({ error: "Audit failed", details: String(err) });
  }
});
var purgeJobs = (0, import_https.onRequest)({ cors: true }, async (req, res) => {
  const db = getDb12();
  try {
    const snap = await db.collection("jobs").limit(500).get();
    if (snap.empty) {
      res.status(200).send({ message: "No jobs to purge." });
      return;
    }
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    res.status(200).send({ message: `Purged ${snap.size} jobs successfully.` });
  } catch (err) {
    console.error("Purge failed:", err);
    res.status(500).send({ error: "Purge failed", details: String(err) });
  }
});

// src/index.ts
init_marketdata();

// src/services/universe.ts
var admin13 = __toESM(require("firebase-admin"));
var getDb13 = () => {
  if (admin13.apps.length === 0) {
    admin13.initializeApp();
    const db = admin13.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db;
  }
  return admin13.firestore();
};
async function seedUniverse(req, res) {
  try {
    const db = getDb13();
    const customSymbols = req.body?.symbols;
    const targetUniverse = req.body?.universe;
    if (customSymbols && targetUniverse) {
      console.log(`Seeding custom universe: ${targetUniverse} with ${customSymbols.length} symbols`);
      const batch = db.batch();
      for (const s of customSymbols) {
        const docRef = db.collection("universes").doc(targetUniverse).collection("members").doc(s);
        batch.set(docRef, { symbol: s, sector: "CUSTOM", liquidityBucket: "A" });
      }
      await batch.commit();
      res.status(200).send({ message: `Universe ${targetUniverse} seeded`, count: customSymbols.length });
      return;
    }
    const SAMPLE_CONSTITUENTS = [
      { symbol: "RELIANCE.NS", sector: "ENERGY" },
      { symbol: "TCS.NS", sector: "IT" },
      { symbol: "HDFCBANK.NS", sector: "FINANCIAL SERVICES" },
      { symbol: "INFY.NS", sector: "IT" },
      { symbol: "ICICIBANK.NS", sector: "FINANCIAL SERVICES" }
    ];
    const universes = [
      { id: "sample", data: SAMPLE_CONSTITUENTS }
    ];
    const BATCH_SIZE = 400;
    const results = {};
    for (const universe of universes) {
      const symbols = universe.data;
      console.log(`Seeding universe: ${universe.id} with ${symbols.length} symbols`);
      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const chunk = symbols.slice(i, i + BATCH_SIZE);
        const batch = db.batch();
        for (const s of chunk) {
          const docRef = db.collection("universes").doc(universe.id).collection("members").doc(s.symbol);
          const member = {
            symbol: s.symbol,
            sector: s.sector,
            liquidityBucket: "A"
          };
          batch.set(docRef, member);
        }
        await batch.commit();
      }
      results[universe.id] = symbols.length;
    }
    res.status(200).send({
      message: "Universes seeded successfully",
      stats: results
    });
  } catch (error) {
    console.error("Failed to seed universe:", error);
    res.status(500).send({
      error: "Failed to seed universe",
      details: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : void 0
    });
  }
}
async function cleanupUniverse(req, res) {
  try {
    const db = getDb13();
    const { universe = "nifty500" } = req.query;
    const { getNSEInstruments: getNSEInstruments2 } = await Promise.resolve().then(() => (init_marketdata(), marketdata_exports));
    const settingsSnap = await db.collection("settings").doc("kite").get();
    const settings = settingsSnap.data();
    if (!settings?.apiKey || !settings?.accessToken) {
      res.status(401).send({ error: "Kite credentials missing or inactive" });
      return;
    }
    const instruments = await getNSEInstruments2(settings.apiKey, settings.accessToken);
    const kiteSymbols = new Set(instruments.map((i) => i.tradingsymbol));
    const snap = await db.collection("universes").doc(universe).collection("members").get();
    const members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const stale = [];
    for (const m of members) {
      const search = m.id.endsWith(".NS") ? m.id.slice(0, -3) : m.id;
      if (!kiteSymbols.has(search)) {
        stale.push(m.id);
      }
    }
    if (stale.length === 0) {
      res.status(200).send({ message: `No stale members found in ${universe}`, count: members.length });
      return;
    }
    const BATCH_SIZE = 400;
    let deletedCount = 0;
    for (let i = 0; i < stale.length; i += BATCH_SIZE) {
      const chunk = stale.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      for (const s of chunk) {
        batch.delete(db.collection("universes").doc(universe).collection("members").doc(s));
      }
      await batch.commit();
      deletedCount += chunk.length;
    }
    res.status(200).send({
      message: `Cleaned up universe ${universe}`,
      originalCount: members.length,
      deletedCount,
      remainingCount: members.length - deletedCount,
      staleSamples: stale.slice(0, 10)
    });
  } catch (error) {
    console.error("Failed to cleanup universe:", error);
    res.status(500).send({ error: "Failed to cleanup universe", details: error instanceof Error ? error.message : String(error) });
  }
}
async function validateUniverseCsv(req, res) {
  try {
    const db = getDb13();
    const { csvContent } = req.body;
    if (!csvContent) {
      res.status(400).send({ error: "csvContent is required in body" });
      return;
    }
    const { getNSEInstruments: getNSEInstruments2 } = await Promise.resolve().then(() => (init_marketdata(), marketdata_exports));
    const settingsSnap = await db.collection("settings").doc("kite").get();
    const settings = settingsSnap.data();
    if (!settings?.apiKey || !settings?.accessToken) {
      res.status(401).send({ error: "Kite credentials missing or inactive" });
      return;
    }
    const instruments = await getNSEInstruments2(settings.apiKey, settings.accessToken);
    const kiteSymbols = new Set(instruments.map((i) => i.tradingsymbol));
    const lines = csvContent.split("\n");
    const symbolsWithMeta = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
      if (parts.length >= 3) {
        const name = parts[0].replace(/\"/g, "");
        const sector = parts[1].replace(/\"/g, "");
        const symbol = parts[2].trim();
        if (symbol && symbol !== "Symbol") {
          symbolsWithMeta.push({ symbol, sector, name });
        }
      }
    }
    const found = [];
    const missing = [];
    for (const item of symbolsWithMeta) {
      if (kiteSymbols.has(item.symbol)) {
        found.push(item);
      } else {
        missing.push(item);
      }
    }
    res.status(200).send({
      totalCsvSymbols: symbolsWithMeta.length,
      foundCount: found.length,
      missingCount: missing.length,
      missingSymbols: missing.map((m) => m.symbol),
      foundSample: found.slice(0, 10),
      isReady: missing.length === 0
    });
  } catch (error) {
    console.error("Validation failed:", error);
    res.status(500).send({ error: "Validation failed", details: error instanceof Error ? error.message : String(error) });
  }
}
async function updateUniverseFromCsv(req, res) {
  try {
    const db = getDb13();
    const { csvContent, universe = "nifty500", append = false } = req.body;
    if (!csvContent) {
      res.status(400).send({ error: "csvContent is required" });
      return;
    }
    const lines = csvContent.split("\n");
    const symbolsWithMeta = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
      if (parts.length >= 3) {
        const name = parts[0].replace(/\"/g, "");
        const sector = parts[1].replace(/\"/g, "");
        const symbol = parts[2].trim();
        if (symbol && symbol !== "Symbol") {
          const fullSymbol = symbol.endsWith(".NS") ? symbol : `${symbol}.NS`;
          symbolsWithMeta.push({ symbol: fullSymbol, sector, name });
        }
      }
    }
    if (!append) {
      console.log(`Clearing existing members of universe: ${universe}`);
      const membersSnap = await db.collection("universes").doc(universe).collection("members").get();
      const BATCH_SIZE2 = 400;
      for (let i = 0; i < membersSnap.docs.length; i += BATCH_SIZE2) {
        const chunk = membersSnap.docs.slice(i, i + BATCH_SIZE2);
        const batch = db.batch();
        chunk.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
      }
    }
    console.log(`Writing ${symbolsWithMeta.length} members to universe: ${universe}`);
    const BATCH_SIZE = 400;
    for (let i = 0; i < symbolsWithMeta.length; i += BATCH_SIZE) {
      const chunk = symbolsWithMeta.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      for (const item of chunk) {
        const docRef = db.collection("universes").doc(universe).collection("members").doc(item.symbol);
        batch.set(docRef, {
          symbol: item.symbol,
          sector: item.sector,
          name: item.name,
          liquidityBucket: "A",
          updatedAt: admin13.firestore.Timestamp.now()
        });
      }
      await batch.commit();
    }
    res.status(200).send({
      message: `Universe ${universe} updated successfully`,
      count: symbolsWithMeta.length,
      append
    });
  } catch (error) {
    console.error("Update failed:", error);
    res.status(500).send({ error: "Update failed", details: error instanceof Error ? error.message : String(error) });
  }
}

// src/services/diag.ts
var functionsV18 = __toESM(require("firebase-functions"));
var import_https2 = require("firebase-functions/v2/https");
var admin14 = __toESM(require("firebase-admin"));
var getDb14 = () => {
  if (admin14.apps.length === 0) {
    admin14.initializeApp();
    const db = admin14.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db;
  }
  return admin14.firestore();
};
var downloadReport = async (req, res) => {
  const { jobId } = req.query;
  if (!jobId) {
    res.status(400).send({ error: "Missing jobId query parameter" });
    return;
  }
  const db = getDb14();
  const snap = await db.collection("jobs").doc(jobId).collection("reports").doc("final").get();
  if (!snap.exists) {
    res.status(404).send({ error: "Report not found for this job" });
    return;
  }
  const data = snap.data();
  res.setHeader("Content-Type", "text/markdown");
  res.setHeader("Content-Disposition", `attachment; filename="report_${jobId}.md"`);
  res.send(data.content);
};
var diagnostics = functionsV18.https.onRequest(async (req, res) => {
  const db = getDb14();
  const { type = "jobs" } = req.query;
  try {
    switch (type) {
      case "jobs": {
        const { limit = 20 } = req.query;
        const finalLimit = Math.min(Math.max(Number(limit), 1), 100);
        const snap = await db.collection("jobs").orderBy("startedAt", "desc").limit(finalLimit).get();
        const jobs = await Promise.all(snap.docs.map(async (doc) => {
          const data = doc.data();
          const reportSnap = await doc.ref.collection("reports").doc("final").get();
          return { id: doc.id, ...data, hasReport: reportSnap.exists };
        }));
        res.json({ value: jobs, Count: jobs.length });
        break;
      }
      case "errors": {
        const { limit = 50 } = req.query;
        const finalLimit = Math.min(Math.max(Number(limit), 1), 100);
        const snap = await db.collection("system_errors").orderBy("timestamp", "desc").limit(finalLimit).get();
        const errors = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        res.json({ value: errors, Count: errors.length });
        break;
      }
      case "logs": {
        const { jobId, date, level } = req.query;
        const dateId = date ? date.replace(/-/g, "") : (/* @__PURE__ */ new Date()).toISOString().split("T")[0].replace(/-/g, "");
        let query = db.collection("logs").doc(dateId).collection("entries");
        if (jobId) query = query.where("metadata.jobId", "==", jobId);
        if (level) query = query.where("level", "==", level);
        const snapshot = await query.limit(100).get();
        const logs = snapshot.docs.map((doc) => doc.data());
        res.json({ count: logs.length, jobId: jobId || "all", date: dateId, level: level || "all", logs });
        break;
      }
      case "features": {
        const { symbol = "NIFTY 50", colType = "days", includeBar = "false" } = req.query;
        const col = colType === "weeks" ? "weeks" : "days";
        const snap = await db.collection("features").doc(symbol).collection(col).get();
        const lastDoc = snap.empty ? null : snap.docs[snap.docs.length - 1].data();
        let barData = null;
        if (includeBar === "true" && !snap.empty) {
          const lastDateId = snap.docs[snap.docs.length - 1].id;
          const barSnap = await db.collection("barsD").doc(symbol).collection("days").doc(lastDateId).get();
          if (barSnap.exists) barData = barSnap.data();
        }
        res.json({ symbol, type: col, count: snap.size, last5: snap.docs.slice(-5).map((d) => d.id), lastData: lastDoc, barData });
        break;
      }
      case "bars": {
        const { symbol = "NIFTY 50", colType = "days" } = req.query;
        const col = colType === "weeks" ? "weeks" : "days";
        const snap = await db.collection("barsD").doc(symbol).collection(col).get();
        res.json({ symbol, type: col, count: snap.size, last5: snap.docs.slice(-5).map((d) => d.id) });
        break;
      }
      case "universe": {
        const { universe = "nifty500", limit = 1e3 } = req.query;
        const snap = await db.collection("universes").doc(universe).collection("members").limit(Number(limit)).get();
        const members = snap.docs.map((d) => d.id);
        res.json({ universe, totalInFirestore: members.length, members: members.slice(0, 50) });
        break;
      }
      case "signals": {
        const { date, limit = 100, status = "ORDERED" } = req.query;
        const dateId = date ? date.replace(/-/g, "") : (/* @__PURE__ */ new Date()).toISOString().split("T")[0].replace(/-/g, "");
        let query = db.collection("signals").doc(dateId).collection("items");
        if (status !== "all") {
          query = query.where("status", "==", status);
        }
        const snap = await query.limit(Number(limit)).get();
        const signals = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        res.json({ dateId, count: signals.length, signals });
        break;
      }
      default:
        res.status(400).send({ error: `Unknown diagnostic type: ${type}` });
    }
  } catch (err) {
    console.error(`Diagnostics failed for ${type}:`, err);
    res.status(500).send({ error: "Diagnostics failed", details: err.message });
  }
});
var probeInventory = (0, import_https2.onRequest)({ cors: true, invoker: "public", memory: "1GiB", timeoutSeconds: 300 }, async (req, res) => {
  const db = getDb14();
  try {
    const symbolRefs = await db.collection("barsD").listDocuments();
    const inventoryMap = {};
    const BATCH_SIZE = 20;
    const sampleLimit = 200;
    const targetRefs = symbolRefs.slice(0, sampleLimit);
    for (let i = 0; i < targetRefs.length; i += BATCH_SIZE) {
      const chunk = targetRefs.slice(i, i + BATCH_SIZE);
      await Promise.all(chunk.map(async (ref) => {
        const daysSnap = await ref.collection("days").get();
        const count = daysSnap.size || 0;
        if (count > 0) {
          inventoryMap[count] = (inventoryMap[count] || 0) + 1;
        }
      }));
    }
    const groupings = Object.entries(inventoryMap).map(([bars, symbols]) => ({ bars: Number(bars), symbols })).sort((a, b) => b.bars - a.bars);
    res.status(200).json({
      groupings,
      totalSymbolsTracked: symbolRefs.length,
      sampleSize: targetRefs.length,
      timestamp: admin14.firestore.Timestamp.now().toDate().toISOString()
    });
  } catch (err) {
    console.error("Probe Inventory failed:", err);
    res.status(500).send({ error: "Failed to build inventory", details: err.message });
  }
});

// src/index.ts
init_features();
init_strategy();
init_risk();

// src/services/tradeManager.ts
var functionsV19 = __toESM(require("firebase-functions"));
var admin15 = __toESM(require("firebase-admin"));
init_safety();
var getDb15 = () => {
  if (admin15.apps.length === 0) admin15.initializeApp();
  return admin15.firestore();
};
async function doManageTrades(dateId) {
  const db = getDb15();
  console.log(`[TradeManager] Managing open trades for ${dateId}`);
  checkSafety();
  const signalsSnap = await db.collectionGroup("items").where("status", "==", "IN_TRADE").get();
  for (const doc of signalsSnap.docs) {
    const signal = doc.data();
    const signalId = doc.id;
    const symbol = signal.symbol;
    const entryPrice = signal.execution?.entryPrice || 0;
    const entryDateId = signal.execution?.entryDateId || "";
    const stopPrice = signal.stopPrice;
    const target = signal.targets[0];
    const riskPerShare = Math.abs(entryPrice - stopPrice);
    if (riskPerShare === 0) continue;
    const barsSnap = await db.collection("barsD").doc(symbol).collection("days").where(admin15.firestore.FieldPath.documentId(), ">=", entryDateId).where(admin15.firestore.FieldPath.documentId(), "<=", dateId).get();
    const bars = barsSnap.docs.map((d) => d.data()).sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
    if (bars.length === 0) continue;
    const currentBar = bars[bars.length - 1];
    const highSeen = Math.max(...bars.map((b) => b.high));
    const lowSeen = Math.min(...bars.map((b) => b.low));
    const mfeR = (highSeen - entryPrice) / riskPerShare;
    const maeR = (entryPrice - lowSeen) / riskPerShare;
    let exitPrice = null;
    let exitType = null;
    if (currentBar.low <= stopPrice) {
      exitPrice = Math.min(currentBar.open, stopPrice);
      exitType = "EXIT_STOP";
    } else if (currentBar.high >= target) {
      exitPrice = target;
      exitType = "EXIT_TARGET";
    } else if (mfeR >= 1 && currentBar.close <= entryPrice) {
      exitPrice = currentBar.close;
      exitType = "EXIT_THESIS";
    } else if (bars.length >= 5 && mfeR < 0.5) {
      exitPrice = currentBar.close;
      exitType = "EXIT_TIME";
    } else if (mfeR >= 2 && currentBar.close <= entryPrice + 0.5 * riskPerShare) {
      exitPrice = currentBar.close;
      exitType = "EXIT_THESIS";
    }
    if (exitPrice !== null && exitType !== null) {
      console.log(`[TradeManager] Exiting ${symbol} at ${exitPrice.toFixed(2)} (${exitType})`);
      const exitFillId = `exit_${signalId}_${dateId}`;
      const exitFill = {
        orderId: signal.execution?.orderId || "",
        symbol,
        fillPrice: exitPrice,
        fillQty: signal.riskApproval?.sizedQty || 0,
        slippageBps: 5,
        feeEstimate: 0,
        fillType: exitType,
        timestamp: admin15.firestore.Timestamp.now()
      };
      await db.collection("paperFills").doc(dateId).collection("items").doc(exitFillId).set(exitFill);
      const tradeId = `trade_${signalId}`;
      const trade = {
        symbol,
        direction: signal.direction,
        entryPrice,
        entryDateId,
        exitPrice,
        exitDateId: dateId,
        qty: signal.riskApproval?.sizedQty || 0,
        pnl: (exitPrice - entryPrice) * (signal.riskApproval?.sizedQty || 0),
        rMultiple: (exitPrice - entryPrice) / riskPerShare,
        status: "CLOSED",
        exitReason: exitType,
        mfeR,
        maeR
      };
      await db.collection("trades").doc("default").collection("items").doc(tradeId).set(trade);
      await doc.ref.update({ status: "DONE" });
      await db.collection("portfolio").doc("default").collection("positions").doc(symbol).update({ status: "CLOSED" });
    } else {
      await db.collection("portfolio").doc("default").collection("positions").doc(symbol).update({
        lastUpdatedAt: admin15.firestore.Timestamp.now(),
        mfeR,
        maeR
      });
    }
  }
}
var manageTradesTask = functionsV19.https.onRequest(async (req, res) => {
  const { dateId } = req.body;
  try {
    await doManageTrades(dateId);
    res.status(200).send("Trades managed");
  } catch (error) {
    console.error("Trade management failed:", error);
    res.status(500).send("Internal Error");
  }
});

// src/index.ts
var publicOptions = {
  memory: "512MiB",
  timeoutSeconds: 900,
  cors: true,
  invoker: "public"
};
var startEodRun = (0, import_https3.onRequest)(publicOptions, (req, res) => doStartEodRun(req, res));
var startMorningExecution = (0, import_https3.onRequest)(publicOptions, (req, res) => doStartMorningExecution(req, res));
var terminateJob2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => terminateJob(req, res));
var probeLogs = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => {
  res.status(200).send({ message: "probeLogs placeholder - check Firestore for real-time status" });
});
var auditJobs2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => auditJobs(req, res));
var cleanupData2 = (0, import_https3.onRequest)({ timeoutSeconds: 540, memory: "512MiB", cors: true, invoker: "public" }, (req, res) => cleanupData(req, res));
var purgeJobs2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => purgeJobs(req, res));
var seedUniverse2 = (0, import_https3.onRequest)({ memory: "512MiB", timeoutSeconds: 300, cors: true, invoker: "public" }, (req, res) => seedUniverse(req, res));
var cleanupUniverse2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => cleanupUniverse(req, res));
var validateUniverseCsv2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => validateUniverseCsv(req, res));
var updateUniverseFromCsv2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => updateUniverseFromCsv(req, res));
var checkKiteHealth2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => checkKiteHealth(req, res));
var updateKitetoken = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => updateKiteToken(req, res));
var updateKiteCredentials2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => updateKiteCredentials(req, res));
var diagnostics2 = diagnostics;
var probeInventory2 = probeInventory;
var downloadReport2 = (0, import_https3.onRequest)({ cors: true, invoker: "public" }, (req, res) => downloadReport(req, res));
var fetchCandlesTask2 = (0, import_https3.onRequest)(publicOptions, async (req, res) => {
  await fetchCandlesTask(req, {});
  res.status(200).send({ success: true });
});
var computeFeaturesTask2 = (0, import_https3.onRequest)(publicOptions, async (req, res) => {
  await computeFeaturesTask(req, {});
  res.status(200).send({ success: true });
});
var evaluateSignalsTask2 = (0, import_https3.onRequest)(publicOptions, async (req, res) => {
  await evaluateSignalsTask(req, {});
  res.status(200).send({ success: true });
});
var riskApproveTask2 = (0, import_https3.onRequest)(publicOptions, async (req, res) => {
  await riskApproveTask(req, {});
  res.status(200).send({ success: true });
});
var manageTradesTask2 = (0, import_https3.onRequest)(publicOptions, async (req, res) => {
  await manageTradesTask(req, {});
  res.status(200).send({ success: true });
});
var processSymbolTask2 = (0, import_https3.onRequest)(publicOptions, async (req, res) => {
  await processSymbolTask(req);
  res.status(200).send({ success: true });
});
var processMorningSymbolTask2 = (0, import_https3.onRequest)(publicOptions, async (req, res) => {
  await processMorningSymbolTask(req);
  res.status(200).send({ success: true });
});
var processStageTask = (0, import_https3.onRequest)(publicOptions, (req, res) => {
  console.log("processStageTask called (legacy). No action taken.");
  res.status(200).send({ message: "OK" });
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  auditJobs,
  checkKiteHealth,
  cleanupData,
  cleanupUniverse,
  computeFeaturesTask,
  diagnostics,
  downloadReport,
  evaluateSignalsTask,
  fetchCandlesTask,
  manageTradesTask,
  probeInventory,
  probeLogs,
  processMorningSymbolTask,
  processStageTask,
  processSymbolTask,
  purgeJobs,
  riskApproveTask,
  seedUniverse,
  startEodRun,
  startMorningExecution,
  terminateJob,
  updateKiteCredentials,
  updateKitetoken,
  updateUniverseFromCsv,
  validateUniverseCsv
});
