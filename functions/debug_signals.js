const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'suhas-ag' });
}

const db = admin.firestore();

async function debugStrategy(symbol, runDate) {
  const dateId = runDate.replace(/-/g, '');
  console.log(`\n--- DEBUGGING ${symbol} for ${runDate} ---`);

  // 1. Get Bars
  const barsSnap = await db.collection('barsD').doc(symbol).collection('days').where('dateId', '<=', dateId).limit(30).get();
  const bars = barsSnap.docs.map(d => d.data()).sort((a,b) => a.timestamp.toMillis() - b.timestamp.toMillis());
  console.log(`Loaded ${bars.length} bars. Latest: ${bars[bars.length-1]?.dateId}`);

  // 2. Get Features
  const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
  if (!featSnap.exists) {
    console.error(`MISSING FEATURES for ${symbol} on ${runDate}`);
    return;
  }
  const feat = featSnap.data();
  console.log(`Features: EMA20=${feat.ema20.toFixed(2)}, EMA50=${feat.ema50.toFixed(2)}, RSI=${feat.rsi14.toFixed(2)}`);

  // 3. Get Regime
  const regimeSnap = await db.collection('regime').doc(dateId).get();
  if (!regimeSnap.exists) {
    console.error(`MISSING REGIME for ${runDate}`);
    return;
  }
  const regime = regimeSnap.data();
  console.log(`Regime: State=${regime.marketState}, TradeAllowed=${regime.tradeAllowed}`);

  // 4. Logic Simulation
  const currentClose = bars[bars.length-1].close;
  const ema20 = feat.ema20;
  const ema50 = feat.ema50;
  const rsi = feat.rsi14;

  const touched = (bars[bars.length-1].low <= Math.max(ema20, ema50)) && (bars[bars.length-1].high >= Math.min(ema20, ema50));
  const nearEma20 = Math.abs(currentClose - ema20) / ema20 <= 0.005;
  const trendOk = ema20 > ema50;

  console.log(`Conditions: EMA_Touch=${touched || nearEma20}, RSI_40_55=${rsi>=40 && rsi<=55}, Trend_Up=${trendOk}`);

  if (regime.marketState === 'TREND' && trendOk && (touched || nearEma20) && (rsi >= 40 && rsi <= 55)) {
    console.log(`>>> SIGNAL MATCH: PullbackEOD BUY`);
  } else {
    console.log(`>>> NO SIGNAL MATCH for PullbackEOD`);
  }
}

async function main() {
  const symbols = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY']; // Sample Nifty 500
  const date = '2026-03-18'; // Yesterday where data should be complete
  for (const s of symbols) {
    await debugStrategy(s, date);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
