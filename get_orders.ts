import * as admin from 'firebase-admin';

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}

const db = admin.firestore();

async function run() {
  const dateId = '20260322';
  const snap = await db.collection('signals')
    .doc(dateId)
    .collection('items')
    .where('status', '==', 'ORDERED')
    .get();

  console.log('| Symbol | Strategy | Side | Score | Qty | Stop Loss | Target | Entry Ref |');
  console.log('|---|---|---|---|---|---|---|---|');

  snap.docs.forEach(d => {
    const s = d.data();
    const stop = (s.stopPrice || 0).toFixed(2);
    const target = (s.targets && s.targets[0]) ? s.targets[0].toFixed(2) : 'N/A';
    const entry = (s.reasons && s.reasons.close) ? s.reasons.close.toFixed(2) : 'N/A';
    console.log(`| ${s.symbol} | ${s.strategy} | ${s.direction} | ${s.score} | ${s.riskApproval?.sizedQty || 0} | ${stop} | ${target} | ${entry} |`);
  });

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
