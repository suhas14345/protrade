const admin = require('firebase-admin');
const axios = require('axios');

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}
const db = admin.firestore();

async function checkStaleSymbols() {
  console.log('Fetching NSE instruments from Kite...');
  const response = await axios.get('https://api.kite.trade/instruments/NSE');
  const lines = response.data.split('\n');
  const kiteSymbols = new Set();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 3) kiteSymbols.add(parts[2]);
  }
  console.log(`Kite has ${kiteSymbols.size} NSE instruments`);

  console.log('Fetching nifty500 members from Firestore...');
  const snap = await db.collection('universes').doc('nifty500').collection('members').get();
  const members = snap.docs.map(d => d.id);
  console.log(`Firestore has ${members.length} members for nifty500`);

  const missing = [];
  const found = [];
  for (const m of members) {
    const search = m.endsWith('.NS') ? m.slice(0, -3) : m;
    if (kiteSymbols.has(search)) {
      found.push(m);
    } else {
      missing.push(m);
    }
  }

  console.log(`Found: ${found.length}`);
  console.log(`Missing: ${missing.length}`);
  if (missing.length > 0) {
    console.log(`Sample missing: ${missing.slice(0, 10).join(', ')}`);
  }
}

checkStaleSymbols().catch(console.error);
