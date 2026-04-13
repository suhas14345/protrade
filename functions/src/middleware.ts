import * as admin from 'firebase-admin';
import { SECURITY_CONFIG } from './config/runtime';

// ---------------------------------------------------------------------------
// 1. Request validation
// ---------------------------------------------------------------------------
const KNOWN_ACTIONS = new Set([
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
]);

export function validateRequest(body: Record<string, unknown>): { valid: boolean; error?: string } {
  const action = body?.action;
  if (!action || typeof action !== 'string') {
    return { valid: false, error: 'Missing or non-string "action" field' };
  }
  if (!KNOWN_ACTIONS.has(action)) {
    return { valid: false, error: `Unknown action: ${action}` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// 2. API-key auth
// ---------------------------------------------------------------------------
export async function validateApiKey(
  req: { headers: Record<string, string | string[] | undefined> },
): Promise<{ authenticated: boolean; error?: string }> {
  if (!SECURITY_CONFIG.REQUIRE_AUTH) return { authenticated: true };

  const key = req.headers[SECURITY_CONFIG.API_KEY_HEADER];
  if (!key || typeof key !== 'string') {
    return { authenticated: false, error: 'Missing API key' };
  }

  const doc = await admin.firestore().doc('config/apiKey').get();
  const storedKey = doc.data()?.key as string | undefined;
  if (!storedKey || key !== storedKey) {
    return { authenticated: false, error: 'Invalid API key' };
  }
  return { authenticated: true };
}

// ---------------------------------------------------------------------------
// 3. Rate limiting (in-memory sliding window)
// ---------------------------------------------------------------------------
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;
const hits = new Map<string, number[]>();

export function checkRateLimit(
  _action: string,
  ip: string,
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const timestamps = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);

  if (timestamps.length >= MAX_REQUESTS) {
    const oldest = timestamps[0];
    return { allowed: false, retryAfterMs: WINDOW_MS - (now - oldest) };
  }

  timestamps.push(now);
  hits.set(ip, timestamps);
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// 4. Kite health pre-check
// ---------------------------------------------------------------------------
export async function checkKiteHealth(
  db: FirebaseFirestore.Firestore,
): Promise<{ healthy: boolean; reason?: string }> {
  const doc = await db.doc('config/kiteSession').get();
  if (!doc.exists) {
    return { healthy: false, reason: 'kiteSession doc missing' };
  }

  const data = doc.data()!;
  if (!data.accessToken) {
    return { healthy: false, reason: 'No access token stored' };
  }

  const expiresAt = data.expiresAt?.toDate?.() ?? data.expiresAt;
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    return { healthy: false, reason: 'Kite token expired' };
  }

  return { healthy: true };
}
