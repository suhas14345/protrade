import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, Regime, AccountConfig } from '../models';
import { RISK_LIMITS } from '../config/runtime';
import { checkSafety } from './safety';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Risk Engine: Approves/Rejects signals and calculates position sizes.
 */
export async function doProcessRisk(dateId: string, jobId?: string) {
  const db = getDb();
  console.log(`[RiskEngine] Processing signals for ${dateId}`);

  checkSafety();

  // 1. Load Inputs
  const [regimeSnap, accountSnap, signalsSnap, riskStateSnap] = await Promise.all([
    db.collection('regime').doc(dateId).get(),
    db.collection('config').doc('account').get(),
    db.collection('signals').doc(dateId).collection('items').where('status', '==', 'NEW').get(),
    db.collection('config').doc('riskState').get()
  ]);

  if (!regimeSnap.exists || !accountSnap.exists) {
    console.error('Missing regime or account config. Aborting risk processing.');
    return;
  }

  const regime = regimeSnap.data() as Regime;
  const account = accountSnap.data() as AccountConfig;
  const signals = signalsSnap.docs.map(d => ({ id: d.id, ...d.data() as Signal }));
  const riskState = riskStateSnap.exists ? riskStateSnap.data() || {} : { consecutiveLosses: 0, lossesByRegime: {} };

  if (!regime.tradeAllowed) {
    console.log('Regime does not allow trading. Skipping risk approval.');
    return;
  }

  // Cooldown check
  const cooldowns = riskState.cooldowns || {};
  const cooldownUntil = cooldowns[regime.marketState];
  if (cooldownUntil && dateId < cooldownUntil) {
    console.warn(`[RiskEngine] Cooldown active for ${regime.marketState} until ${cooldownUntil}. Rejecting new trades.`);
    for (const signal of signals) {
        await db.collection('signals').doc(dateId).collection('items').doc(signal.id).update({
            status: 'REJECTED_BY_RISK',
            riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Regime cooldown active (${regime.marketState})` }
        });
    }
    return;
  }

  // 2. Load Portfolio Context (Current Open Positions)
  const positionsSnap = await db.collection('portfolio').doc('default').collection('positions').where('status', '==', 'OPEN').get();
  const openPositions = positionsSnap.docs.map(d => d.data());

  // Helper for counts and Heat R
  const sectorCounts: Record<string, number> = {};
  let currentHeatR = 0;

  for (const pos of openPositions) {
    const sector = (pos as any).sector || 'UNKNOWN';
    sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
    
    // Normalized risk (R-multiple) at time of entry: riskAmount / (equity_at_entry * baseRiskPct)
    // For simplicity, we use current equity and baseRiskPct to estimate current R-heat.
    const posRiskAmount = (pos as any).riskAmount || 0;
    const rMultiple = posRiskAmount / (account.equity * account.baseRiskPct);
    currentHeatR += rMultiple;
  }

  let approvedToday = 0;

  for (const signal of signals) {
    // Load Symbol Meta for Sector
    const symbolMetaSnap = await db.collection('universes').doc('nifty500').collection('members').doc(signal.symbol).get();
    const sector = symbolMetaSnap.exists ? (symbolMetaSnap.data() as any).sector : 'UNKNOWN';

    // A. Sizing Logic
    const strategyWeight = account.strategyRiskWeights[signal.strategy] || 1.0;
    const plannedEntry = signal.reasons.close; // Approximation for NEXT_OPEN
    const stopPrice = signal.stopPrice;
    
    const riskPerShare = Math.abs(plannedEntry - stopPrice);
    if (riskPerShare === 0) {
      console.warn(`[RiskEngine] Invalid risk for ${signal.symbol}. Skipping.`);
      continue;
    }

    let baseRiskPct = account.baseRiskPct;
    if ((riskState.consecutiveLosses || 0) >= 3) {
        baseRiskPct *= 0.5; // Halve risk after losing streak
        console.log(`[RiskEngine] Consecutive losses (${riskState.consecutiveLosses}) triggering 50% risk reduction.`);
    }

    const riskAmount = account.equity * baseRiskPct * regime.riskMultiplier * strategyWeight;
    const sizedQty = Math.floor(riskAmount / riskPerShare);
    const signalHeatR = riskAmount / (account.equity * account.baseRiskPct);

    // B. Constraint Checks
    let rejected = false;
    let reason = '';

    if (approvedToday >= regime.maxNewPositions) {
      rejected = true;
      reason = 'Max new positions per regime reached.';
    } else if (openPositions.length + approvedToday >= account.maxPositions) {
      rejected = true;
      reason = 'Max portfolio positions reached.';
    } else if ((sectorCounts[sector] || 0) >= RISK_LIMITS.maxPerSectorPositions) {
      rejected = true;
      reason = `Sector cap reached for ${sector}.`;
    } else if (regime.marketState === 'HIGH_VOL' && approvedToday >= RISK_LIMITS.maxSameDirectionInHighVol) {
      rejected = true;
      reason = 'Max same-direction positions in HIGH_VOL reached.';
    } else if (currentHeatR + signalHeatR > RISK_LIMITS.maxPortfolioHeatR) {
      rejected = true;
      reason = `Portfolio Heat too high (${(currentHeatR + signalHeatR).toFixed(1)}R > ${RISK_LIMITS.maxPortfolioHeatR}R).`;
    }

    // C. Update Signal
    const update: Partial<Signal> = {
      status: rejected ? 'REJECTED_BY_RISK' : 'APPROVED',
      riskApproval: {
        status: rejected ? 'REJECTED' : 'APPROVED',
        sizedQty,
        riskAmount,
        reason
      }
    };

    await db.collection('signals').doc(dateId).collection('items').doc(signal.id).update(update);
    console.log(`[RiskEngine] ${signal.symbol} (${sector}) ${update.status}: ${reason || 'Sized at ' + sizedQty}`);
    
    if (!rejected) {
      approvedToday++;
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
    }
  }

  if (jobId) {
    await db.collection('jobs').doc(jobId).update({ 
      stage: 'RISK',
      updatedAt: admin.firestore.Timestamp.now() 
    });
  }
}

export const riskEngineTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId, jobId } = req.body;
  try {
    await doProcessRisk(dateId, jobId);
    res.status(200).send('Risk processed');
  } catch (error) {
    console.error('Risk processing failed:', error);
    res.status(500).send('Internal Error');
  }
});
