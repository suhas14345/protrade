process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-protrade';
const { runEodLogic } = require('./lib/services/orchestrator');

const date = '2026-03-16'; // Recent weekday
const universe = 'nifty50';

console.log(`Triggering runEodLogic for ${date} and universe ${universe}...`);
runEodLogic(date, `test_job_${Date.now()}`, universe)
  .then(() => {
    console.log('EOD Logic finished successfully');
    process.exit(0);
  })
  .catch(err => {
    console.error('EOD Logic failed:', err);
    process.exit(1);
  });
