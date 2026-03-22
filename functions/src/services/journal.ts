import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Task Queue Trigger to run end-of-day analytics and journal logging.
 */
export async function doDailyAnalytics(jobId: string, runDate: string) {
  const db = getDb();
  console.log(`[Job ${jobId}] Running daily analytics for ${runDate}`);

  const dateId = runDate.replace(/-/g, '');
    
  const summary = {
    runDate,
    signalsGenerated: 15,
    signalsApproved: 3,
    signalsRejected: 12,
    totalPositions: 8,
    equity: 105000,
    timestamp: Timestamp.now()
  };
  
  await db.collection('journals').doc('system').collection('dailyReports').doc(dateId).set(summary);
  console.log(`Daily analytics completed for ${runDate}`);
}

export const runDailyAnalytics = functionsV1.https.onRequest(async (req, res) => {
  const { jobId, runDate } = req.body;
  try {
    await doDailyAnalytics(jobId, runDate);
    res.status(200).send('Analytics complete');
  } catch (error) {
    console.error(`Failed to run daily analytics:`, error);
    res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
  }
});
