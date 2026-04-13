import { validateRequest } from '../middleware';

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
    'syncNseHolidays',
  ];

  it.each(EXPECTED_ACTIONS)('accepts known action: %s', (action) => {
    const result = validateRequest({ action });
    expect(result).toEqual({ valid: true });
  });

  // ── Critical new actions added this session ──────────────────────

  it('accepts scheduledMorning (added for morning fill pipeline)', () => {
    expect(validateRequest({ action: 'scheduledMorning' })).toEqual({ valid: true });
  });

  it('accepts startMorningExecution (added for manual morning trigger)', () => {
    expect(validateRequest({ action: 'startMorningExecution' })).toEqual({ valid: true });
  });

  it('accepts scheduledKiteRenew (added for kite auto-renewal)', () => {
    expect(validateRequest({ action: 'scheduledKiteRenew' })).toEqual({ valid: true });
  });

  // ── Rejection cases ──────────────────────────────────────────────

  it('rejects unknown action', () => {
    const result = validateRequest({ action: 'unknownOp' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown action: unknownOp');
  });

  it('rejects missing action field', () => {
    const result = validateRequest({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing or non-string');
  });

  it('rejects non-string action (number)', () => {
    const result = validateRequest({ action: 123 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing or non-string');
  });

  it('rejects null action', () => {
    const result = validateRequest({ action: null });
    expect(result.valid).toBe(false);
  });

  it('is case-sensitive (STARTEOD rejected)', () => {
    const result = validateRequest({ action: 'STARTEOD' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown action');
  });

  it('does not trim whitespace (padded action rejected)', () => {
    const result = validateRequest({ action: ' startEod ' });
    expect(result.valid).toBe(false);
  });
});
