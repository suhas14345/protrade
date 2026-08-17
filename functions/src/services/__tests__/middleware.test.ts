import { validateRequest } from '../../middleware';

/**
 * Regression tests for the gateway request validation.
 *
 * The `downloadReport` link is a GET whose params (`action`, `jobId`) arrive in the
 * query string, so the gateway validates `{ ...req.query, ...req.body }`. These pin
 * that `downloadReport` stays a known action and that validation accepts the merged
 * object (regression: the link returned 400 when only `req.body` was validated).
 */
describe('validateRequest', () => {
  it('accepts downloadReport with params (merged query+body path)', () => {
    expect(validateRequest({ action: 'downloadReport', jobId: 'eod_2026-08-14_nifty50_1' }))
      .toEqual({ valid: true });
  });

  it('accepts a query-only shaped object (GET link)', () => {
    // Mimics { ...req.query } with no body — action still present.
    expect(validateRequest({ action: 'downloadReport' }).valid).toBe(true);
  });

  it('rejects a missing action', () => {
    const r = validateRequest({});
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/action/i);
  });

  it('rejects an unknown action', () => {
    const r = validateRequest({ action: 'notARealAction' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unknown action/i);
  });
});
