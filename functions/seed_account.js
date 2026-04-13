process.env.GCLOUD_PROJECT = 'suhas-ag';
const admin = require('firebase-admin');
try { admin.initializeApp({ projectId: 'suhas-ag' }); } catch(e) {}
const db = admin.firestore();

async function seed() {
  // Seed the missing config/account document that strategy.ts requires
  const accountConfig = {
    equity: 1000000,           // ₹10 Lakh starting capital
    baseRiskPct: 0.005,        // 0.5% risk per trade
    maxOpenRiskR: 6,           // Max 6R open portfolio heat
    maxPositions: 10,          // Max 10 concurrent open trades
    strategyRiskWeights: {
      PullbackEOD: 1.0,
      BreakoutCloseEOD: 1.2,
      MeanReversionEOD: 0.8,
      ShortBounceEOD: 0.8
    }
  };

  await db.collection('config').doc('account').set(accountConfig, { merge: true });
  console.log('✅ config/account seeded successfully:', JSON.stringify(accountConfig, null, 2));

  // Verify it's readable
  const snap = await db.collection('config').doc('account').get();
  console.log('✅ Verified - document exists:', snap.exists, '| Data:', JSON.stringify(snap.data()));
}

seed().then(() => process.exit(0)).catch(e => { console.error('❌ Failed:', e.message); process.exit(1); });
