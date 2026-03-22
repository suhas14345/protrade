process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-protrade';
const { seedUniverse } = require('./lib/services/universe');

const mockRes = {
  status: (code) => {
    console.log('HTTP Status:', code);
    return {
      send: (body) => {
        console.log('Response:', JSON.stringify(body, null, 2));
      }
    };
  }
};

console.log('Triggering seedUniverse...');
seedUniverse({}, mockRes);
