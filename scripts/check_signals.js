const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}

const db = admin.firestore();

async function checkSignals() {
  const date = '2026-03-17';
  const dateId = date.replace(/-/g, '');
  
  console.log(`Checking signals and orders for ${date}`);
  
  const signalsSnap = await db.collection('signals').doc(dateId).collection('items').get();
  console.log(`Found ${signalsSnap.size} signals.`);
  signalsSnap.docs.forEach(doc => {
    const data = doc.data();
    console.log(`Signal: ${doc.id}, Status: ${data.status}, Strategy: ${data.strategy}, Score: ${data.score}`);
  });

  const ordersSnap = await db.collection('paperOrders').doc(dateId).collection('items').get();
  console.log(`Found ${ordersSnap.size} paper orders.`);
  ordersSnap.docs.forEach(doc => {
    const data = doc.data();
    console.log(`Order: ${doc.id}, Symbol: ${data.symbol}, Status: ${data.status}, Reason: ${data.rejectionReason || 'N/A'}`);
  });
}

checkSignals().catch(console.error);
