# AGENTS.md — context for AI coding agents

Operational context for working on **ProTrade Alpha** (GCP project `suhas-ag`). Read this
first; it captures the non‑obvious facts that make changes safe. For product/architecture
detail see [blueprint.md](blueprint.md); for live state see [CONTEXT.md](CONTEXT.md).

## What this is

Autonomous **paper** EOD swing‑trading system for NSE equities. Firebase Cloud Functions
(gen1) + Firestore + React/Vite dashboard + Kite Connect. `MODE=PAPER_LIVE`, `PAPER_ONLY=true`
— no real orders.

## Build · test · deploy

```bash
cd functions
npm run build                 # tsc → lib/ (REQUIRED before every deploy; no predeploy hook)
npx jest                      # full suite (currently 168 tests / 15 suites)
npm run validate-rules        # static guardrail checks (ts-node src/services/regCheck.ts)
firebase deploy --only functions --project suhas-ag
```

- **Only 5 functions deploy:** `gateway`, `taskDispatcher`, `processSymbolTask`,
  `orchestrateEodTask`, `orchestrateDeepSyncTask`. If you add an HTTP/taskQueue function it
  deploys; a `functions.pubsub.schedule(...)` will compile but **the CLI will not deploy it**.
- **Schedules are Cloud Scheduler jobs**, not deployed functions. They POST
  `{"action":"..."}` to the gateway. To change a schedule, edit the Cloud Scheduler job (not code).

## Runtime shape

- **Single gateway** HTTP function; every operation is a `{ "action": "..." }` POST.
- EOD/deep‑sync **fan out per symbol via Cloud Tasks** (`taskClient.enqueueDispatch('processSymbolTask', …)`);
  a finalize step runs once `counts.done + counts.failed >= counts.total`.
- **Per‑symbol EOD stages** (in `processSymbolTask`): `FETCH → FILL → FEATURES → SIGNALS`.
  Each stage is idempotent via `idempotency/{jobId}_{symbol}_{stage}` sentinels.
- **FILL** (added intentionally): for `EOD_RUN` jobs only, each symbol fills the *previous*
  trading day's `ACCEPTED` paper orders at *today's* just‑fetched open. This replaced a 09:15
  "morning-fill" job that ran before the day's bar existed (`getBarOn` is exact‑date match →
  returned null → orders were stranded `ACCEPTED`). Do not reintroduce a pre‑open fill.

## Universes & strategies

- **Hunt** (EOD + morning) runs on **`nifty200`** (200 members). **History‑fill** runs on
  **`nifty500`** (504; a *superset* of nifty200). Members live at `universes/{id}/members/{SYM.NS}`.
- Constituent CSVs at repo root: `ind_nifty{50,200,500}list.csv` (col 3 = Symbol; append `.NS`).
- **Live strategies:** SEPA (`SepaBreakoutEOD`) + Metals rotation (`MetalsRotation`,
  `GOLDBEES`/`SILVERBEES`, no `.NS`). Toggles in `config/runtime.ts`: `SEPA_CONFIG.SEPA_ONLY`
  (default ON; env `SEPA_ONLY=0` re‑enables the dormant legacy 6‑strategy path), `METALS_CONFIG.ENABLED`.
- Metals ETFs are appended to the dispatch list by the orchestrator regardless of universe.

## Data model (Firestore, Native)

- `barsD/{symbol}/days/{YYYYMMDD}` — OHLCV. `features/{symbol}/days/{dateId}` — indicators.
- `regime/{dateId}`, `signals/{dateId}/items`, `paperOrders/{dateId}/items`, `paperFills/{dateId}/items`.
- `portfolio/default/positions/{symbol}`, `config/account`, `settings/kite`, `jobs/{jobId}`.
- **Fetch semantics** (`marketdata.ts` `doFetchCandles`): with no `forceDays` it does a
  **strict delta** (last stored bar + 1 → runDate; skips if already current). With `forceDays`
  it force‑fetches the last N days. `startDeepSync days=0` ⇒ strict‑delta (gap‑proof);
  `days=N` ⇒ fixed N‑day window (can leave a hole if the job is skipped > N days).

## Guardrails (do not break)

- **Kite rate limit:** max 3 req/s per API key. Dispatch is serialized at **350 ms** intervals
  with **0–500 ms jitter** in `doFetchCandles`. Never `Promise.all()` fetches against Kite.
- **One job at a time:** the gateway rejects a new run with 409 if any `jobs` doc is `RUNNING`.
  Sequence deep‑syncs/EOD; do not overlap.
- **Fail‑closed:** missing features/regime/correlation ⇒ reject the signal, never default permissive.

## Gotchas learned the hard way

- **Jest mock `get()` sequence:** `jest.setup.js` shares one chainable Firestore mock;
  `jest.clearAllMocks()` does **not** drain the `mockResolvedValueOnce` queue. If a prior test
  leaves a queued value, it shifts your `get()` order. Reset with `mockFirestore.get.mockReset()`
  + restore the default in tests sensitive to call order.
- **`features.ts` must not write `undefined`** (e.g. `rsScore`): Firestore rejects it and the
  whole EOD FETCH stage fails. Omit optional fields instead.
- **package-lock:** keep it pointed at the public npm registry — a corporate registry mirror in
  the lockfile breaks Cloud Build.

## Auth for REST/admin scripts

Firestore/Scheduler REST calls use an OAuth access token minted from the **local** Firebase CLI
credentials in `~/.config/configstore/firebase-tools.json` (`tokens.refresh_token`) via
`https://oauth2.googleapis.com/token`. **Never commit or log** the client secret, refresh token,
Kite API key/secret, or TOTP seed. Tokens last ~1 hour.

## Agent workflow

Follow [functions/.agent/workflows/regression-first.md](functions/.agent/workflows/regression-first.md):
run `validate-rules` + tests before and after changes; verify rate‑limiting and single‑job rules
after any deploy.
