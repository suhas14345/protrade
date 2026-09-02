import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { FinancialStatement, FundamentalsQualityDoc } from '../models';
import { computeEarningsQuality, FundamentalsSource } from './earningsQuality';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Firestore-backed fundamentals source: reads canonical statements staged at
 * fundamentalsRaw/{symbol}. This is the swap-in behind FundamentalsSource until a live
 * XBRL/vendor adapter is added — statements are populated via the ingestFundamentals
 * action (script/manual/vendor export), keeping ingestion decoupled from scoring.
 */
export class FirestoreFundamentalsSource implements FundamentalsSource {
  readonly name = 'firestore';
  async fetchLatestStatement(symbol: string): Promise<FinancialStatement | null> {
    const snap = await getDb().collection('fundamentalsRaw').doc(symbol).get();
    return snap.exists ? (snap.data() as FinancialStatement) : null;
  }
}

/**
 * Config-driven HTTP vendor adapter: fetches a canonical FinancialStatement per symbol from
 * a provider configured at settings/fundamentals { url, apiKey }. The provider must return
 * JSON already in canonical shape (a thin server-side mapper per vendor keeps this generic).
 * `{symbol}` in the URL is substituted; the API key (if any) is sent as x-api-key. Fail-soft:
 * any missing config, network error, or non-canonical payload yields null (⇒ UNKNOWN), never
 * a throw and never fabricated data.
 */
export class HttpFundamentalsSource implements FundamentalsSource {
  readonly name = 'http';
  constructor(private readonly urlTemplate: string, private readonly apiKey?: string) {}

  static async fromSettings(): Promise<HttpFundamentalsSource | null> {
    const snap = await getDb().collection('settings').doc('fundamentals').get();
    const cfg = snap.exists ? (snap.data() as { url?: string; apiKey?: string }) : null;
    if (!cfg?.url) return null;
    return new HttpFundamentalsSource(cfg.url, cfg.apiKey);
  }

  async fetchLatestStatement(symbol: string): Promise<FinancialStatement | null> {
    try {
      const url = this.urlTemplate.replace('{symbol}', encodeURIComponent(symbol));
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as Partial<FinancialStatement>;
      if (!data || typeof data.period !== 'string' || typeof data.filedAt !== 'string') return null;
      return { ...data, symbol } as FinancialStatement;
    } catch {
      return null;
    }
  }
}

/**
 * Ingest canonical financial statements into fundamentalsRaw/{symbol}. Point-in-time:
 * we never rewrite history silently — callers pass the as-reported figures + filedAt.
 */
export async function doIngestFundamentals(req: any, res: any): Promise<void> {
  const statements = (req.body?.statements ?? []) as FinancialStatement[];
  if (!Array.isArray(statements) || statements.length === 0) {
    res.status(400).send({ error: 'Body must include a non-empty "statements" array' });
    return;
  }

  const db = getDb();
  let written = 0;
  const skipped: string[] = [];
  // Firestore batches cap at 500 writes.
  for (let i = 0; i < statements.length; i += 400) {
    const batch = db.batch();
    for (const stmt of statements.slice(i, i + 400)) {
      if (!stmt?.symbol) { skipped.push(JSON.stringify(stmt).slice(0, 40)); continue; }
      batch.set(db.collection('fundamentalsRaw').doc(stmt.symbol), stmt, { merge: true });
      written++;
    }
    await batch.commit();
  }

  await logger.info(`[Fundamentals] Ingested ${written} statements`, 'Fundamentals', { written, skipped: skipped.length });
  res.status(200).send({ written, skipped });
}

/**
 * Compute earnings-quality for every symbol that has a staged raw statement and persist
 * the result to fundamentalsQuality/{symbol}. Non-gating: consumed as a dashboard badge.
 */
export async function doSyncFundamentals(req: any, res: any): Promise<void> {
  const db = getDb();
  const source = new FirestoreFundamentalsSource();

  // Optional: refresh fundamentalsRaw from the configured HTTP vendor first. Symbols come
  // from the request, else from the universe members. Fail-soft per symbol (null skipped).
  if (req.body?.fromHttp) {
    const http = await HttpFundamentalsSource.fromSettings();
    if (!http) {
      res.status(400).send({ error: 'settings/fundamentals { url } not configured for fromHttp sync' });
      return;
    }
    const universeId = req.body?.universe || 'midsmall400';
    let symbols: string[] = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    if (symbols.length === 0) {
      const memSnap = await db.collection('universes').doc(universeId).collection('members').get();
      symbols = memSnap.docs.map((d) => d.id);
    }
    let fetched = 0;
    for (let i = 0; i < symbols.length; i += 400) {
      const batch = db.batch();
      let inBatch = 0;
      for (const sym of symbols.slice(i, i + 400)) {
        const stmt = await http.fetchLatestStatement(sym);
        if (!stmt) continue;
        batch.set(db.collection('fundamentalsRaw').doc(sym), stmt, { merge: true });
        fetched++;
        inBatch++;
      }
      if (inBatch > 0) await batch.commit();
    }
    await logger.info(`[Fundamentals] HTTP refresh fetched ${fetched} statements`, 'Fundamentals', { fetched });
  }

  const rawSnap = await db.collection('fundamentalsRaw').get();
  const summary: Record<string, number> = { CLEAN: 0, WATCH: 0, FLAGGED: 0, UNKNOWN: 0 };
  let processed = 0;

  for (let i = 0; i < rawSnap.docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of rawSnap.docs.slice(i, i + 400)) {
      const symbol = doc.id;
      const stmt = await source.fetchLatestStatement(symbol);
      if (!stmt) continue;
      const result = computeEarningsQuality(stmt);
      const qualityDoc: FundamentalsQualityDoc = {
        symbol,
        period: stmt.period,
        filedAt: stmt.filedAt,
        source: source.name,
        status: result.status,
        flags: result.flags,
        computedAt: Timestamp.now(),
      };
      batch.set(db.collection('fundamentalsQuality').doc(symbol), qualityDoc);
      summary[result.status] = (summary[result.status] || 0) + 1;
      processed++;
    }
    await batch.commit();
  }

  await logger.info(`[Fundamentals] Synced quality for ${processed} symbols`, 'Fundamentals', summary);
  res.status(200).send({ processed, summary });
}

/**
 * Return all computed quality docs for the dashboard badge layer.
 */
export async function getFundamentalsQuality(_req: any, res: any): Promise<void> {
  const snap = await getDb().collection('fundamentalsQuality').get();
  const items = snap.docs.map((d) => d.data());
  res.status(200).send({ count: items.length, items });
}
