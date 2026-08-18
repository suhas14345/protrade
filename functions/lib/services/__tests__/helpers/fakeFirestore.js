"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeFakeAdmin = makeFakeAdmin;
/**
 * Minimal in-memory Firestore, faithful enough to run the REAL ledger functions
 * (doPlaceOrders, doOpenFillSimulation, doManageTrades, recomputeAccountEquity) in a
 * deterministic end-to-end simulation. Supports docs, subcollections, where/orderBy/limit
 * queries (incl. FieldPath.documentId ranges), batch(), runTransaction(), FieldValue.increment,
 * and Timestamp. Not a general Firestore — only what the ledger path exercises.
 */
function makeFakeAdmin() {
    const docs = new Map(); // full path -> plain data object
    class Timestamp {
        constructor(_ms) {
            this._ms = _ms;
        }
        toMillis() { return this._ms; }
        toDate() { return new Date(this._ms); }
        static now() { return new Timestamp(Date.now()); }
        static fromDate(d) { return new Timestamp(d.getTime()); }
    }
    const INCREMENT = Symbol('increment');
    const FieldValue = { increment: (n) => ({ [INCREMENT]: n }) };
    const FieldPath = { documentId: () => '__name__' };
    function applyWrite(path, data, merge) {
        const cur = merge ? (docs.get(path) || {}) : {};
        const next = Object.assign({}, cur);
        for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && v[INCREMENT] !== undefined) {
                next[k] = (Number(cur[k]) || 0) + v[INCREMENT];
            }
            else {
                next[k] = v;
            }
        }
        docs.set(path, next);
    }
    class DocRef {
        constructor(path) {
            this.path = path;
        }
        get id() { return this.path.split('/').pop(); }
        collection(name) { return new CollectionRef(`${this.path}/${name}`); }
        async get() {
            const d = docs.get(this.path);
            return { exists: d !== undefined, id: this.id, ref: this, data: () => (d ? Object.assign({}, d) : undefined) };
        }
        async set(data, opts) { applyWrite(this.path, data, !!(opts === null || opts === void 0 ? void 0 : opts.merge)); }
        async update(data) {
            if (!docs.has(this.path))
                throw new Error(`update on missing doc: ${this.path}`);
            applyWrite(this.path, data, true);
        }
        async delete() { docs.delete(this.path); }
    }
    class Query {
        constructor(path) {
            this.path = path;
            this.filters = [];
            this.orders = [];
            this._limit = null;
        }
        _clone(next) { next.filters = [...this.filters]; next.orders = [...this.orders]; next._limit = this._limit; return next; }
        where(field, op, val) { const q = this._clone(new Query(this.path)); q.filters.push({ field, op, val }); return q; }
        orderBy(field, dir = 'asc') { const q = this._clone(new Query(this.path)); q.orders.push({ field, dir }); return q; }
        limit(n) { const q = this._clone(new Query(this.path)); q._limit = n; return q; }
        async get() {
            const prefix = this.path + '/';
            const valOf = (row, field) => (field === '__name__' ? row.id : row.data[field]);
            let rows = [...docs.entries()]
                .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
                .map(([p, data]) => ({ id: p.slice(prefix.length), path: p, data }));
            for (const f of this.filters) {
                rows = rows.filter((r) => {
                    const v = valOf(r, f.field);
                    switch (f.op) {
                        case '==': return v === f.val;
                        case '<=': return v <= f.val;
                        case '>=': return v >= f.val;
                        case '<': return v < f.val;
                        case '>': return v > f.val;
                        default: return true;
                    }
                });
            }
            for (const o of [...this.orders].reverse()) {
                rows.sort((a, b) => { const av = valOf(a, o.field), bv = valOf(b, o.field); const c = av < bv ? -1 : av > bv ? 1 : 0; return o.dir === 'desc' ? -c : c; });
            }
            if (this._limit != null)
                rows = rows.slice(0, this._limit);
            const out = rows.map((r) => ({ id: r.id, ref: new DocRef(r.path), data: () => (Object.assign({}, r.data)) }));
            return { docs: out, empty: out.length === 0, size: out.length, forEach: (cb) => out.forEach(cb) };
        }
    }
    class CollectionRef extends Query {
        doc(id) { return new DocRef(`${this.path}/${id}`); }
    }
    function batch() {
        const ops = [];
        return {
            set: (ref, data, opts) => { ops.push(() => applyWrite(ref.path, data, !!(opts === null || opts === void 0 ? void 0 : opts.merge))); },
            update: (ref, data) => { ops.push(() => applyWrite(ref.path, data, true)); },
            delete: (ref) => { ops.push(() => docs.delete(ref.path)); },
            commit: async () => { for (const op of ops)
                op(); },
        };
    }
    async function runTransaction(fn) {
        return fn({
            get: (ref) => ref.get(),
            set: (ref, data, opts) => applyWrite(ref.path, data, !!(opts === null || opts === void 0 ? void 0 : opts.merge)),
            update: (ref, data) => applyWrite(ref.path, data, true),
            delete: (ref) => docs.delete(ref.path),
        });
    }
    const db = {
        collection: (name) => new CollectionRef(name),
        doc: (path) => new DocRef(path),
        batch,
        runTransaction,
        settings: () => { },
        recursiveDelete: async () => { },
    };
    const firestore = Object.assign(() => db, { Timestamp, FieldValue, FieldPath });
    const admin = { apps: [{}], initializeApp: () => { }, firestore, storage: () => ({ bucket: () => { } }) };
    return { admin, db, docs };
}
//# sourceMappingURL=fakeFirestore.js.map