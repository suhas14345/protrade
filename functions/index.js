const functions = require('firebase-functions/v1');

const v1Options = {
    timeoutSeconds: 540,
    memory: '1GB'
};

/**
 * Cloud Functions v1 Bridge (Surgical)
 */
exports.gateway = functions.runWith(v1Options).https.onRequest((req, res) => {
    return require('./lib/index').gateway(req, res);
});
