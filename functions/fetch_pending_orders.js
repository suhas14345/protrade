const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}

const db = admin.firestore();

async function run() {
  const snap = await db.collection('signals')
    .doc('20260322')
    .collection('items')
    .where('status', 'in', ['ORDERED', 'ACCEPTED'])
    .get();

  console.log('| Symbol | Strategy | Side | Score | Intended Qty | Stop Price | Target | Prev Close (Entry Ref) |');
  console.log('|--------|----------|------|-------|--------------|------------|--------|------------------------|');

  snap.docs.forEach(d => {
    const s = d.data();
    const qty = s.riskApproval ? s.riskApproval.sizedQty : 'N/A';
    const stop = (s.stopPrice || 0).toFixed(2);
    const target = (s.targets && s.targets[0]) ? s.targets[0].toFixed(2) : 'N/A';
    const close = (s.reasons && s.reasons.close) ? s.reasons.close.toFixed(2) : 'N/A';
    const direction = s.direction || s.side || 'N/A';
    console.log(`| ${s.symbol} | ${s.strategy} | ${direction} | ${s.score} | ${qty} | ${stop} | ${target} | ${close} |`);
  });
}

run().catch(console.error);
