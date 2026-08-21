"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatSnapshotText = formatSnapshotText;
exports.buildDailySnapshot = buildDailySnapshot;
exports.snapshotTask = snapshotTask;
const admin = __importStar(require("firebase-admin"));
const portfolioEquity_1 = require("./portfolioEquity");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
const inr = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : '₹' + Math.round(Number(n)).toLocaleString('en-IN'));
const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : (Number(n) >= 0 ? '+' : '') + Number(n).toFixed(1) + '%');
/** Render the snapshot as a compact plain-text digest (Telegram/email friendly). Pure. */
function formatSnapshotText(s) {
    const a = s.account;
    const lines = [];
    lines.push(`ProTrade snapshot — ${s.dateId}`);
    const critTag = s.critic ? `[${s.critic.severity}${s.critic.critical ? ` ${s.critic.critical} crit` : ''}${s.critic.warn ? ` ${s.critic.warn} warn` : ''}]` : '[critic: n/a]';
    lines.push(`Health ${critTag}`);
    lines.push('');
    lines.push(`Equity ${inr(a.equity)} | Cash ${inr(a.cash)} | Deployed ${inr(a.deployed)}`);
    lines.push(`Realized ${inr(a.realized)} | Unrealized ${inr(a.unrealized)}`);
    lines.push('');
    if (s.positions.length === 0) {
        lines.push('Active trades: none');
    }
    else {
        lines.push(`Active trades (${s.positions.length}):`);
        for (const p of s.positions) {
            lines.push(`  ${p.symbol} (${p.strategy}) x${p.qty} @ ${inr(p.entry)} -> ${inr(p.current)}  ${inr(p.pnl)} (${pct(p.pnlPct)})  stop ${inr(p.stop)}`);
        }
    }
    lines.push('');
    const byStrat = Object.entries(s.activity.byStrategy).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
    lines.push(`Today: ${s.activity.signals} signals (${s.activity.approved} approved; ${byStrat}), ${s.activity.entryOrders} orders, ${s.activity.entryFills} entries / ${s.activity.exitFills} exits filled`);
    return lines.join('\n');
}
/** Assemble the daily snapshot from live Firestore state. */
async function buildDailySnapshot(dateInput) {
    var _a, _b, _c, _d, _e, _f, _g;
    const db = getDb();
    const date = (dateInput || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
    const dateId = date.replace(/-/g, '');
    const [accSnap, posSnap, sigSnap, ordSnap, fillSnap, criticSnap] = await Promise.all([
        db.collection('config').doc('account').get(),
        db.collection('portfolio').doc('default').collection('positions').where('status', '==', 'OPEN').get(),
        db.collection('signals').doc(dateId).collection('items').get(),
        db.collection('paperOrders').doc(dateId).collection('items').get(),
        db.collection('paperFills').doc(dateId).collection('items').get(),
        db.collection('critic').doc(dateId).get(),
    ]);
    const account = accSnap.exists ? accSnap.data() : {};
    const deployed = await (0, portfolioEquity_1.computeDeployedCost)(db);
    const positions = posSnap.docs.map((d) => {
        const p = d.data();
        return {
            symbol: p.symbol, strategy: p.strategy || '—', qty: Number(p.qty),
            entry: Number(p.avgEntryPrice),
            current: p.currentPrice != null ? Number(p.currentPrice) : null,
            pnl: p.unrealizedPnl != null ? Number(p.unrealizedPnl) : null,
            pnlPct: p.unrealizedPnlPct != null ? Number(p.unrealizedPnlPct) : null,
            stop: Number(p.stopPrice),
        };
    }).sort((a, b) => { var _a, _b; return ((_a = b.pnl) !== null && _a !== void 0 ? _a : 0) - ((_b = a.pnl) !== null && _b !== void 0 ? _b : 0); });
    const byStrategy = {};
    let approved = 0;
    for (const d of sigSnap.docs) {
        const s = d.data();
        byStrategy[s.strategy] = (byStrategy[s.strategy] || 0) + 1;
        if (s.status === 'APPROVED' || s.status === 'ORDERED' || s.status === 'IN_TRADE')
            approved++;
    }
    const entryOrders = ordSnap.docs.filter((d) => d.data().orderType === 'ENTRY').length;
    let entryFills = 0, exitFills = 0;
    for (const d of fillSnap.docs) {
        const t = d.data().fillType;
        if (t === 'ENTRY')
            entryFills++;
        else
            exitFills++;
    }
    const critic = criticSnap.exists
        ? { severity: criticSnap.data().severity, critical: (_b = (_a = criticSnap.data().counts) === null || _a === void 0 ? void 0 : _a.critical) !== null && _b !== void 0 ? _b : 0, warn: (_d = (_c = criticSnap.data().counts) === null || _c === void 0 ? void 0 : _c.warn) !== null && _d !== void 0 ? _d : 0 }
        : null;
    return {
        dateId,
        account: {
            equity: Number((_e = account.equity) !== null && _e !== void 0 ? _e : 0),
            cash: account.cashBalance != null ? Number(account.cashBalance) : (0, portfolioEquity_1.settledCash)(account) - deployed,
            deployed,
            realized: Number((_f = account.realizedPnl) !== null && _f !== void 0 ? _f : 0),
            unrealized: Number((_g = account.openUnrealized) !== null && _g !== void 0 ? _g : 0),
        },
        positions,
        activity: { signals: sigSnap.size, approved, byStrategy, entryOrders, entryFills, exitFills },
        critic,
    };
}
/** Gateway task: { action:"snapshot", date?, format? } — returns text (default) or json. */
async function snapshotTask(req, res) {
    var _a, _b, _c, _d;
    try {
        const date = ((_a = req.body) === null || _a === void 0 ? void 0 : _a.date) || ((_b = req.query) === null || _b === void 0 ? void 0 : _b.date);
        const format = String(((_c = req.body) === null || _c === void 0 ? void 0 : _c.format) || ((_d = req.query) === null || _d === void 0 ? void 0 : _d.format) || 'text');
        const snap = await buildDailySnapshot(date);
        if (format === 'json') {
            res.status(200).send(snap);
            return;
        }
        res.status(200).type('text/plain').send(formatSnapshotText(snap));
    }
    catch (e) {
        res.status(500).send({ error: e.message });
    }
}
//# sourceMappingURL=snapshot.js.map