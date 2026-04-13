process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-protrade';
const admin = require('firebase-admin');
try {
  admin.initializeApp({ projectId: 'demo-protrade' });
} catch(e) {}
const db = admin.firestore();

async function checkAllBars() {
    console.log("Fetching Nifty 500 members...");
    const universeSnap = await db.collection('universes').doc('nifty500').collection('members').get();
    
    if (universeSnap.empty) {
        console.log("No universe members found. Is the DB connected properly?");
        process.exit(1);
    }

    const symbols = universeSnap.docs.map(d => d.id);
    console.log(`Found ${symbols.length} symbols. Checking bar counts...`);

    let complete = 0;
    let missingOrIncomplete = [];

    // Check sequentially to avoid hammering DB
    for (const sym of symbols) {
        const snap = await db.collection('barsD').doc(sym).collection('days').count().get();
        const count = snap.data().count;
        if (count >= 60) {
            complete++;
        } else {
            missingOrIncomplete.push({ symbol: sym, count });
        }
    }

    console.log(`\nResults: ${complete} symbols have sufficient data (>= 60 bars).`);
    if (missingOrIncomplete.length > 0) {
        console.log(`\nThe following ${missingOrIncomplete.length} symbols have insufficient or missing data:`);
        missingOrIncomplete.slice(0, 50).forEach(m => console.log(` - ${m.symbol}: ${m.count} bars`));
        if (missingOrIncomplete.length > 50) console.log(`...and ${missingOrIncomplete.length - 50} more.`);
    }
}

checkAllBars().then(() => process.exit(0)).catch(console.error);
