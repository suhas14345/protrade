const admin = require('firebase-admin');
if (admin.apps.length === 0) admin.initializeApp();
const db = admin.firestore();

const testDoc = db.collection('tmp_tests').doc('progress_test');

async function test() {
    await testDoc.set({ counts: { done: 0 } });
    console.log('Reset to 0');
    
    // Testing dot notation increment
    await testDoc.update({
        'counts.done': admin.firestore.FieldValue.increment(1)
    });
    
    const snap = await testDoc.get();
    console.log('Result after increment:', snap.data().counts);
    process.exit(0);
}

test().catch(console.error);
