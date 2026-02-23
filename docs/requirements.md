# Crypto Market Gateway — Requirements (v1)

Last updated: 2026-02-23  
Owner: Jeff  
Goal: **Get low-noise Telegram DMs** that tell you *when it’s worth looking*, plus a **lightweight recommendation + key levels** so you can decide fast.

---

## 0) What we are building (one sentence)

A Vercel-hosted API that pulls OKX perps data, computes short-horizon deltas (5m/15m/30m/1h/4h), stores minimal state in Upstash, and **sends Telegram DMs only when alert criteria are hit** (or when manually forced).

---

## 1) Primary user workflow (hybrid)

### A) Automatic (low-noise)
- System checks markets on a cadence (e.g., every 5 minutes via Vercel Cron hitting `/api/alert`).
- **Only sends a DM** when at least one per-symbol trigger fires (and cooldown allows it).

### B) Manual (always allowed)
- You click one link and get:
  - A Telegram DM snapshot (even if no triggers)
  - A drilldown URL to `/api/multi`
- This is used for “give me a read right now, I’ll paste it back and we talk trades.”

**Manual endpoint behavior**
- `/api/alert?force=1` always sends DM (bypasses criteria + cooldown).

---

## 2) Recommendation feature (FIRST-CLASS)

Every DM section for a symbol must include:

### 2.1 Bias (long/short/neutral)
- Derived primarily from **15m lean** (fallback to driver lean).
- Displayed as: `bias=long|short|neutral`

### 2.2 “What to watch” line (actionable)
- A short sentence that references levels (below), such as:
  - **If bias=short:** “Breakdown < 1h low = continuation; reclaim > 1h mid = fade risk”
  - **If bias=long:** “Breakout > 1h high = continuation; lose < 1h mid = fade risk”

### 2.3 Key levels (computed from stored 5m series)
- Provide at least:
  - **1h high / low / mid**
  - **4h high / low / mid** (if available; otherwise mark warmup)
- Source: Upstash stored 5m price points (written by `/api/multi`).

> Note: This is not “financial advice.” It’s a structured read + levels to reduce decision time.

---

## 3) Alert Criteria v1 (what triggers an automatic Telegram DM)

Per symbol, DM triggers if **ANY** of the following is true:

### (1) Setup flip (most important)
Trigger when the **15m state** changes vs last check.  
Example: `shorts opening → longs opening`, `longs closing → shorts closing`, etc.

### (2) Momentum confirmation
Trigger when:
- `5m lean == 15m lean`
- AND `abs(5m price_change_pct) >= 0.10%`

### (3) Positioning shock
Trigger when:
- `15m oi_change_pct >= +0.50%`
- AND `abs(15m price_change_pct) >= 0.20%`

### (4) Manual override
- `force=1` always sends.

---

## 4) Anti-spam (mandatory)

### Cooldown rule
- Per symbol: **cooldown 20 minutes** (configurable) unless `force=1`.

### Intended outcome
- If criteria hit every 5 minutes, you still get **at most 1 DM per symbol per 20 minutes**.

---

## 5) Endpoints (contract)

### 5.1 `/api/multi`
Purpose:
- Fetch OKX perps snapshot for `symbols`
- Maintain a rolling 5m series in Upstash (used for deltas + levels)

Inputs (query params):
- `symbols=BTCUSDT,ETHUSDT,...` (optional; fallback to env default; then fallback list)
- `driver_tf=5m|15m|30m|1h|4h` (default `5m`)
- `debug=1` optional (includes debug fields)

Output (high-level):
- `ok`, `ts`, `symbols`, `driver_tf`
- `results[]` with:
  - `symbol`, `instId`, `price`, `funding_rate`, `open_interest_*`
  - `deltas` for `5m/15m/30m/1h/4h`
  - each delta includes `price_change_pct`, `oi_change_pct`, `funding_change`, `state`, `lean`, `why`

Storage behavior:
- Writes 5m points to Upstash series per instrument id (e.g., list key `series5m:{instId}`).

---

### 5.2 `/api/alert`
Purpose:
- Call `/api/multi`
- Evaluate criteria + cooldown
- Send Telegram DM **only for triggered symbols**
- Include recommendation + levels for each symbol in DM
- Always allow manual forced snapshot

Inputs (query params):
- `symbols=...` optional
- `driver_tf=...` optional
- `force=1` optional (bypass criteria + cooldown, send all symbols)
- `debug=1` optional (adds debug JSON fields to HTTP response)
- `dry=1` optional (**IMPORTANT**)  
  - If present: evaluate logic and return JSON **but do NOT send Telegram** and **do NOT update cooldown**.

Outputs:
- JSON response includes:
  - `ok`
  - `sent: true|false`
  - `multiUrl`
  - `triggered_count`
  - If `debug=1`: include triggered/skipped reasons

Telegram behavior:
- If `force=1`: DM includes **all symbols**
- Else: DM includes **only triggered symbols**
- DM includes:
  - timestamp
  - state/lean + p/oi for 15m and 5m
  - levels (1h/4h)
  - recommendation “watch” line
  - drilldown URL to `/api/multi`

---

## 6) Storage (Upstash) — what we store and why

Per instrument (`instId`), we store:

### 6.1 Rolling series (written by `/api/multi`)
- `series5m:{instId}` → list of points `{ ts, p, oi, fr, ... }`
- Used to compute:
  - deltas (already computed by multi)
  - levels (1h/4h hi/lo/mid)

### 6.2 Alert state (written by `/api/alert`)
- `alert:lastState15m:{instId}` → last seen 15m `state`
  - Used for “setup flip”
- `alert:lastSentAt:{instId}` → epoch ms
  - Used for cooldown

---

## 7) Deployment + operations

### Hosting
- Vercel (serverless functions)

### Env vars (required)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### Env vars (optional)
- `DEFAULT_SYMBOLS` (comma list)
- `ALERT_COOLDOWN_MINUTES` (default 20)

### Scheduler
- Vercel Cron hits `/api/alert` every 5 minutes (or desired cadence).

---

## 8) Architecture issues we must stay aligned on

### 8.1 “Debug should not DM”
- `debug=1` should **only affect the JSON response**, not DM behavior.
- To test without sending DMs, we use: **`dry=1`**.

### 8.2 “Manual click should DM”
- Clicking `/api/alert?...` is expected to DM **only when**:
  - criteria hit OR `force=1`
- If you want “one link always sends,” that is: `/api/alert?force=1`

### 8.3 “We must not accidentally update cooldown during tests”
- Any “test mode” must not write:
  - `lastSentAt`
  - `lastState15m` (optional: ok to write lastState; but safest is don’t write anything in dry mode)

**Decision:** `dry=1` = no DM + no writes.

---

## 9) Acceptance criteria (definition of done)

1) `/api/multi` returns valid data for a symbol list and continues maintaining the rolling 5m series.  
2) `/api/alert`:
   - Sends **no DM** if no triggers and no force
   - Sends **DM** when triggers hit (and not in cooldown)
   - Sends **DM** always when `force=1`
   - Enforces per-symbol cooldown
   - Includes recommendation + levels in DM
3) `dry=1` allows safe testing: no DM and no cooldown writes.
4) All thresholds + cooldown are easy to change via `CFG` + env vars.

---

## 10) Quick links (copy/paste once, then you just click)

- Manual always-send snapshot (BTC example):  
  `/api/alert?symbols=BTCUSDT&force=1`

- Automatic behavior test (no DM, no writes):  
  `/api/alert?symbols=BTCUSDT&debug=1&dry=1`

- Drilldown data (multi):  
  `/api/multi?symbols=BTCUSDT&driver_tf=5m`