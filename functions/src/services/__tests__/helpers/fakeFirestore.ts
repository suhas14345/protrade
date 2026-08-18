/**
 * Minimal in-memory Firestore, faithful enough to run the REAL ledger functions
 * (doPlaceOrders, doOpenFillSimulation, doManageTrades, recomputeAccountEquity) in a
 * deterministic end-to-end simulation. Supports docs, subcollections, where/orderBy/limit
 * queries (incl. FieldPath.documentId ranges), batch(), runTransaction(), FieldValue.increment,
 * and Timestamp. Not a general Firestore — only what the ledger path exercises.
 */
export function makeFakeAdmin() {
  const docs = new Map<string, any>(); // full path -> plain data object

  class Timestamp {
    constructor(public _ms: number) {}
    toMillis() { return this._ms; }
    toDate() { return new Date(this._ms); }
    static now() { return new Timestamp(Date.now()); }
    static fromDate(d: Date) { return new Timestamp(d.getTime()); }
  }
  const INCREMENT = Symbol('increment');
  const FieldValue = { increment: (n: number) => ({ [INCREMENT]: n }) };
  const FieldPath = { documentId: () => '__name__' };

  function applyWrite(path: string, data: any, merge: boolean) {
    const cur = merge ? (docs.get(path) || {}) : {};
    const next: any = { ...cur };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && (v as any)[INCREMENT] !== undefined) {
        next[k] = (Number(cur[k]) || 0) + (v as any)[INCREMENT];
      } else {
        next[k] = v;
      }
    }
    docs.set(path, next);
  }

  class DocRef {
    constructor(public path: string) {}
    get id() { return this.path.split('/').pop() as string; }
    collection(name: string) { return new CollectionRef(`${this.path}/${name}`); }
    async get() {
      const d = docs.get(this.path);
      return { exists: d !== undefined, id: this.id, ref: this, data: () => (d ? { ...d } : undefined) };
    }
    async set(data: any, opts?: { merge?: boolean }) { applyWrite(this.path, data, !!opts?.merge); }
    async update(data: any) {
      if (!docs.has(this.path)) throw new Error(`update on missing doc: ${this.path}`);
      applyWrite(this.path, data, true);
    }
    async delete() { docs.delete(this.path); }
  }

  class Query {
    filters: Array<{ field: any; op: string; val: any }> = [];
    orders: Array<{ field: any; dir: 'asc' | 'desc' }> = [];
    _limit: number | null = null;
    constructor(public path: string) {}
    protected _clone(next: Query) { next.filters = [...this.filters]; next.orders = [...this.orders]; next._limit = this._limit; return next; }
    where(field: any, op: string, val: any) { const q = this._clone(new Query(this.path)); q.filters.push({ field, op, val }); return q; }
    orderBy(field: any, dir: 'asc' | 'desc' = 'asc') { const q = this._clone(new Query(this.path)); q.orders.push({ field, dir }); return q; }
    limit(n: number) { const q = this._clone(new Query(this.path)); q._limit = n; return q; }
    async get() {
      const prefix = this.path + '/';
      const valOf = (row: any, field: any) => (field === '__name__' ? row.id : row.data[field]);
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
      if (this._limit != null) rows = rows.slice(0, this._limit);
      const out = rows.map((r) => ({ id: r.id, ref: new DocRef(r.path), data: () => ({ ...r.data }) }));
      return { docs: out, empty: out.length === 0, size: out.length, forEach: (cb: any) => out.forEach(cb) };
    }
  }

  class CollectionRef extends Query {
    doc(id: string) { return new DocRef(`${this.path}/${id}`); }
  }

  function batch() {
    const ops: Array<() => void> = [];
    return {
      set: (ref: DocRef, data: any, opts?: any) => { ops.push(() => applyWrite(ref.path, data, !!opts?.merge)); },
      update: (ref: DocRef, data: any) => { ops.push(() => applyWrite(ref.path, data, true)); },
      delete: (ref: DocRef) => { ops.push(() => docs.delete(ref.path)); },
      commit: async () => { for (const op of ops) op(); },
    };
  }

  async function runTransaction(fn: any) {
    return fn({
      get: (ref: DocRef) => ref.get(),
      set: (ref: DocRef, data: any, opts?: any) => applyWrite(ref.path, data, !!opts?.merge),
      update: (ref: DocRef, data: any) => applyWrite(ref.path, data, true),
      delete: (ref: DocRef) => docs.delete(ref.path),
    });
  }

  const db = {
    collection: (name: string) => new CollectionRef(name),
    doc: (path: string) => new DocRef(path),
    batch,
    runTransaction,
    settings: () => {},
    recursiveDelete: async () => {},
  };

  const firestore = Object.assign(() => db, { Timestamp, FieldValue, FieldPath });
  const admin = { apps: [{}], initializeApp: () => {}, firestore, storage: () => ({ bucket: () => {} }) };
  return { admin, db, docs };
}
