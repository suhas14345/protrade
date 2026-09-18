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
npx jest                      # full suite (currently 297 tests / 26 suites)
npm run validate-rules        # static guardrail checks (ts-node src/services/regCheck.ts)
firebase deploy --only functions --project suhas-ag --force   # --force: skip the Artifact
#   Registry cleanup-policy prompt that otherwise hangs a non-interactive deploy (see Gotchas)
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
- **Telegram daily digest:** sent once at **EOD finalize** (orchestrator wrap‑up, after
  `generateJobReport`) via `telegram.ts` `sendDailyDigest` → `snapshot.ts` `formatSnapshotText`.
  **No‑op unless `settings/telegram.enabled`**; EOD runs only (not deep‑syncs). Bot token is a
  secret — never log it. Gateway actions: `getTelegramSettings`/`updateTelegram`/`testTelegram`/
  `sendDigest`. User‑facing content/sample is in [README.md](README.md#notifications--daily-telegram-digest).

## Universes & strategies

- **Hunt** (EOD + morning) runs on **`DEFAULT_UNIVERSE`** — now **`eligible`** (the full
  trend‑template pool, ~700; `config/runtime.ts` L16, env `DEFAULT_UNIVERSE` overrides; was
  `nifty200`, then `dynamic`). A nightly **dynamic screener** (`screenUniverse` /
  `universeScreen.ts`) prunes the source pool (`SCREEN_CONFIG.SOURCE_UNIVERSE`, `nifty500`;
  being expanded toward `liquidnse` ~1.7k) into `universes/eligible` (+ a smaller momentum cut
  `universes/dynamic`).
- **Daily bar fill** runs on **`nifty500`** (504) via the 18:30 `history-fill-500` job so the
  screener always has fresh bars. Members live at `universes/{id}/members/{SYM.NS}`.
- Constituent CSVs at repo root: `ind_nifty{50,200,500}list.csv` (col 3 = Symbol; append `.NS`).
  **Keep CSVs current for renames/demergers** (see Gotchas); re‑seed with `reseed_universes.js`.
- **Live strategies:** SEPA (`SepaBreakoutEOD`) + ATH‑Pullback (`ATHPullbackEOD`, equities, buys
  leaders on a dip; shares the SEPA capital book) + Metals rotation (`MetalsRotation`,
  `GOLDBEES`/`SILVERBEES`, no `.NS`). Toggles in `config/runtime.ts`: `SEPA_CONFIG.SEPA_ONLY`
  (default ON; env `SEPA_ONLY=0` re‑enables the dormant legacy 6‑strategy path), `ATH_CONFIG.ENABLED`
  (env `ATH=0` off), `METALS_CONFIG.ENABLED`.
- Metals ETFs are appended to the dispatch list by the orchestrator regardless of universe.

## Data model (Firestore, Native)

- `barsD/{symbol}/days/{YYYYMMDD}` — OHLCV. `features/{symbol}/days/{dateId}` — indicators.
- `regime/{dateId}`, `signals/{dateId}/items`, `paperOrders/{dateId}/items`, `paperFills/{dateId}/items`.
- `portfolio/default/positions/{symbol}`, `config/account`, `settings/kite`, `settings/telegram`, `jobs/{jobId}`.
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

## Kite auth & session (auto‑renew)

- **Credentials + state live in `settings/kite`:** `apiKey`, `apiSecret`, `userId`, `password`,
  `totpSecret` (inputs) and `accessToken`, `status`, `lastError`, `lastAutoRenew`,
  `renewFailCount`, `autoRenewDisabled` (state). **Kite tokens expire daily ~07:30 IST**, so a
  fresh session must exist before the 16:30 EOD and 18:30 fill.
- **`totpSecret` MUST be the base32 SEED** (e.g. `JBSWY3DPEHPK3PXP`, ~16/32 chars `[A-Z2-7]`),
  **NOT** the rotating 6‑digit code — the #1 setup mistake. **Zerodha locks the account after
  ~5 consecutive failed TOTP attempts**, so NEVER retry a renewal blindly.
- **Auto‑renew** (`kite_automation.ts` `autoRenewKiteSessionHandler`): headless login
  (`api/login` → `api/twofa` with a generated TOTP → OAuth redirect chain → `request_token` →
  `generateSession`) → writes a fresh `accessToken`. The daily **`kite-auto-renew` Cloud Scheduler
  job (08:30 IST)** POSTs `{"action":"scheduledKiteRenew"}` to the gateway.
- **Circuit breaker:** after `KITE_MAX_RENEW_FAILURES` (default **2**) consecutive failures it sets
  `autoRenewDisabled=true` + raises a CRITICAL `SESSION_EXPIRED` alert; the **scheduled** renew then
  **skips** (won't burn Kite attempts). A **manual** renew bypasses it (dashboard sends
  `{manual:true}`; gateway returns **409** when skipped). Success — or **Save Credentials**
  (`updateCredentials`) / manual token link (`updateToken`) — **re‑arms** the breaker (clears
  `renewFailCount`/`autoRenewDisabled`/`lastError`).
- **Offline validation — spends ZERO Kite attempts:** action `validateTotpSecret {totpSecret?}`
  checks base32 format and generates the current OTP **locally** (never contacts Kite, never logs
  the seed; falls back to the stored seed if none passed). Dashboard Settings has a **"Validate
  Seed (no attempt)"** button that shows the OTP to compare against the authenticator app.
  **Always validate a new seed offline before spending a live attempt.**
- **Manual fixes:** Dashboard → Settings → *Kite Connect Credentials* (Save) + *Test Auto‑Renewal*
  (Renew Now); or the OAuth redirect captures `request_token` → `updateToken`. `getKiteSettings`
  returns masked secrets + all state fields for the UI.

## Gotchas learned the hard way

- **Jest mock `get()` sequence:** `jest.setup.js` shares one chainable Firestore mock;
  `jest.clearAllMocks()` does **not** drain the `mockResolvedValueOnce` queue. If a prior test
  leaves a queued value, it shifts your `get()` order. Reset with `mockFirestore.get.mockReset()`
  + restore the default in tests sensitive to call order.
- **`features.ts` must not write `undefined`** (e.g. `rsScore`): Firestore rejects it and the
  whole EOD FETCH stage fails. Omit optional fields instead.
- **package-lock:** keep it pointed at the public npm registry — a corporate registry mirror in
  the lockfile breaks Cloud Build.
- **Demerged / renamed tickers — don't assume legacy symbols exist.** e.g. **`TATAMOTORS` is dead**
  post‑demerger → now tracked as **`TMPV.NS`** (Passenger Vehicles, keeps original ISIN
  `INE155A01022`) + **`TMCV.NS`** (Commercial Vehicles). A symbol with **zero bars is almost always
  "not in any universe"** (delisted/renamed), NOT a fetch failure — verify universe membership
  before chasing a data bug. Renames are fixed by refreshing the root CSVs + `reseed_universes.js`,
  not by the daily delta.
- **Tail‑gap self‑heal:** a missing *recent* trading day heals automatically on the next EOD/fill
  because the FETCH stage is strict‑delta (`lastBar+1 → runDate`). A hole *behind* newer bars does
  **NOT** self‑heal (strict delta only fetches forward) — force it with `startDeepSync days=N`.
  (NSE holidays are legitimately absent; check `NSE_HOLIDAYS_2026` in `scheduler.ts` before flagging
  a gap — e.g. 2026‑09‑14 Ganesh Chaturthi.)
- **`firebase deploy` hangs with no output:** it's stuck on the interactive Artifact Registry
  cleanup‑policy prompt. Add **`--force`**. (A stuck foreground deploy also blocks the persistent
  terminal — later commands silently queue behind it; run diagnostics in a separate shell.)
- **`jest.setup.js` must mock `admin.firestore.FieldValue`** (`delete`/`increment`/
  `serverTimestamp`/`arrayUnion`/`arrayRemove`) — code using `FieldValue.delete()` throws in tests
  otherwise (silently turned an `updateToken` 200 into a 500).

## Auth for REST/admin scripts

Firestore/Scheduler REST calls use an OAuth access token minted from the **local** Firebase CLI
credentials in `~/.config/configstore/firebase-tools.json` (`tokens.refresh_token`) via
`https://oauth2.googleapis.com/token`. **Never commit or log** the client secret, refresh token,
Kite API key/secret, or TOTP seed. Tokens last ~1 hour.

## Agent workflow

Follow [functions/.agent/workflows/regression-first.md](functions/.agent/workflows/regression-first.md):
run `validate-rules` + tests before and after changes; verify rate‑limiting and single‑job rules
after any deploy.
