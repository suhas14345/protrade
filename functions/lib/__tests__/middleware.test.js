"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const middleware_1 = require("../middleware");
describe('Middleware — validateRequest', () => {
    // ── Every known action must pass ─────────────────────────────────
    const EXPECTED_ACTIONS = [
        'startEod', 'startDeepSync', 'terminate',
        'fetchCandles', 'computeFeatures', 'evaluateSignals',
        'computeRsRanking', 'computeCorrTopN', 'manageTrades',
        'processSymbol', 'orchestrateEod', 'orchestrateDeepSync',
        'diagnostics', 'checkHealth', 'updateToken', 'updateCredentials', 'seedUniverse',
        'systemHealth', 'sweepStuckJobs', 'getAlerts',
        'probeInventory', 'auditJobs', 'downloadReport',
        'scheduledKiteRenew', 'scheduledEod', 'scheduledMorning',
        'startMorningExecution', 'getKiteSettings',
        'syncNseHolidays', 'syncCorporateEvents',
    ];
    it.each(EXPECTED_ACTIONS)('accepts known action: %s', (action) => {
        const result = (0, middleware_1.validateRequest)({ action });
        expect(result).toEqual({ valid: true });
    });
    // ── Critical new actions added this session ──────────────────────
    it('accepts scheduledMorning (added for morning fill pipeline)', () => {
        expect((0, middleware_1.validateRequest)({ action: 'scheduledMorning' })).toEqual({ valid: true });
    });
    it('accepts startMorningExecution (added for manual morning trigger)', () => {
        expect((0, middleware_1.validateRequest)({ action: 'startMorningExecution' })).toEqual({ valid: true });
    });
    it('accepts scheduledKiteRenew (added for kite auto-renewal)', () => {
        expect((0, middleware_1.validateRequest)({ action: 'scheduledKiteRenew' })).toEqual({ valid: true });
    });
    // ── Rejection cases ──────────────────────────────────────────────
    it('rejects unknown action', () => {
        const result = (0, middleware_1.validateRequest)({ action: 'unknownOp' });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Unknown action: unknownOp');
    });
    it('rejects missing action field', () => {
        const result = (0, middleware_1.validateRequest)({});
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Missing or non-string');
    });
    it('rejects non-string action (number)', () => {
        const result = (0, middleware_1.validateRequest)({ action: 123 });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Missing or non-string');
    });
    it('rejects null action', () => {
        const result = (0, middleware_1.validateRequest)({ action: null });
        expect(result.valid).toBe(false);
    });
    it('is case-sensitive (STARTEOD rejected)', () => {
        const result = (0, middleware_1.validateRequest)({ action: 'STARTEOD' });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Unknown action');
    });
    it('does not trim whitespace (padded action rejected)', () => {
        const result = (0, middleware_1.validateRequest)({ action: ' startEod ' });
        expect(result.valid).toBe(false);
    });
});
//# sourceMappingURL=middleware.test.js.map