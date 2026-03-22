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
exports.seedUniverse = seedUniverse;
exports.cleanupUniverse = cleanupUniverse;
exports.validateUniverseCsv = validateUniverseCsv;
exports.updateUniverseFromCsv = updateUniverseFromCsv;
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0) {
        admin.initializeApp();
        const db = admin.firestore();
        db.settings({ ignoreUndefinedProperties: true });
        return db;
    }
    return admin.firestore();
};
/**
 * Seed the universe data with Nifty 50 and Nifty 500 constituents.
 */
async function seedUniverse(req, res) {
    var _a, _b;
    try {
        const db = getDb();
        // Custom symbols if provided in body
        const customSymbols = (_a = req.body) === null || _a === void 0 ? void 0 : _a.symbols;
        const targetUniverse = (_b = req.body) === null || _b === void 0 ? void 0 : _b.universe;
        if (customSymbols && targetUniverse) {
            console.log(`Seeding custom universe: ${targetUniverse} with ${customSymbols.length} symbols`);
            const batch = db.batch();
            for (const s of customSymbols) {
                const docRef = db.collection('universes').doc(targetUniverse).collection('members').doc(s);
                batch.set(docRef, { symbol: s, sector: 'CUSTOM', liquidityBucket: 'A' });
            }
            await batch.commit();
            res.status(200).send({ message: `Universe ${targetUniverse} seeded`, count: customSymbols.length });
            return;
        }
        const SAMPLE_CONSTITUENTS = [
            { symbol: "RELIANCE.NS", sector: "ENERGY" },
            { symbol: "TCS.NS", sector: "IT" },
            { symbol: "HDFCBANK.NS", sector: "FINANCIAL SERVICES" },
            { symbol: "INFY.NS", sector: "IT" },
            { symbol: "ICICIBANK.NS", sector: "FINANCIAL SERVICES" }
        ];
        const universes = [
            { id: 'sample', data: SAMPLE_CONSTITUENTS }
        ];
        const BATCH_SIZE = 400;
        const results = {};
        for (const universe of universes) {
            const symbols = universe.data;
            console.log(`Seeding universe: ${universe.id} with ${symbols.length} symbols`);
            for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
                const chunk = symbols.slice(i, i + BATCH_SIZE);
                const batch = db.batch();
                for (const s of chunk) {
                    const docRef = db.collection('universes').doc(universe.id).collection('members').doc(s.symbol);
                    const member = {
                        symbol: s.symbol,
                        sector: s.sector,
                        liquidityBucket: 'A'
                    };
                    batch.set(docRef, member);
                }
                await batch.commit();
            }
            results[universe.id] = symbols.length;
        }
        res.status(200).send({
            message: 'Universes seeded successfully',
            stats: results
        });
    }
    catch (error) {
        console.error('Failed to seed universe:', error);
        res.status(500).send({
            error: 'Failed to seed universe',
            details: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
    }
}
async function cleanupUniverse(req, res) {
    try {
        const db = getDb();
        const { universe = 'nifty500' } = req.query;
        // 1. Fetch live NSE instrument list from Kite
        const { getNSEInstruments } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
        const settingsSnap = await db.collection('settings').doc('kite').get();
        const settings = settingsSnap.data();
        if (!(settings === null || settings === void 0 ? void 0 : settings.apiKey) || !(settings === null || settings === void 0 ? void 0 : settings.accessToken)) {
            res.status(401).send({ error: 'Kite credentials missing or inactive' });
            return;
        }
        const instruments = await getNSEInstruments(settings.apiKey, settings.accessToken);
        const kiteSymbols = new Set(instruments.map((i) => i.tradingsymbol));
        // 2. Fetch all members of the universe
        const snap = await db.collection('universes').doc(universe).collection('members').get();
        const members = snap.docs.map(d => (Object.assign({ id: d.id }, d.data())));
        const stale = [];
        for (const m of members) {
            const search = m.id.endsWith('.NS') ? m.id.slice(0, -3) : m.id;
            if (!kiteSymbols.has(search)) {
                stale.push(m.id);
            }
        }
        if (stale.length === 0) {
            res.status(200).send({ message: `No stale members found in ${universe}`, count: members.length });
            return;
        }
        // 3. Perform batch delete
        const BATCH_SIZE = 400;
        let deletedCount = 0;
        for (let i = 0; i < stale.length; i += BATCH_SIZE) {
            const chunk = stale.slice(i, i + BATCH_SIZE);
            const batch = db.batch();
            for (const s of chunk) {
                batch.delete(db.collection('universes').doc(universe).collection('members').doc(s));
            }
            await batch.commit();
            deletedCount += chunk.length;
        }
        res.status(200).send({
            message: `Cleaned up universe ${universe}`,
            originalCount: members.length,
            deletedCount,
            remainingCount: members.length - deletedCount,
            staleSamples: stale.slice(0, 10)
        });
    }
    catch (error) {
        console.error('Failed to cleanup universe:', error);
        res.status(500).send({ error: 'Failed to cleanup universe', details: error instanceof Error ? error.message : String(error) });
    }
}
async function validateUniverseCsv(req, res) {
    try {
        const db = getDb();
        const { csvContent } = req.body;
        if (!csvContent) {
            res.status(400).send({ error: 'csvContent is required in body' });
            return;
        }
        // 1. Fetch live NSE instruments from Kite
        const { getNSEInstruments } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
        const settingsSnap = await db.collection('settings').doc('kite').get();
        const settings = settingsSnap.data();
        if (!(settings === null || settings === void 0 ? void 0 : settings.apiKey) || !(settings === null || settings === void 0 ? void 0 : settings.accessToken)) {
            res.status(401).send({ error: 'Kite credentials missing or inactive' });
            return;
        }
        const instruments = await getNSEInstruments(settings.apiKey, settings.accessToken);
        const kiteSymbols = new Set(instruments.map((i) => i.tradingsymbol));
        // 2. Parse CSV (Company Name,Industry,Symbol,Series,ISIN Code)
        const lines = csvContent.split('\n');
        const symbolsWithMeta = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line)
                continue;
            // Handle potential quoted commas in company names
            const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 3) {
                const name = parts[0].replace(/\"/g, '');
                const sector = parts[1].replace(/\"/g, '');
                const symbol = parts[2].trim();
                if (symbol && symbol !== 'Symbol') {
                    symbolsWithMeta.push({ symbol, sector, name });
                }
            }
        }
        // 3. Validate against Kite
        const found = [];
        const missing = [];
        for (const item of symbolsWithMeta) {
            if (kiteSymbols.has(item.symbol)) {
                found.push(item);
            }
            else {
                missing.push(item);
            }
        }
        res.status(200).send({
            totalCsvSymbols: symbolsWithMeta.length,
            foundCount: found.length,
            missingCount: missing.length,
            missingSymbols: missing.map(m => m.symbol),
            foundSample: found.slice(0, 10),
            isReady: missing.length === 0
        });
    }
    catch (error) {
        console.error('Validation failed:', error);
        res.status(500).send({ error: 'Validation failed', details: error instanceof Error ? error.message : String(error) });
    }
}
async function updateUniverseFromCsv(req, res) {
    try {
        const db = getDb();
        const { csvContent, universe = 'nifty500', append = false } = req.body;
        if (!csvContent) {
            res.status(400).send({ error: 'csvContent is required' });
            return;
        }
        // 1. Parse CSV
        const lines = csvContent.split('\n');
        const symbolsWithMeta = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line)
                continue;
            const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 3) {
                const name = parts[0].replace(/\"/g, '');
                const sector = parts[1].replace(/\"/g, '');
                const symbol = parts[2].trim();
                if (symbol && symbol !== 'Symbol') {
                    // Force .NS suffix for consistent lookups in marketdata
                    const fullSymbol = symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
                    symbolsWithMeta.push({ symbol: fullSymbol, sector, name });
                }
            }
        }
        if (!append) {
            // Clear existing members first
            console.log(`Clearing existing members of universe: ${universe}`);
            const membersSnap = await db.collection('universes').doc(universe).collection('members').get();
            const BATCH_SIZE = 400;
            for (let i = 0; i < membersSnap.docs.length; i += BATCH_SIZE) {
                const chunk = membersSnap.docs.slice(i, i + BATCH_SIZE);
                const batch = db.batch();
                chunk.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            }
        }
        // 2. Batch write new members
        console.log(`Writing ${symbolsWithMeta.length} members to universe: ${universe}`);
        const BATCH_SIZE = 400;
        for (let i = 0; i < symbolsWithMeta.length; i += BATCH_SIZE) {
            const chunk = symbolsWithMeta.slice(i, i + BATCH_SIZE);
            const batch = db.batch();
            for (const item of chunk) {
                const docRef = db.collection('universes').doc(universe).collection('members').doc(item.symbol);
                batch.set(docRef, {
                    symbol: item.symbol,
                    sector: item.sector,
                    name: item.name,
                    liquidityBucket: 'A',
                    updatedAt: admin.firestore.Timestamp.now()
                });
            }
            await batch.commit();
        }
        res.status(200).send({
            message: `Universe ${universe} updated successfully`,
            count: symbolsWithMeta.length,
            append
        });
    }
    catch (error) {
        console.error('Update failed:', error);
        res.status(500).send({ error: 'Update failed', details: error instanceof Error ? error.message : String(error) });
    }
}
//# sourceMappingURL=universe.js.map