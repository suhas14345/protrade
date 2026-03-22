const admin = require('firebase-admin');
const path = require('path');

// Configure for local emulator
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'suhas-ag';

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'suhas-ag' });
}

const db = admin.firestore();
const fs = require('fs');

// We'll use the compiled JS if available, or we might need to use ts-node/register
// But since we saw 'out' folder in 'functions', maybe it's already compiled to 'lib'
// Let's check 'lib/services/strategy.js'
const strategyPath = path.resolve(__dirname, '../lib/services/strategy.js');
const riskPath = path.resolve(__dirname, '../lib/services/risk.js');

async function analyze() {
  const date = '2026-03-16';
  const jobId = 'local_analysis_' + Date.now();
  
  console.log(`[ANALYSIS] Starting local analysis for ${date}...`);

  // Load the strategy and risk services
  let strategy, risk;
  try {
    strategy = require(strategyPath);
    risk = require(riskPath);
  } catch (err) {
    console.error('[ERROR] Could not load services from lib. Make sure to run build first.', err.message);
    return;
  }

  const nifty500 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/data/nifty500.json'), 'utf8'));
  const symbols = nifty500.map(s => s.symbol);
  console.log(`[ANALYSIS] Analyzing ${symbols.length} symbols...`);

  for (const symbol of symbols) {
    console.log(`--- Analyzing ${symbol} ---`);
    try {
      const dateId = date.replace(/-/g, '');
      
      // Load data from emulator
      const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
      const features = featSnap.data();
      const regimeSnap = await db.collection('regime').doc(dateId).get();
      const regime = regimeSnap.data();
      const barsSnap = await db.collection('barsD').doc(symbol).collection('days').where('__name__', '<=', dateId).get();
      const bars = barsSnap.docs.map(d => d.data()).sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis()).slice(-20);
      
      if (!features || !regime || bars.length === 0) {
        console.log(`  [MISSING_DATA] feat:${!!features} reg:${!!regime} bars:${bars.length}`);
        continue;
      }

      const ema20 = features.ema20 || 0;
      const ema50 = features.ema50 || 0;
      const rsi = features.rsi14 || 50;
      const lastBar = bars[bars.length - 1];
      const currentClose = lastBar.close;
      
      const lower = Math.min(ema20, ema50);
      const upper = Math.max(ema20, ema50);
      const touched = (lastBar.low <= upper) && (lastBar.high >= lower);
      const nearEma20 = Math.abs(currentClose - ema20) / ema20 <= 0.005;
      const touchedEmaBand = touched || nearEma20;

      console.log(`  [LOG] Regime:${regime.marketState} EMA20:${ema20.toFixed(2)} EMA50:${ema50.toFixed(2)} RSI:${rsi.toFixed(2)} Touched:${touchedEmaBand} Close:${currentClose.toFixed(2)}`);

      const isLongPullback = 
        ['TREND', 'RANGE'].includes(regime.marketState) &&
        ema20 > ema50 &&
        touchedEmaBand &&
        rsi >= 40 && rsi <= 55;
      
      console.log(`  [RESULT] PullbackEOD: ${isLongPullback} (RegimeOK:${['TREND', 'RANGE'].includes(regime.marketState)} TrendOK:${ema20 > ema50} PullbackOK:${touchedEmaBand} RSI_OK:${rsi >= 40 && rsi <= 55})`);

      const bbLower = features.bbLower || 0;
      const isMeanReversion = 
        regime.marketState === 'RANGE' &&
        currentClose < bbLower &&
        rsi < 30;
      
      if (isLongPullback || isMeanReversion) {
        console.log(`  [SIGNAL_FOUND] ${symbol} -> Pullback:${isLongPullback} MeanRev:${isMeanReversion}`);
        console.log(`  [DATA] Regime:${regime.marketState} EMA20:${ema20.toFixed(2)} EMA50:${ema50.toFixed(2)} RSI:${rsi.toFixed(2)} Close:${currentClose.toFixed(2)} BBLow:${bbLower.toFixed(2)}`);
      }

    } catch (err) {
      console.error(`  [ERROR] Failed to analyze ${symbol}:`, err.message);
    }
  }
}

analyze().catch(console.error);
