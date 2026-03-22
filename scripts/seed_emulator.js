const admin = require('firebase-admin');

// Point to the local emulator
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8081';

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

const db = admin.firestore();

async function seed() {
    console.log('Seeding local emulator...');

    // 1. Seed Settings (REQUIRED for Kite credentials)
    // IMPORTANT: In a real scenario, you'd fetch this from production, 
    // but here we'll use a placeholder or the last known valid ones.
    await db.collection('settings').doc('kite').set({
        apiKey: 'dummy_api_key',
        apiSecret: 'dummy_api_secret',
        accessToken: 'dummy_access_token', // We might need a real one for live Kite calls
        enforceKite: true,
        kiteIndexSymbol: 'NIFTY 50',
        indexSymbol: '^NSEI'
    });
    console.log('Seed: settings/kite');

    // 2. Seed Universe (Nifty 50 sample)
    const symbols = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK'];
    for (const symbol of symbols) {
        await db.collection('universes').doc('nifty50').collection('members').doc(symbol).set({
            symbol: symbol,
            exchange: 'NSE',
            active: true
        });
    }
    console.log(`Seed: universes/nifty50/symbols (${symbols.length} symbols)`);

    console.log('Seeding complete.');
}

seed().catch(console.error);
