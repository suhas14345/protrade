import * as admin from 'firebase-admin';
import { orchestrateEodTask } from './src/services/orchestrator';

/**
 * LOCAL VERIFICATION SCRIPT
 * Runs the EOD Orchestrator locally against the production DB.
 */
async function verify() {
    console.log('--- STARTING LOCAL SIGNAL VERIFICATION ---');
    
    if (admin.apps.length === 0) {
        admin.initializeApp({
            projectId: 'suhas-ag'
        });
    }

    // MONKEY PATCH FIRESTORE FOR DEBUGGING
    const db = admin.firestore();
    const origDoc = db.doc.bind(db);
    const origColl = db.collection.bind(db);

    db.doc = (path: string) => {
        if (!path || typeof path !== 'string' || path.includes('undefined') || path.includes('//') || path === '') {
            console.error(`!!! INVALID DOC PATH DETECTED: "${path}"`);
        }
        return origDoc(path);
    };
    db.collection = (path: string) => {
        if (!path || typeof path !== 'string' || path.includes('undefined') || path.includes('//') || path === '') {
            console.error(`!!! INVALID COLLECTION PATH DETECTED: "${path}"`);
        }
        return origColl(path);
    };

    const origBatch = db.batch.bind(db);
    db.batch = () => {
        const b = origBatch();
        const origSet = b.set.bind(b);
        b.set = (ref: any, data: any, options?: any) => {
            if (!ref || !ref.path || ref.path.includes('undefined') || ref.path.includes('//')) {
                console.error(`!!! INVALID BATCH SET PATH: "${ref?.path}"`);
            }
            return origSet(ref, data, options);
        };
        return b;
    };

    const testDate = '2026-04-08';
    const testUniverse = 'nifty50';
    const testRegime = 'BEAR';

    console.log(`[Local] Triggering EOD scan for ${testUniverse} on ${testDate} (Regime: ${testRegime})...`);

    try {
        // We simulate the req object
        const req = {
            body: {
                jobId: `local_verify_${Date.now()}`,
                date: testDate,
                universe: testUniverse,
                forceRegime: testRegime
            }
        } as any;

        await orchestrateEodTask(req);
        
        console.log('--- SCAN COMPLETE ---');
        console.log('Checking for generated signals...');
        
        const db = admin.firestore();
        const dateId = testDate.replace(/-/g, '');
        const signalsSnap = await db.collection('signals').doc(dateId).collection('items').get();
        
        console.log(`[Local Result] Found ${signalsSnap.size} signals for ${testDate}.`);
        
        if (signalsSnap.size > 0) {
            signalsSnap.docs.slice(0, 3).forEach(doc => {
                const s = doc.data();
                console.log(` - SIGNAL: ${s.symbol} ${s.side} (Strategy: ${s.strategy})`);
            });
        }

    } catch (err) {
        console.error('[Local Verify Error]', err);
    }
}

verify().then(() => process.exit(0));
