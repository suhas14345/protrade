const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'suhas-ag' });
}

async function monitor() {
  const db = admin.firestore();
  console.log('--- ProTrade Job Monitor (Terminal) ---');
  console.log('Polling for active jobs...\n');

  while (true) {
    const snap = await db.collection('jobs')
      .where('status', 'in', ['RUNNING', 'IN_PROGRESS'])
      .orderBy('startedAt', 'desc')
      .limit(5)
      .get();

    if (snap.empty) {
      process.stdout.write('\rNo active jobs found. Polling...');
    } else {
      process.stdout.write('\x1b[2J\x1b[0;0H'); // Clear screen
      console.log(`--- ACTIVE JOBS [${new Date().toLocaleTimeString()}] ---`);
      snap.docs.forEach(doc => {
        const d = doc.data();
        const done = d.counts ? d.counts.done : 0;
        const total = d.counts ? d.counts.total : 0;
        const progress = `${done}/${total}`;
        const color = d.status === 'RUNNING' ? '\x1b[32m' : '\x1b[33m';
        console.log(`${color}${doc.id.padEnd(40)}\x1b[0m | ${String(d.stage).padEnd(10)} | ${progress.padEnd(10)} | ${d.status}`);
      });
      console.log('\n(Press Ctrl+C to exit)');
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

monitor().catch(console.error);
