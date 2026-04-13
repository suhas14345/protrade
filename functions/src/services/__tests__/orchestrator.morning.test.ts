import { processSymbolTask, runMorningLogic } from '../orchestrator';

// Mock logger
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

// Mock universe
jest.mock('../universe', () => ({
  getUniverseMembers: jest.fn().mockResolvedValue(['RELIANCE.NS', 'TCS.NS'])
}));

// Mock Cloud Tasks
jest.mock('../tasks', () => ({
  taskClient: {
    enqueue: jest.fn().mockResolvedValue(undefined),
    enqueueDispatch: jest.fn().mockResolvedValue(undefined),
  }
}));

// Mock paperBroker — prevent real Firestore calls
jest.mock('../paperBroker', () => ({
  doOpenFillSimulation: jest.fn().mockResolvedValue(undefined),
}));

describe('Orchestrator — Morning Fill Pipeline', () => {
  const { mockFirestore } = global as any;
  const { taskClient } = require('../tasks');
  const { doOpenFillSimulation } = require('../paperBroker');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── processSymbolTask routing ─────────────────────────────────────

  describe('processSymbolTask — taskSubType routing', () => {
    it('routes to morning handler when taskSubType is "morning"', async () => {
      const req = {
        body: { taskSubType: 'morning', jobId: 'job1', date: '2026-04-13', symbol: 'TCS.NS' }
      };

      // Mock the transaction for processMorningSymbolTask
      mockFirestore.runTransaction = jest.fn(async (fn: any) => {
        return fn({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({ status: 'RUNNING', counts: { done: 0, total: 5 }, type: 'MORNING_FILL' })
          }),
          update: jest.fn(),
        });
      });

      // Mock job finalization check
      mockFirestore.get
        .mockResolvedValueOnce({ exists: true, data: () => ({ status: 'RUNNING', counts: { done: 1, total: 5, failed: 0 } }) });

      await processSymbolTask(req);

      // Verify doOpenFillSimulation was called (via processMorningSymbolTask)
      expect(doOpenFillSimulation).toHaveBeenCalledWith('job1', '2026-04-13', 'TCS.NS');
    });

    it('does NOT call doOpenFillSimulation for normal EOD tasks', async () => {
      const req = {
        body: { jobId: 'job1', date: '2026-04-13', symbol: 'TCS.NS', dateId: '20260413' }
      };

      // Mock job check — return RUNNING EOD job
      mockFirestore.get
        .mockResolvedValueOnce({ exists: true, data: () => ({ status: 'RUNNING', type: 'EOD_RUN', counts: { done: 0, total: 5, failed: 0 } }) })
        // Idempotency sentinel (not exists → proceed)
        .mockResolvedValueOnce({ exists: false })
        // Feature fetch attempt (can fail, that's fine)
        .mockResolvedValueOnce({ exists: false, data: () => ({}) });

      // Allow create to succeed (idempotency sentinel)
      mockFirestore.create.mockResolvedValueOnce(true);

      try {
        await processSymbolTask(req);
      } catch {
        // May throw on missing data; the key assertion is below
      }

      expect(doOpenFillSimulation).not.toHaveBeenCalled();
    });

    it('skips processing when taskSubType is "morning" but jobId/symbol/date are missing', async () => {
      const req = { body: { taskSubType: 'morning' } };  // Missing all required fields

      await processSymbolTask(req);

      expect(doOpenFillSimulation).not.toHaveBeenCalled();
    });
  });

  // ── runMorningLogic ───────────────────────────────────────────────

  describe('runMorningLogic', () => {
    it('enqueues tasks with taskSubType "morning" for each universe symbol', async () => {
      const universeSymbols = [
        { id: 'RELIANCE.NS', data: () => ({}) },
        { id: 'TCS.NS', data: () => ({}) },
        { id: 'INFY.NS', data: () => ({}) },
      ];

      mockFirestore.get.mockResolvedValueOnce({ empty: false, docs: universeSymbols });

      await runMorningLogic('2026-04-13', 'morning-job-1', 'nifty500');

      // Should enqueue 3 tasks
      expect(taskClient.enqueueDispatch).toHaveBeenCalledTimes(3);

      // Each task must have taskSubType: 'morning'
      for (const call of taskClient.enqueueDispatch.mock.calls) {
        expect(call[0]).toBe('processSymbolTask');
        expect(call[1]).toMatchObject({ taskSubType: 'morning' });
      }

      // Verify job counts updated
      expect(mockFirestore.update).toHaveBeenCalledWith(
        expect.objectContaining({ 'counts.total': 3 })
      );
    });

    it('updates job to FAILED when enqueue throws', async () => {
      mockFirestore.get.mockResolvedValueOnce({
        empty: false,
        docs: [{ id: 'TCS.NS', data: () => ({}) }]
      });
      taskClient.enqueueDispatch.mockRejectedValueOnce(new Error('Queue unavailable'));

      await expect(runMorningLogic('2026-04-13', 'morning-job-1', 'nifty500'))
        .rejects.toThrow('Queue unavailable');

      expect(mockFirestore.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'FAILED', errorMessage: 'Queue unavailable' })
      );
    });
  });
});
