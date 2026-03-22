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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * MANDATORY RULE VALIDATOR
 * This script is a "Hard Restriction" that prevents building/deploying
 * if rate-limiting or concurrency rules are violated.
 */
async function runValidation() {
    console.log('--- STARTING MANDATORY RULE VALIDATION ---');
    let errors = 0;
    const orchestratorPath = path.resolve(__dirname, 'orchestrator.ts');
    const orchestratorContent = fs.readFileSync(orchestratorPath, 'utf8');
    // Rule 1 & 2: Sequential Dispatch & 350ms Delay
    const loopCount = (orchestratorContent.match(/for\s*\(const\s*symbol\s*of\s*symbols\)/g) || []).length;
    const delayCount = (orchestratorContent.match(/setTimeout\(resolve,\s*350\)/g) || []).length;
    if (loopCount === 0) {
        console.error(`[RULE VIOLATION] No dispatch loops found in orchestrator.ts!`);
        errors++;
    }
    else if (delayCount < loopCount) {
        console.error(`[RULE VIOLATION] Found ${loopCount} loops but only ${delayCount} mandatory 350ms delays. Every loop MUST have a delay.`);
        errors++;
    }
    // Rule 3: Concurrency Guards in entry points
    const entryPoints = ['startEodRun', 'startMorningExecution', 'doSyncUniverse'];
    const guardCount = (orchestratorContent.match(/runningJobs\.empty/g) || []).length;
    if (guardCount < entryPoints.length) {
        console.error(`[RULE VIOLATION] Missing concurrency guards. Found ${guardCount} guards for ${entryPoints.length} mandatory entry points.`);
        errors++;
    }
    // Check for forbidden parallel patterns
    if (orchestratorContent.includes('Promise.all(symbols.map')) {
        console.error(`[RULE VIOLATION] Forbidden Promise.all used for symbol mapping. Use sequential loops.`);
        errors++;
    }
    // Rule 4: System Data Inventory Presence
    const diagPath = path.resolve(__dirname, 'diag.ts');
    if (!fs.existsSync(diagPath)) {
        console.error(`[RULE VIOLATION] Mandatory diag.ts (System Data Inventory) is missing!`);
        errors++;
    }
    else {
        const diagContent = fs.readFileSync(diagPath, 'utf8');
        if (!diagContent.includes('probeInventory')) {
            console.error(`[RULE VIOLATION] probeInventory function missing from diag.ts!`);
            errors++;
        }
    }
    if (errors > 0) {
        console.error(`--- VALIDATION FAILED: ${errors} errors found ---`);
        process.exit(1);
    }
    console.log('--- VALIDATION PASSED: All mandatory rules followed ---');
}
runValidation().catch(err => {
    console.error('Validation Script Error:', err);
    process.exit(1);
});
//# sourceMappingURL=regCheck.js.map