import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

// ── Alert types ──────────────────────────────────────────────────────
export enum AlertType {
  DATA_STALE = 'DATA_STALE',
  JOB_FAILED = 'JOB_FAILED',
  DRAWDOWN_WARNING = 'DRAWDOWN_WARNING',
  DRAWDOWN_HALT = 'DRAWDOWN_HALT',
  KILL_SWITCH = 'KILL_SWITCH',
  SYSTEMATIC_BIAS = 'SYSTEMATIC_BIAS',
  CORPORATE_ACTION = 'CORPORATE_ACTION',
  EXECUTION_DRIFT = 'EXECUTION_DRIFT',
  RECONCILIATION_WARN = 'RECONCILIATION_WARN',
  RECONCILIATION_HALT = 'RECONCILIATION_HALT',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SIGNAL_AUDIT = 'SIGNAL_AUDIT',
}

export type AlertSeverity = 'INFO' | 'WARN' | 'CRITICAL';

export interface Alert {
  id?: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  metadata?: Record<string, any>;
  timestamp: Timestamp;
  acknowledged: boolean;
}

// ── Thresholds ───────────────────────────────────────────────────────
export const THRESHOLDS = {
  RECONCILIATION_WARN_BPS: 30,
  RECONCILIATION_HALT_BPS: 50,
  DRAWDOWN_WARN_PCT: 10,
  DRAWDOWN_HALT_PCT: 20,
  SYSTEMATIC_BIAS_STREAK: 5,
} as const;

// ── Core functions ───────────────────────────────────────────────────

/**
 * Write an alert to the `alerts` Firestore collection.
 * TODO: Add external notification channels (email, Telegram, etc.) here.
 */
export async function raiseAlert(
  type: AlertType,
  severity: AlertSeverity,
  message: string,
  metadata?: Record<string, any>,
): Promise<string> {
  const db = getDb();
  const alert: Omit<Alert, 'id'> = {
    type,
    severity,
    message,
    metadata: metadata ?? {},
    timestamp: Timestamp.now(),
    acknowledged: false,
  };
  const ref = await db.collection('alerts').add(alert);
  console.log(`[Alert] ${severity} ${type}: ${message}`);
  return ref.id;
}

/**
 * Detect N consecutive same-direction execution biases.
 * Each trade should carry a numeric `biasDirection` (positive = over-fill, negative = under-fill).
 */
export async function checkSystematicBias(
  recentTrades: { symbol: string; biasDirection: number }[],
): Promise<boolean> {
  if (recentTrades.length < THRESHOLDS.SYSTEMATIC_BIAS_STREAK) return false;

  const tail = recentTrades.slice(-THRESHOLDS.SYSTEMATIC_BIAS_STREAK);
  const allPositive = tail.every((t) => t.biasDirection > 0);
  const allNegative = tail.every((t) => t.biasDirection < 0);

  if (allPositive || allNegative) {
    const direction = allPositive ? 'positive' : 'negative';
    await raiseAlert(
      AlertType.SYSTEMATIC_BIAS,
      'WARN',
      `${THRESHOLDS.SYSTEMATIC_BIAS_STREAK} consecutive ${direction} execution biases detected`,
      { streak: THRESHOLDS.SYSTEMATIC_BIAS_STREAK, direction, trades: tail },
    );
    return true;
  }
  return false;
}

/**
 * Compare expected vs actual P&L and raise reconciliation alerts
 * when drift exceeds warning / halt thresholds (in basis points).
 */
export async function checkReconciliationDrift(
  expectedPnl: number,
  actualPnl: number,
): Promise<{ driftBps: number; alertId?: string }> {
  const base = Math.abs(expectedPnl) || 1; // avoid division by zero
  const driftBps = (Math.abs(actualPnl - expectedPnl) / base) * 10_000;

  if (driftBps >= THRESHOLDS.RECONCILIATION_HALT_BPS) {
    const alertId = await raiseAlert(
      AlertType.RECONCILIATION_HALT,
      'CRITICAL',
      `Reconciliation drift ${driftBps.toFixed(1)} bps exceeds halt threshold`,
      { expectedPnl, actualPnl, driftBps },
    );
    return { driftBps, alertId };
  }

  if (driftBps >= THRESHOLDS.RECONCILIATION_WARN_BPS) {
    const alertId = await raiseAlert(
      AlertType.RECONCILIATION_WARN,
      'WARN',
      `Reconciliation drift ${driftBps.toFixed(1)} bps exceeds warning threshold`,
      { expectedPnl, actualPnl, driftBps },
    );
    return { driftBps, alertId };
  }

  return { driftBps };
}

/** Return all unacknowledged alerts, newest first. */
export async function getUnacknowledgedAlerts(): Promise<Alert[]> {
  const db = getDb();
  const snap = await db
    .collection('alerts')
    .where('acknowledged', '==', false)
    .orderBy('timestamp', 'desc')
    .get();

  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Alert));
}

/** Mark an alert as acknowledged. */
export async function acknowledgeAlert(alertId: string): Promise<void> {
  const db = getDb();
  await db.collection('alerts').doc(alertId).update({ acknowledged: true });
}
