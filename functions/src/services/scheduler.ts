import * as admin from 'firebase-admin';
import { ORCH_CONFIG, RUNTIME_CONFIG } from '../config/runtime';

export const NSE_HOLIDAYS_2025: string[] = [
  '2025-01-26', // Republic Day
  '2025-03-14', // Holi
  '2025-04-14', // Ambedkar Jayanti
  '2025-04-18', // Good Friday
  '2025-05-01', // Maharashtra Day
  '2025-08-15', // Independence Day
  '2025-08-27', // Ganesh Chaturthi
  '2025-10-02', // Mahatma Gandhi Jayanti
  '2025-10-20', // Diwali-Laxmi Pujan
  '2025-10-21', // Dussehra / Diwali-Balipratipada
  '2025-11-05', // Gurunanak Jayanti
  '2025-12-25', // Christmas
];

// Source: NSE official API (https://www.nseindia.com/api/holiday-master?type=trading)
// Segment: CM (Cash Market) — excludes weekends that already appear in the list
export const NSE_HOLIDAYS_2026: string[] = [
  '2026-01-15', // Municipal Corporation Election — Maharashtra
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-08-26', // Id-E-Milad
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
];

const HOLIDAY_SET = new Set([...NSE_HOLIDAYS_2025, ...NSE_HOLIDAYS_2026]);

// ── Trading-day helpers (pure / sync — no Firestore) ────────────────────────

/** Check if a YYYY-MM-DD date is an NSE trading day (not weekend, not holiday). */
export function isTradingDay(date: string): boolean {
  const d = new Date(date + 'T12:00:00Z');
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !HOLIDAY_SET.has(date);
}

/** Return the next trading day after `date` (YYYY-MM-DD). */
export function getNextTradingDay(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  for (let i = 0; i < 15; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().split('T')[0];
    if (isTradingDay(iso)) return iso;
  }
  throw new Error(`No trading day found within 15 days after ${date}`);
}

/** Return the previous trading day before `date` (YYYY-MM-DD). */
export function getPrevTradingDay(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  for (let i = 0; i < 15; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const iso = d.toISOString().split('T')[0];
    if (isTradingDay(iso)) return iso;
  }
  throw new Error(`No trading day found within 15 days before ${date}`);
}

/** Current date in IST (YYYY-MM-DD). */
function getTodayIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffsetMs);
  return ist.toISOString().split('T')[0];
}

// ── Missed-run detection ────────────────────────────────────────────────────

/**
 * Detect trading days since the last successful EOD run that lack a completed job.
 * Returns YYYY-MM-DD strings sorted ascending.
 */
export async function detectMissedRuns(
  db: FirebaseFirestore.Firestore,
): Promise<string[]> {
  const snap = await db.collection('jobs')
    .where('type', '==', 'EOD_RUN')
    .where('status', '==', 'DONE')
    .orderBy('startedAt', 'desc')
    .limit(30)
    .get();

  if (snap.empty) return [];

  const doneRunDates = new Set(snap.docs.map(d => d.data().runDate as string));
  const lastRunDate = snap.docs[0].data().runDate as string;

  const todayIST = getTodayIST();
  const yd = new Date(todayIST + 'T12:00:00Z');
  yd.setUTCDate(yd.getUTCDate() - 1);
  const yesterday = yd.toISOString().split('T')[0];

  if (lastRunDate >= yesterday) return [];

  const missed: string[] = [];
  const cursor = new Date(lastRunDate + 'T12:00:00Z');
  const end = new Date(yesterday + 'T12:00:00Z');

  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const iso = cursor.toISOString().split('T')[0];
    if (cursor > end) break;
    if (isTradingDay(iso) && !doneRunDates.has(iso)) {
      missed.push(iso);
    }
  }
  return missed;
}

// ── Catch-up runner ─────────────────────────────────────────────────────────

/**
 * Trigger EOD runs for each missed date sequentially.
 * Stops early if a job is already in progress. Writes audit trail to scheduler_log.
 */
export async function runCatchUp(
  db: FirebaseFirestore.Firestore,
  missedDates: string[],
): Promise<{ triggered: string[]; skipped: string[] }> {
  const triggered: string[] = [];
  const skipped: string[] = [];

  for (const date of missedDates) {
    const running = await db.collection('jobs')
      .where('status', 'in', ['RUNNING', 'FINALIZING'])
      .limit(1).get();

    if (!running.empty) {
      skipped.push(...missedDates.slice(missedDates.indexOf(date)));
      break;
    }

    const jobId = `catchup_eod_${date.replace(/-/g, '')}_${Date.now()}`;
    await db.collection('jobs').doc(jobId).set({
      id: jobId,
      runDate: date,
      universeId: 'nifty50',
      type: 'EOD_RUN',
      stage: 'STARTING',
      status: 'RUNNING',
      counts: { total: 0, done: 0, failed: 0 },
      startedAt: admin.firestore.Timestamp.now(),
      updatedAt: admin.firestore.Timestamp.now(),
      triggeredBy: 'scheduler_catchup',
      versionHash: 'v1.1Delta',
    });

    await db.collection('scheduler_log').add({
      type: 'CATCH_UP',
      date,
      jobId,
      triggeredAt: admin.firestore.Timestamp.now(),
    });

    triggered.push(date);
  }

  return { triggered, skipped };
}

// ── Stuck job sweeper ───────────────────────────────────────────────────────

/**
 * Find jobs stuck in RUNNING/FINALIZING longer than `timeoutMinutes` and mark FAILED.
 * Returns count of swept jobs.
 */
export async function sweepStuckJobs(
  db: FirebaseFirestore.Firestore,
  timeoutMinutes: number = ORCH_CONFIG.JOB_TIMEOUT_MINUTES,
): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60_000);
  const stuck = await db.collection('jobs')
    .where('status', 'in', ['RUNNING', 'FINALIZING'])
    .where('startedAt', '<', admin.firestore.Timestamp.fromDate(cutoff))
    .get();

  for (const doc of stuck.docs) {
    await doc.ref.update({
      status: 'FAILED',
      errorMessage: `Swept by scheduler: exceeded ${timeoutMinutes}min timeout`,
      updatedAt: admin.firestore.Timestamp.now(),
    });
    await db.collection('scheduler_log').add({
      type: 'SWEEP',
      jobId: doc.id,
      sweptAt: admin.firestore.Timestamp.now(),
    });
  }
  return stuck.size;
}

// ── Health summary ──────────────────────────────────────────────────────────

export interface SystemHealth {
  lastSuccessfulRun: string | null;
  pendingJobs: number;
  dataFreshness: { latestBarDate: string | null; staleMinutes: number | null };
  killSwitchStatus: boolean;
}

/**
 * Build a system-health snapshot from jobs, config, and latest market data.
 */
export async function getSystemHealth(
  db: FirebaseFirestore.Firestore,
): Promise<SystemHealth> {
  // Last successful EOD run
  const doneSnap = await db.collection('jobs')
    .where('type', '==', 'EOD_RUN')
    .where('status', '==', 'DONE')
    .orderBy('startedAt', 'desc')
    .limit(1)
    .get();
  const lastSuccessfulRun = doneSnap.empty
    ? null
    : (doneSnap.docs[0].data().runDate as string);

  // Pending / in-flight jobs
  const pendingSnap = await db.collection('jobs')
    .where('status', 'in', ['RUNNING', 'FINALIZING'])
    .get();

  // Data freshness — latest bar for ^NSEI index
  let latestBarDate: string | null = null;
  let staleMinutes: number | null = null;
  try {
    const barSnap = await db.collection('barsD').doc('^NSEI').collection('days')
      .orderBy('__name__', 'desc')
      .limit(1)
      .get();
    if (!barSnap.empty) {
      latestBarDate = barSnap.docs[0].id;
      const barData = barSnap.docs[0].data();
      if (barData.timestamp?.toMillis) {
        staleMinutes = Math.round((Date.now() - barData.timestamp.toMillis()) / 60_000);
      }
    }
  } catch { /* barsD may not exist yet */ }

  // Kill switch — read from the same static config the runtime uses
  const killSwitchStatus = RUNTIME_CONFIG.KILL_SWITCH;

  return {
    lastSuccessfulRun,
    pendingJobs: pendingSnap.size,
    dataFreshness: { latestBarDate, staleMinutes },
    killSwitchStatus,
  };
}

// ── Automated NSE holiday sync ──────────────────────────────────────────────

/**
 * Fetch official NSE trading holidays from the NSE API and seed them into
 * the Firestore calendar + the in-memory HOLIDAY_SET.
 * Falls back to the hardcoded lists if the API is unreachable.
 */
export async function syncNseHolidays(
  db: FirebaseFirestore.Firestore,
): Promise<{ synced: number; source: 'api' | 'static' }> {
  let holidays: string[] = [];
  let source: 'api' | 'static' = 'static';

  try {
    const axios = (await import('axios')).default;
    const res = await axios.get('https://www.nseindia.com/api/holiday-master?type=trading', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
      timeout: 10_000,
    });

    // CM = Cash Market segment (equity trading holidays)
    const cmHolidays: Array<{ tradingDate: string; weekDay: string; description: string }> = res.data?.CM || [];
    for (const h of cmHolidays) {
      // tradingDate format: "15-Jan-2026" → parse to YYYY-MM-DD
      const parsed = new Date(h.tradingDate);
      if (!isNaN(parsed.getTime())) {
        const dow = parsed.getUTCDay();
        if (dow !== 0 && dow !== 6) { // Skip weekends (already non-trading)
          holidays.push(parsed.toISOString().split('T')[0]);
        }
      }
    }
    if (holidays.length > 0) source = 'api';
  } catch (err: any) {
    console.warn(`[Scheduler] NSE API unreachable (${err.message}). Using static holiday lists.`);
  }

  // Fallback: use the hardcoded static lists
  if (holidays.length === 0) {
    holidays = [...NSE_HOLIDAYS_2025, ...NSE_HOLIDAYS_2026];
  }

  // Seed into Firestore calendar via CalendarService
  // Convert YYYY-MM-DD → YYYYMMDD (system dateId format) for Firestore doc IDs
  const { CalendarService } = await import('./calendar');
  const holidayDateIds = holidays.map(h => h.replace(/-/g, ''));
  await CalendarService.seedFutureHolidays(holidayDateIds);

  // Also update the in-memory set for scheduler helpers
  for (const h of holidays) {
    HOLIDAY_SET.add(h);
  }

  console.log(`[Scheduler] Synced ${holidays.length} NSE holidays (source: ${source})`);
  return { synced: holidays.length, source };
}
