// Self-contained Signal Logic Validator
const RELIANCE_DATA = {
  symbol: 'RELIANCE.NS',
  date: '2026-03-19',
  close: 2985.40,
  high: 3012.00,
  low: 2975.00,
  ema20: 2970.20,
  ema50: 2950.15,
  rsi: 48.8, // from recent dashboard logs
  regime: 'TREND'
};

function checkPullback(data) {
  const ema20 = data.ema20;
  const ema50 = data.ema50;
  const currentClose = data.close;
  const rsi = data.rsi;
  const regimeMatch = (data.regime === 'TREND' || data.regime === 'RANGE');
  
  const lower = Math.min(ema20, ema50);
  const upper = Math.max(ema20, ema50);
  const touched = (data.low <= upper) && (data.high >= lower);
  const nearEma20 = Math.abs(currentClose - ema20) / ema20 <= 0.005;

  const conditions = {
    regimeMatch,
    trendUp: ema20 > ema50,
    touchedBand: touched || nearEma20,
    rsiInRange: (rsi >= 40 && rsi <= 55)
  };

  const signal = conditions.regimeMatch && conditions.trendUp && conditions.touchedBand && conditions.rsiInRange;
  
  return { signal, conditions };
}

console.log('--- Strategy Logic Validation (Local) ---');
console.log('Testing RELIANCE 2026-03-19 Data:');
const result = checkPullback(RELIANCE_DATA);
console.log(JSON.stringify(result, null, 2));

if (result.signal) {
  console.log('\nSUCCESS: Logic correctly identifies signal for RELIANCE.');
} else {
  console.log('\nFAILURE: No signal identified. Reason(s):');
  Object.entries(result.conditions).forEach(([k, v]) => {
    if (!v) console.log(` - ${k} failed`);
  });
}

// Test with RSI just outside range
console.log('\nTesting with RSI 56:');
const result2 = checkPullback({ ...RELIANCE_DATA, rsi: 56 });
console.log(`Signal Match: ${result2.signal} (Reason: RSI 56 is outside 40-55 range)`);
