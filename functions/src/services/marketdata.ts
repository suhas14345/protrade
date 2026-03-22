import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

// Remove Yahoo Finance lazy loading

import { Bar } from '../models';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) {
    admin.initializeApp();
    const db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db;
  }
  return admin.firestore();
};

// Yahoo Finance helper removed


let _kite: any = null;
const getKite = async (apiKey: string, accessToken: string) => {
  if (!_kite || _kite.access_token !== accessToken) {
    const { KiteConnect } = await import('kiteconnect');
    _kite = new KiteConnect({ api_key: apiKey });
    _kite.setAccessToken(accessToken);
  }
  return _kite;
};

let _nseInstruments: any[] | null = null;
export async function getNSEInstruments(apiKey: string, accessToken: string) {
  if (_nseInstruments) return _nseInstruments;
  console.log('[MarketData] Fetching NSE instrument list CSV from Kite...');
  try {
    const axios = (await import('axios')).default;
    const response = await axios.get('https://api.kite.trade/instruments/NSE', {
      timeout: 120000,
      responseType: 'text'
    });
    
    // Simple CSV parser for Kite instruments (instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange)
    const lines = response.data.split('\n');
    const instruments: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
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
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
    console.error(`[MarketData] CRITICAL: Failed to fetch NSE instruments CSV: ${errMsg}`);
    throw err;
  }
}



/**
 * Task Queue Trigger to fetch historical candles for a specific symbol.
 */
export async function doFetchCandles(jobId: string, symbol: string, runDate: string, instrumentToken?: number): Promise<boolean> {
  console.log(`>>> [ENTRY POINT] doFetchCandles: Job=${jobId}, Symbol=${symbol}, Date=${runDate}`);
  const db = getDb();
  // 0. Optimization: Skip if today's data (or Friday's data if weekend) already exists
  const dateObj = new Date(runDate);
  const dayOfWeek = dateObj.getUTCDay(); // 0 = Sunday, 6 = Saturday
  
  let checkDates = [runDate.replace(/-/g, '')];
  if (dayOfWeek === 6) { // Saturday -> check Friday
    const fri = new Date(dateObj);
    fri.setDate(dateObj.getDate() - 1);
    checkDates.push(fri.toISOString().split('T')[0].replace(/-/g, ''));
  } else if (dayOfWeek === 0) { // Sunday -> check Friday
    const fri = new Date(dateObj);
    fri.setDate(dateObj.getDate() - 2);
    checkDates.push(fri.toISOString().split('T')[0].replace(/-/g, ''));
  }

  for (const dId of checkDates) {
    const snap = await db.collection('barsD').doc(symbol).collection('days').doc(dId).get();
    if (snap.exists) {
      const historySnap = await db.collection('barsD').doc(symbol).collection('days')
        .where(admin.firestore.FieldPath.documentId(), '<=', dId)
        .limit(30)
        .get();
        
      if (historySnap.size >= 25) {
        console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Data for ${dId} (Ref: ${runDate}) and sufficient history exist. Skipping duplicate fetch.`);
        return false;
      }
    }
  }


  // 1. Safety Delay: Add randomized jitter (0-500ms) to spread the load across tasks
  await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 500)));

  // 1. Fetch real historical data
  const settingsSnap = await db.collection('settings').doc('kite').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : null;
  
  if (!settings?.apiKey || !settings?.accessToken) {
    throw new Error(`Kite credentials missing or inactive for ${symbol}. Yahoo fallback is disabled.`);
  }

  // Determine dynamic startDate based on latest bar in Firestore
  const dateId = runDate.replace(/-/g, '');
  const lastBarSnap = await db.collection('barsD').doc(symbol).collection('days')
    .where(admin.firestore.FieldPath.documentId(), '<', dateId)
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
    .limit(1)
    .get();

  let startDate = new Date(runDate);
  startDate.setDate(startDate.getDate() - 60); // Default fallback

  if (!lastBarSnap.empty) {
    const lastDateStr = lastBarSnap.docs[0].id; // "YYYYMMDD"
    const yr = parseInt(lastDateStr.substring(0, 4));
    const mo = parseInt(lastDateStr.substring(4, 6)) - 1;
    const dy = parseInt(lastDateStr.substring(6, 8));
    const lastDate = new Date(yr, mo, dy);
    
    // Set startDate to the day AFTER the last known bar
    startDate = new Date(lastDate);
    startDate.setDate(lastDate.getDate() + 1);
    
    // Safety check: Don't go into the future
    const today = new Date(runDate);
    if (startDate > today) {
      console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Firestore is already up to date (Last bar: ${lastDateStr}). Skipping fetch.`);
      return false;
    }
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: DELTA FETCH activated. Fetching from ${startDate.toISOString().split('T')[0]} to ${runDate}`);
  }

  let realCandles: Bar[] = [];
  try {
    realCandles = await fetchFromKite(symbol, runDate, settings.apiKey, settings.accessToken, instrumentToken, jobId, startDate);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
    await logger.error(`[MarketData] Kite fetch failed for ${symbol}.`, 'MarketData', { jobId, symbol, error: errorMsg });
    throw new Error(`Kite fetch failed for ${symbol}: ${errorMsg}`);
  }

  // 2. Validate data
  console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Validating ${realCandles.length} raw candles.`);
  const validCandles = validateCandles(realCandles);
  console.log(`[MarketData] Job ${jobId} symbol ${symbol}: ${validCandles.length} valid candles after filter.`);

  // 3. Store the data in rolling window (barsD)
  if (validCandles.length === 0) {
    await logger.warn(`No valid candles for ${symbol} around ${runDate} after fetch.`, 'MarketData', { jobId, symbol });
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: ABORTING write - zero valid candles.`);
    return false;
  }

  const batch = db.batch();
  for (const c of validCandles) {
    // More robust dateId generation
    const dateObj = c.timestamp.toDate();
    const istDate = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, '0');
    const day = String(istDate.getDate()).padStart(2, '0');
    const cDateId = `${year}${month}${day}`;
    
    const docRef = db.collection('barsD').doc(symbol).collection('days').doc(cDateId);
    batch.set(docRef, { ...c, dateId: cDateId });
  }

  // Set a field on the symbol document itself so it's not a "virtual" parent
  batch.set(db.collection('barsD').doc(symbol), { 
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    type: symbol === 'NIFTY 50' ? 'INDEX' : 'EQUITY'
  }, { merge: true });
  
  console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Committing batch write for ${validCandles.length} candles.`);
  
  try {
    await batch.commit();
    console.log(`[MarketData] Job ${jobId} symbol ${symbol}: Batch commit SUCCESS.`);
  } catch (err) {
    console.error(`[MarketData] Job ${jobId} symbol ${symbol}: Batch commit FAILED:`, err);
    throw err;
  }
  await logger.info(`Uploaded ${validCandles.length} candles for ${symbol} (Historical Backfill)`, 'MarketData', { jobId, symbol });
  return true;
}


export async function fetchCandlesTask(req: any, res: any) {
  const { jobId, symbol, runDate } = req.body;
  try {
    await doFetchCandles(jobId, symbol, runDate);
    res.status(200).send('Candles fetched');
  } catch(error) {
    await logger.error(`Failed to fetch candles for ${symbol}: ${error}`, 'MarketData', { jobId, symbol, runDate });
    res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
  }
}

// fetchFromYahooFinance removed


async function fetchWithRetry<T>(fn: () => Promise<T>, symbol: string, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (retries <= 0) throw err;
    const isRateLimit = err?.status === 429 || err?.message?.includes('Too many requests');
    const isTimeout = err?.message?.includes('timeout') || 
                      err?.message?.includes('DEADLINE_EXCEEDED') || 
                      err?.message?.includes('ECONNABORTED') || 
                      err?.error_type === 'NetworkException';
    
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

async function fetchFromKite(symbol: string, runDate: string, apiKey: string, accessToken: string, instrumentToken?: number, jobId?: string, providedStartDate?: Date): Promise<Bar[]> {
  console.log(`>>> [KITE FETCH START] Symbol=${symbol}, Token=${instrumentToken}`);
  const kite = await getKite(apiKey, accessToken);
  
  let token = instrumentToken;
  if (!token) {
    if (symbol === 'NIFTY 50') {
      token = 256265; // Kite Constant for NSE Index
    } else {
      const instruments = await getNSEInstruments(apiKey, accessToken);
      if (!instruments) throw new Error('NSE Instruments list is empty or unreachable');
      
      const searchSymbol = symbol.endsWith('.NS') ? symbol.slice(0, -3) : symbol;
      const instrument = instruments.find((i: any) => i.tradingsymbol === searchSymbol);
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

  await logger.info(`Fetching data for ${symbol} from Kite: ${startDate.toISOString()} to ${endDate.toISOString()}`, 'MarketData', { jobId, symbol });

  const results = await fetchWithRetry(() => kite.getHistoricalData(token, 'day', startDate, endDate), symbol) as Bar[];
  
  await logger.info(`Raw result count for ${symbol}: ${results.length}`, 'MarketData', { jobId, symbol });

  return results.map((row: any) => ({
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    timestamp: Timestamp.fromDate(row.date)
  }));
}

export async function updateKiteToken(req: any, res: any) {
  const { requestToken, apiKey, apiSecret } = req.body;
  const db = getDb();

  try {
    const { KiteConnect } = await import('kiteconnect');
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
  } catch (error) {
    console.error('Kite session error:', error);
    await db.collection('settings').doc('kite').set({ 
      status: 'ERROR', 
      lastError: error instanceof Error ? error.message : 'Unknown' 
    }, { merge: true });
    res.status(500).send({ error: error instanceof Error ? error.message : 'Failed to update Kite session' });
  }
}

export async function updateKiteCredentials(req: any, res: any) {
  const { apiKey, apiSecret, userId, password, totpSecret } = req.body;
  const db = getDb();
  const data: any = { 
    apiKey, 
    apiSecret, 
    updatedAt: admin.firestore.Timestamp.now() 
  };
  
  if (userId) data.userId = userId;
  if (password) data.password = password;
  if (totpSecret) data.totpSecret = totpSecret;
  if (typeof req.body.disableFallback === 'boolean') data.disableFallback = req.body.disableFallback;

  await db.collection('settings').doc('kite').set(data, { merge: true });
  res.status(200).send({ message: 'Kite credentials saved' });
}

export async function checkKiteHealth(req: any, res: any) {
  const db = getDb();
  const snap = await db.collection('settings').doc('kite').get();
  const data = snap.data();
  if (!data?.accessToken) {
    res.status(200).send({ status: 'EXPIRED', reason: 'No token found' });
    return;
  }
  
  try {
    const { KiteConnect } = await import('kiteconnect');
    const kite = new KiteConnect({ api_key: data.apiKey });
    kite.setAccessToken(data.accessToken);
    await kite.getProfile();
    res.status(200).send({ status: 'ACTIVE' });
  } catch (err) {
    console.warn('[MarketData] Kite health check failed:', err);
    res.status(200).send({ status: 'EXPIRED', error: err instanceof Error ? err.message : 'Invalid session' });
  }
}

function validateCandles(bars: Bar[]): Bar[] {
  // Simple validation logic: discard anomalies and extreme outliers. 
  // Indices (like NIFTY 50) have 0 volume in Kite, so we must allow volume >= 0.
  return bars.filter(bar => bar.volume >= 0 && bar.high >= bar.low && bar.close > 0);
}

