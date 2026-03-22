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

    report += `\n## 3. Signal Portfolio (End-to-End)\n`;
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
