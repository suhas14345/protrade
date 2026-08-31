const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

// Use absolute paths to the JSON data
const NIFTY_50_PATH = path.join(__dirname, '../functions/src/data/nifty50.json');
const NIFTY_500_PATH = path.join(__dirname, '../functions/src/data/nifty500.json');
const MIDSMALL_400_PATH = path.join(__dirname, '../functions/src/data/midsmall400.json');

const NIFTY_50_DATA = JSON.parse(fs.readFileSync(NIFTY_50_PATH, 'utf8'));
const NIFTY_500_DATA = JSON.parse(fs.readFileSync(NIFTY_500_PATH, 'utf8'));
const MIDSMALL_400_DATA = JSON.parse(fs.readFileSync(MIDSMALL_400_PATH, 'utf8'));

const universes = [
  { id: 'nifty50', data: NIFTY_50_DATA },
  { id: 'nifty500', data: NIFTY_500_DATA },
  { id: 'midsmall400', data: MIDSMALL_400_DATA },
  { id: 'sample', data: NIFTY_50_DATA.slice(0, 5) },
  { id: 'default', data: NIFTY_50_DATA }
];

async function reseed() {
  console.log('--- RESEEDING UNIVERSES ---');

  for (const universe of universes) {
    const symbols = universe.data;
    console.log(`Seeding ${universe.id} (${symbols.length} symbols)...`);

    const BATCH_SIZE = 500;
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const chunk = symbols.slice(i, i + BATCH_SIZE);
      const batch = db.batch();

      for (const s of chunk) {
        const docRef = db.collection('universes').doc(universe.id).collection('members').doc(s.symbol);
        batch.set(docRef, {
          symbol: s.symbol,
          sector: s.sector,
          liquidityBucket: 'A'
        });
      }
      await batch.commit();
    }
    console.log(`[OK] Finished ${universe.id}`);
  }

  console.log('--- RESEEDING COMPLETE ---');
  process.exit(0);
}

reseed().catch(err => {
  console.error('Reseed failed:', err);
  process.exit(1);
});
