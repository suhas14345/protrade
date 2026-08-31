const fs = require('fs');
const https = require('https');
const os = require('os');

// Attempt to seamlessly read the local CLI Firebase access token for REST queries, 
// avoiding local Admin SDK credential hell.
let token;
try {
  const confPath = os.homedir() + '/.config/configstore/firebase-tools.json';
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  token = conf.tokens.access_token;
} catch (e) {
  console.error("Could not load Firebase CLI token. Ensure you've run `firebase login`.");
  process.exit(1);
}

const PROJECT = 'suhas-ag';
const DATE_ID = '20260831'; // Target date that we've been validating
const TEST_SYMBOL = 'JSWSTEEL.NS'; // The symbol we successfully wiped and regenerated

function callApi(path) {
  return new Promise((res, rej) => {
    https.get(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
      headers: { Authorization: 'Bearer ' + token }
    }, response => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => res(JSON.parse(data)));
    }).on('error', rej);
  });
}

async function runSmokeTests() {
  console.log('================================================');
  console.log(` Starting PROD Integration Smoke Tests for ${DATE_ID}`);
  console.log('================================================\n');
  let failures = 0;

  try {
    // TEST 1: Check Market Regime presence
    console.log(`[Test 1] Verifying Market Regime generation for ${DATE_ID}...`);
    const regime = await callApi(`regime/${DATE_ID}`);
    if (regime.fields && regime.fields.marketState) {
      console.log(`  ✅ PASSED: Regime exists (Market State: ${regime.fields.marketState.stringValue})`);
    } else {
      console.error(`  ❌ FAILED: Regime document missing or malformed.`);
      failures++;
    }

    // TEST 2: Check RAW Bars (Data presence)
    console.log(`\n[Test 2] Verifying RAW market bars data for ${TEST_SYMBOL}...`);
    const bars = await callApi(`barsD/${TEST_SYMBOL}/days/${DATE_ID}`);
    if (bars.fields && bars.fields.close) {
      console.log(`  ✅ PASSED: Bar data exists (Close: ${bars.fields.close.doubleValue || bars.fields.close.integerValue})`);
    } else {
      console.error(`  ❌ FAILED: RAW Bar data missing for ${TEST_SYMBOL}.`);
      failures++;
    }

    // TEST 3: Check correct VCP Feature computation
    console.log(`\n[Test 3] Verifying computed Features (specifically the new VCP parameters)...`);
    const features = await callApi(`features/${TEST_SYMBOL}/days/${DATE_ID}`);
    if (features.fields && features.fields.trend40Up) {
      console.log(`  ✅ PASSED: Document contains the required VCP trend indicators.`);
      console.log(`      - trend10Up: ${features.fields.trend10Up.booleanValue}`);
      console.log(`      - trend20Up: ${features.fields.trend20Up.booleanValue}`);
      console.log(`      - trend40Up: ${features.fields.trend40Up.booleanValue}`);
    } else {
      console.error(`  ❌ FAILED: Features document missing or missing the VCP boolean keys!`);
      failures++;
    }

  } catch (err) {
    console.error('Fatal Error during execution:', err);
    failures++;
  }

  console.log('\n================================================');
  if (failures === 0) {
    console.log(' 🎉 ALL PROD SMOKE TESTS PASSED!');
  } else {
    console.error(` ⚠️ ${failures} TEST(S) FAILED. See above for details.`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

runSmokeTests();
