# Strategies — ProTrade Alpha

The live daily configuration runs **two strategies together**: **SEPA** (equities) and a
**Metals rotation** sleeve (2 ETFs). A legacy 6‑strategy engine remains in `strategy.ts` but is
**dormant** — gated off by `SEPA_CONFIG.SEPA_ONLY` (default ON). All entries are decided at the
close (EOD) and filled at the **next open** during the following evening's EOD `FILL` stage.

Config lives in [functions/src/config/runtime.ts](functions/src/config/runtime.ts)
(`SEPA_CONFIG`, `METALS_CONFIG`); evaluators in
[functions/src/services/strategy.ts](functions/src/services/strategy.ts).

---

## 1. SEPA — `SepaBreakoutEOD` (BUY, equities)

A faithful port of Minervini‑style **trend‑template + relative‑strength leadership**. Hunts the
`nifty200` universe; only the strongest leaders near new highs get bought.

**Index filter (market gate):** Nifty close > its EMA200, EMA200 slope > 0, and regime ≠ `BEAR`.

| Gate | Condition |
|------|-----------|
| Trend template | `close > SMA50 > SMA150 > SMA200` **and** SMA200 rising (slope over last 20 bars) |
| Near 52‑week high | `close ≥ high252 × (1 − 0.15)` — within **15%** of the 52‑week high |
| RS leadership | `rsRank126 ≤ 40` — top‑40 by 126‑day momentum (`RS_TOP`) |
| Feature window | ≥ 260 trailing bars (for SMA150/200, 52w‑high, 200‑slope) |

**Sizing & risk**

- Risk **1.25%** of equity per trade (`RISK_PCT`), initial **hard stop 7%** (`HARD_STOP_PCT`).
- Once up **15%** (`LOCK_AT_PCT`), arm a trailing lock **20%** below the highest close (`TRAIL_PCT`).
- Max **10** concurrent SEPA positions (`MAX_POS`) — the strongest leaders win the slots.
- **Equity‑curve throttle:** no new buys once drawdown‑from‑peak exceeds **6%** (`THROTTLE_HALT_PCT`).

Exits (trend/stop/trail) are managed in `tradeManager.ts`.

---

## 2. Metals rotation — `MetalsRotation` (BUY, ETFs)

A small, self‑contained trend‑follower on the whitelisted metal ETFs **`GOLDBEES`** and
**`SILVERBEES`**. It runs **alongside** SEPA and is deliberately **exempt** from the equity
liquidity/RS/sector gates. Metals bars are stored under `barsD/GOLDBEES` / `barsD/SILVERBEES`
(bare symbols, no `.NS`) and are appended to the daily dispatch regardless of universe.

| Gate | Condition |
|------|-----------|
| Not already held | skip if an open position exists for the ETF |
| Sleeve capacity | hold at most **2** metal ETFs (`MAX_POS`) |
| Trend gate | `close > 200‑SMA` (`SMA_TREND`) |
| Risk‑adjusted momentum | skip‑1‑month 126‑day return ÷ daily‑return volatility **> 0** (`MOM_LOOKBACK=126`, `MOM_SKIP=21`, `MIN_RA_MOM=0`) |
| Feature window | ≥ 360 trailing bars |

**Sizing & risk**

- Sleeve budget **30%** of equity (`ALLOC_PCT`), split across the 2 slots.
- Wide protective floor **25%** hard stop (`HARD_STOP_PCT`) — the real exit is the trend‑gate break.

> **Honest note (from a blind walk‑forward):** the sleeve is a genuine, drawdown‑aware trend
> edge but earns single‑digit long‑run CAGR and trails gold buy‑and‑hold. The large in‑sample
> result came from the 2024–25 metals regime, not a durable edge. It's kept small on purpose.

---

## Signal → position flow

```
Day D (16:30 IST)  EOD hunt on nifty200 (+ metals): signals → APPROVED → paperOrders/{D} (ACCEPTED)
Day D+1 (16:30)    EOD FILL stage: fills paperOrders/{D} at D+1's OPEN (+ slippage, clamped to [low,high])
                   → position OPEN in portfolio/default/positions
Daily              tradeManager marks P&L, applies trailing/hard stops and trend‑gate exits
```

The fill runs **inside the next EOD** (after that day's bar is fetched), not at a pre‑open 09:15
job — see [CONTEXT.md](CONTEXT.md).

---

## Legacy engine (dormant)

With `SEPA_ONLY=0`, `strategy.ts` instead runs the older six‑strategy, regime‑gated engine
(`PullbackEOD`, `BreakoutCloseEOD`, `MeanReversionEOD`, `ShortBounceEOD`, `BearBounceEOD`,
`RSLeaderEOD`) behind a 13‑gate risk pipeline. It is **not** used in production and is retained
only for research/backtests. Its detailed gate specification lives in the git history of this
file (pre‑SEPA revisions) and in [blueprint.md](blueprint.md).
