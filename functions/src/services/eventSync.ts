import * as admin from 'firebase-admin';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

const NSE_BASE = 'https://www.nseindia.com';
const NSE_ARCHIVES = 'https://nsearchives.nseindia.com';
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

/**
 * Parse NSE date format "DD-Mon-YYYY" → "YYYYMMDD" dateId
 */
function parseNseDate(dateStr: string): string | null {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0].replace(/-/g, '');
  } catch {
    return null;
  }
}

/**
 * Sync upcoming board meetings (earnings) from NSE into Firestore `earnings/` collection.
 * NSE API: /api/corporate-board-meetings?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
 * 
 * Writes: earnings/{SYMBOL} = { nextEarningsDateId, purpose, description, updatedAt }
 */
export async function syncBoardMeetings(lookAheadDays: number = 30): Promise<number> {
  const db = getDb();
  const axios = (await import('axios')).default;

  const now = new Date();
  const from = formatNseQueryDate(now);
  const to = formatNseQueryDate(new Date(now.getTime() + lookAheadDays * 86400000));

  try {
    const res = await axios.get(
      `${NSE_BASE}/api/corporate-board-meetings?index=equities&from_date=${from}&to_date=${to}`,
      { headers: NSE_HEADERS, timeout: 15_000 }
    );

    const meetings: Array<{
      bm_symbol: string;
      bm_date: string;
      bm_purpose: string;
      bm_desc: string;
    }> = res.data || [];

    // Filter to earnings/results-related meetings only
    const earningsMeetings = meetings.filter(m =>
      /financial.results|dividend|quarterly|yearly|audited|un-?audited/i.test(m.bm_purpose + ' ' + m.bm_desc)
    );

    // Deduplicate: keep the earliest meeting date per symbol
    const symbolMap = new Map<string, { dateId: string; purpose: string; desc: string }>();
    for (const m of earningsMeetings) {
      const dateId = parseNseDate(m.bm_date);
      if (!dateId) continue;
      const symbol = m.bm_symbol;
      const existing = symbolMap.get(symbol);
      if (!existing || dateId < existing.dateId) {
        symbolMap.set(symbol, { dateId, purpose: m.bm_purpose, desc: m.bm_desc });
      }
    }

    // Batch write to Firestore
    const batch = db.batch();
    let count = 0;
    for (const [symbol, data] of symbolMap) {
      batch.set(db.collection('earnings').doc(symbol), {
        nextEarningsDateId: data.dateId,
        purpose: data.purpose,
        description: data.desc.substring(0, 500),
        source: 'NSE_BOARD_MEETINGS',
        updatedAt: admin.firestore.Timestamp.now(),
      }, { merge: true });
      count++;
    }
    await batch.commit();

    await logger.info(`[EventSync] Synced ${count} earnings dates from NSE board meetings (${from} → ${to})`, 'EventSync');
    return count;
  } catch (err: any) {
    await logger.error(`[EventSync] Board meetings sync failed: ${err.message}`, 'EventSync');
    return 0;
  }
}

/**
 * Sync upcoming corporate actions (dividends, splits, bonuses, buybacks) from NSE.
 * NSE API: /api/corporates-corporateActions?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
 * 
 * Writes: corporateActions/{SYMBOL} = { nextActionDateId, actionType, subject, updatedAt }
 */
export async function syncCorporateActions(lookAheadDays: number = 30): Promise<number> {
  const db = getDb();
  const axios = (await import('axios')).default;

  const now = new Date();
  const from = formatNseQueryDate(now);
  const to = formatNseQueryDate(new Date(now.getTime() + lookAheadDays * 86400000));

  try {
    const res = await axios.get(
      `${NSE_BASE}/api/corporates-corporateActions?index=equities&from_date=${from}&to_date=${to}`,
      { headers: NSE_HEADERS, timeout: 15_000 }
    );

    const actions: Array<{
      symbol: string;
      exDate: string;
      subject: string;
    }> = res.data || [];

    // Classify action type from subject
    const classifyAction = (subject: string): string => {
      const s = subject.toLowerCase();
      if (s.includes('split') || s.includes('sub-division')) return 'SPLIT';
      if (s.includes('bonus')) return 'BONUS';
      if (s.includes('buy back') || s.includes('buyback')) return 'BUYBACK';
      if (s.includes('dividend')) return 'DIVIDEND';
      if (s.includes('rights')) return 'RIGHTS';
      if (s.includes('delist')) return 'DELISTING';
      if (s.includes('merger') || s.includes('amalgamation')) return 'MERGER';
      return 'OTHER';
    };

    // Deduplicate: keep earliest ex-date per symbol, prioritize non-DIVIDEND actions
    const symbolMap = new Map<string, { dateId: string; actionType: string; subject: string }>();
    for (const a of actions) {
      const dateId = parseNseDate(a.exDate);
      if (!dateId) continue;
      const actionType = classifyAction(a.subject);
      const existing = symbolMap.get(a.symbol);

      // Prefer structural actions (SPLIT/BONUS/BUYBACK) over dividends
      const priority = (t: string) => ['SPLIT', 'BONUS', 'BUYBACK', 'DELISTING', 'MERGER'].includes(t) ? 1 : 0;
      if (!existing || priority(actionType) > priority(existing.actionType) || dateId < existing.dateId) {
        symbolMap.set(a.symbol, { dateId, actionType, subject: a.subject });
      }
    }

    const batch = db.batch();
    let count = 0;
    for (const [symbol, data] of symbolMap) {
      batch.set(db.collection('corporateActions').doc(symbol), {
        nextActionDateId: data.dateId,
        actionType: data.actionType,
        subject: data.subject.substring(0, 500),
        source: 'NSE_CORPORATE_ACTIONS',
        updatedAt: admin.firestore.Timestamp.now(),
      }, { merge: true });
      count++;
    }
    await batch.commit();

    await logger.info(`[EventSync] Synced ${count} corporate actions from NSE (${from} → ${to})`, 'EventSync');
    return count;
  } catch (err: any) {
    await logger.error(`[EventSync] Corporate actions sync failed: ${err.message}`, 'EventSync');
    return 0;
  }
}

/**
 * Sync today's F&O ban list from NSE archives.
 * CSV: https://nsearchives.nseindia.com/content/fo/fo_secban.csv
 * 
 * Writes: fnoBans/{dateId} = { symbols: [...], source, updatedAt }
 */
export async function syncFnOBanList(): Promise<number> {
  const db = getDb();
  const axios = (await import('axios')).default;

  try {
    const res = await axios.get(`${NSE_ARCHIVES}/content/fo/fo_secban.csv`, {
      headers: { 'User-Agent': NSE_HEADERS['User-Agent'] },
      timeout: 10_000,
      responseType: 'text',
    });

    const csv: string = res.data || '';
    const lines = csv.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // First line: "Securities in Ban For Trade Date DD-MON-YYYY:"
    const headerMatch = lines[0]?.match(/Trade Date\s+(\d{2}-\w{3}-\d{4})/i);
    if (!headerMatch) {
      await logger.warn('[EventSync] Could not parse F&O ban CSV header', 'EventSync');
      return 0;
    }

    const banDateId = parseNseDate(headerMatch[1]);
    if (!banDateId) return 0;

    // Remaining lines: "N,SYMBOL"
    const symbols: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 2) {
        const sym = parts[1].trim();
        if (sym && sym !== '') symbols.push(sym);
      }
    }

    await db.collection('fnoBans').doc(banDateId).set({
      symbols,
      count: symbols.length,
      source: 'NSE_FO_SECBAN_CSV',
      updatedAt: admin.firestore.Timestamp.now(),
    });

    await logger.info(`[EventSync] Synced F&O ban list for ${banDateId}: ${symbols.length} symbols (${symbols.join(', ')})`, 'EventSync');
    return symbols.length;
  } catch (err: any) {
    await logger.error(`[EventSync] F&O ban sync failed: ${err.message}`, 'EventSync');
    return 0;
  }
}

/**
 * Run all corporate event syncs in one shot.
 */
export async function syncAllCorporateEvents(lookAheadDays: number = 30): Promise<{
  earnings: number;
  corporateActions: number;
  fnoBans: number;
}> {
  const [earnings, corporateActions, fnoBans] = await Promise.all([
    syncBoardMeetings(lookAheadDays),
    syncCorporateActions(lookAheadDays),
    syncFnOBanList(),
  ]);
  return { earnings, corporateActions, fnoBans };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Format Date → "DD-MM-YYYY" for NSE API query params */
function formatNseQueryDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}
