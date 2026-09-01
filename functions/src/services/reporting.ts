import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

const getDb = () => {
    if (admin.apps.length === 0) admin.initializeApp();
    return admin.firestore();
};

export async function generateJobReport(jobId: string, runDate: string) {
    const db = getDb();
    const dateId = runDate.replace(/-/g, '');

    // 1. Fetch Job Data
    const jobSnap = await db.collection('jobs').doc(jobId).get();
    const jobData = jobSnap.data();
    if (!jobData) throw new Error(`Job ${jobId} not found`);

    // 2. Fetch Regime Data
    const regimeSnap = await db.collection('regime').doc(dateId).get();
    const regimeData = regimeSnap.data();

    // 3. Fetch Signals Data
    const signalsSnap = await db.collection('signals').doc(dateId).collection('items').get();
    const signals: any[] = signalsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // 3b. Fetch per-symbol evaluation sentinels (why-no-signal accounting)
    const statusSnap = await db.collection('signals').doc(dateId).collection('status').get();
    const evalCounts = { done: 0, skipped: 0, error: 0 };
    for (const d of statusSnap.docs) {
        const st = (d.data() as any).status;
        if (st === 'SKIPPED') evalCounts.skipped++;
        else if (st === 'ERROR') evalCounts.error++;
        else evalCounts.done++;
    }

    // 4. Build Report Markdown
    let report = `# Run Analysis Report: ${runDate}\n`;
    report += `**Job ID:** ${jobId}\n`;
    report += `**Status:** ${jobData.status}\n`;
    report += `**Market State:** ${jobData.marketState || 'UNKNOWN'}\n\n`;

    report += `## 1. Summary Overview\n`;
    report += `- **Universe:** ${jobData.universeId || 'N/A'}\n`;
    report += `- **Data Source:** ${jobData.dataSource || 'KITE'}\n`;
    report += `- **Total Symbols:** ${jobData.counts?.total || 0}\n`;
    report += `- **Successful:** ${jobData.counts?.done || 0}\n`;
    report += `- **Failed:** ${jobData.counts?.failed || 0}\n`;
    report += `- **Signals Generated:** ${signals.length}\n`;

    report += `\n## 2. Market Regime Analysis\n`;
    if (regimeData) {
        report += `**Current State:** ${regimeData.marketState}\n\n`;
        report += `### Reasoning & Technical Context\n`;
        report += `${regimeData.reason || 'Calculated based on index SMA/EMA slopes.'}\n\n`;
        
        if (regimeData.metrics) {
            report += `| Metric | Value | Reference |\n`;
            report += `|--------|-------|-----------|\n`;
            report += `| Index Close | ${regimeData.metrics.close?.toFixed(2) || 'N/A'} | Market Level |\n`;
            report += `| EMA 200 | ${regimeData.metrics.ema200?.toFixed(2) || 'N/A'} | Major Trend |\n`;
            report += `| EMA 200 Slope | ${regimeData.metrics.ema200Slope?.toFixed(4) || 'N/A'} | Momentum |\n`;
            if (regimeData.metrics.ema20) {
                report += `| EMA 20 | ${regimeData.metrics.ema20?.toFixed(2) || 'N/A'} | Short Term |\n`;
            }
        }
    } else {
        report += `*Regime data not found for this date.*\n`;
    }

    // Signal generation diagnosis — distinguishes a regime block from genuinely no setups.
    const marketState = regimeData?.marketState || 'UNKNOWN';
    const tradeAllowed = regimeData?.tradeAllowed;
    report += `\n## 3. Signal Generation Diagnosis\n`;
    report += `- **Symbols evaluated:** ${evalCounts.done + evalCounts.skipped + evalCounts.error} (skipped ${evalCounts.skipped}, errors ${evalCounts.error})\n`;
    report += `- **Signals generated:** ${signals.length}\n`;
    if (signals.length === 0) {
        if (tradeAllowed === false || marketState === 'TRANSITION' || marketState === 'BEAR') {
            report += `- **Verdict:** ⛔ **Regime gate closed** — no entries permitted. `;
            report += `Market state \`${marketState}\`, tradeAllowed=\`${tradeAllowed}\`. ${regimeData?.reason || ''}\n`;
            report += `- The strategy engine short-circuited before scoring candidates; this is an intentional risk-off block, not a data problem.\n`;
        } else {
            report += `- **Verdict:** ✅ **Regime permitted trading** (state \`${marketState}\`) but **no symbol met the entry criteria** `;
            report += `(SEPA trend-template + within-15%-of-52w-high + RS top-40, or ATH pullback-into-50SMA). Genuinely no setups.\n`;
        }
    } else {
        const approved = signals.filter(s => ['APPROVED', 'ORDERED', 'IN_TRADE'].includes(s.status)).length;
        report += `- **Verdict:** ✅ Regime permitted trading (state \`${marketState}\`); ${signals.length} candidates found, ${approved} approved for entry.\n`;
    }

    report += `\n## 4. Signal Portfolio (End-to-End)\n`;
    if (signals.length > 0) {
        report += `| Symbol | Strategy | Side | Status | Score | RSI | Volatility | Reasoning |\n`;
        report += `|--------|----------|------|--------|-------|-----|------------|-----------|\n`;
        for (const sig of signals) {
            const feat = sig.features || {};
            const score = sig.score || 'N/A';
            const rsi = feat.rsi14 ? feat.rsi14.toFixed(1) : 'N/A';
            const vol = feat.atrPct ? (feat.atrPct * 100).toFixed(2) + '%' : 'N/A';
            const reason = sig.reason || 'Meets strategy criteria';
            report += `| ${sig.symbol} | ${sig.strategy} | ${sig.direction || 'N/A'} | ${sig.status} | ${score} | ${rsi} | ${vol} | ${reason} |\n`;
        }
    } else {
        report += `*No signals were generated in this run after evaluating the entire universe.*\n`;
    }

    report += `\n\n--- Report generated at ${new Date().toISOString()} ---`;

    // 6. Save Report
    await db.collection('jobs').doc(jobId).collection('reports').doc('final').set({
        content: report,
        format: 'markdown',
        createdAt: Timestamp.now()
    });

    const { logger } = await import('./logger');
    logger.info(`[Reporting] Generated report for job ${jobId}`, 'Reporting', { jobId });
    return report;
}

/**
 * Scan watchlist across the last N trading days, track each symbol's state
 * progression, and return conversion analytics.
 */
export async function watchlistConversionStats(req: any, res: any): Promise<void> {
    const db = getDb();
    const days = parseInt(req.query?.days || req.body?.days) || 30;

    // Watchlist subcollections live under watchlist/{dateId}/items but the parent
    // docs may not exist. Derive candidate dateIds from the jobs collection instead.
    const jobsSnap = await db.collection('jobs').limit(200).get();
    const dateIdSet = new Set<string>();
    for (const jdoc of jobsSnap.docs) {
        const rd = jdoc.data().runDate as string | undefined;
        if (rd) dateIdSet.add(rd.replace(/-/g, ''));
    }
    const dateIds = [...dateIdSet].sort().slice(-days);

    // symbol → { firstSeen, lastSeen, firstStatus, lastStatus, datesSeen, history }
    const tracker: Record<string, {
        firstSeen: string; lastSeen: string; firstStatus: string; lastStatus: string;
        datesSeen: number; history: { date: string; status: string }[];
    }> = {};

    for (const dateId of dateIds) {
        const snap = await db.collection('watchlist').doc(dateId).collection('items').get();
        for (const doc of snap.docs) {
            const data = doc.data();
            const sym = data.symbol as string;
            const status = data.status as string;
            if (!sym || !status) continue;

            if (!tracker[sym]) {
                tracker[sym] = { firstSeen: dateId, lastSeen: dateId, firstStatus: status, lastStatus: status, datesSeen: 0, history: [] };
            }
            tracker[sym].lastSeen = dateId;
            tracker[sym].lastStatus = status;
            tracker[sym].datesSeen++;
            tracker[sym].history.push({ date: dateId, status });
        }
    }

    // Classify outcomes
    let triggered = 0, ready = 0, setup = 0, invalidated = 0, extended = 0;
    const items: any[] = [];

    for (const [sym, t] of Object.entries(tracker)) {
        const peaked = t.history.some(h => h.status === 'TRIGGERED');
        if (peaked) triggered++;
        else if (t.lastStatus === 'INVALIDATED') invalidated++;
        else if (t.lastStatus === 'READY') ready++;
        else if (t.lastStatus === 'EXTENDED') extended++;
        else setup++;

        items.push({
            symbol: sym,
            firstSeen: t.firstSeen,
            lastSeen: t.lastSeen,
            datesSeen: t.datesSeen,
            firstStatus: t.firstStatus,
            lastStatus: t.lastStatus,
            outcome: peaked ? 'BREAKOUT' : t.lastStatus,
            history: t.history,
        });
    }

    const total = items.length;
    const summary = {
        totalTracked: total,
        breakouts: triggered,
        stillReady: ready,
        stillSetup: setup,
        extended,
        invalidated,
        conversionRate: total > 0 ? ((triggered / total) * 100).toFixed(1) + '%' : '0%',
        dateRange: { from: dateIds[0], to: dateIds[dateIds.length - 1], daysScanned: dateIds.length },
    };

    res.status(200).json({ summary, items });
}
