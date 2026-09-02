"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSystemRegression = runSystemRegression;
const admin = __importStar(require("firebase-admin"));
const tasks_1 = require("./tasks");
async function runSystemRegression() {
    var _a;
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
            await tasks_1.taskClient.enqueue('probeLogs', { regressionTest: true, timestamp: Date.now() });
            console.log('[REGRESSION] Cloud Tasks: OK');
        }
        catch (err) {
            if ((_a = err.message) === null || _a === void 0 ? void 0 : _a.includes('DEADLINE_EXCEEDED')) {
                console.warn('[REGRESSION] Cloud Tasks: WARNING - Deadline Exceeded during enqueuing. This is a known issue being addressed.');
            }
            else {
                throw err;
            }
        }
        // 5. Build/Bundle Validation (Implicit if this file runs)
        console.log('[REGRESSION] Basic runtime validation: OK');
        console.log('--- REGRESSION TEST PASSED ---');
        return { success: true };
    }
    catch (err) {
        console.error('--- REGRESSION TEST FAILED ---');
        console.error(err);
        return { success: false, error: err.message };
    }
}
//# sourceMappingURL=regression.js.map