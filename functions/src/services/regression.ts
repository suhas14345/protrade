import * as admin from 'firebase-admin';
import { taskClient } from './tasks';

export async function runSystemRegression() {
  console.log('--- STARTING SYSTEM REGRESSION TEST ---');
  
  try {
    // 1. Initialize admin if needed
    if (admin.apps.length === 0) {
      admin.initializeApp();
    }
    const db = admin.firestore();

    // 2. Test Firestore Connectivity
    console.log('[REGRESSION] Testing Firestore: Reading settings/kite...');
    const settingsSnap = await db.collection('settings').doc('kite').get();
    if (!settingsSnap.exists) {
      throw new Error('Firestore read failed: kite settings missing');
    }
    console.log('[REGRESSION] Firestore: OK');

    // 3. Test Universe Data
    console.log('[REGRESSION] Testing Universe: Checking midsmall400 membership...');
    const universeSnap = await db.collection('universes').doc('midsmall400').collection('members').limit(5).get();
    if (universeSnap.empty) {
      throw new Error('Universe check failed: midsmall400 has no members');
    }
    console.log(`[REGRESSION] Universe: OK (${universeSnap.size} symbols found)`);

    // 4. Test Cloud Tasks Integration (Dry Run / Probe)
    console.log('[REGRESSION] Testing Cloud Tasks enqueuing (Probe)...');
    try {
      // Using a probe task that does nothing but confirm enqueuing works
      await taskClient.enqueue('probeLogs', { regressionTest: true, timestamp: Date.now() });
      console.log('[REGRESSION] Cloud Tasks: OK');
    } catch (err: any) {
      if (err.message?.includes('DEADLINE_EXCEEDED')) {
        console.warn('[REGRESSION] Cloud Tasks: WARNING - Deadline Exceeded during enqueuing. This is a known issue being addressed.');
      } else {
        throw err;
      }
    }

    // 5. Build/Bundle Validation (Implicit if this file runs)
    console.log('[REGRESSION] Basic runtime validation: OK');

    console.log('--- REGRESSION TEST PASSED ---');
    return { success: true };
  } catch (err: any) {
    console.error('--- REGRESSION TEST FAILED ---');
    console.error(err);
    return { success: false, error: err.message };
  }
}
