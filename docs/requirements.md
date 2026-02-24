Here’s the latest, updated requirements doc that reflects all of the clarifications and locks we just made (including dry=1 read-only behavior, endpoint authority, and acceptance criteria). You can paste this into docs/requirements.md to replace what’s currently there.

⸻


# Crypto Market Gateway — Requirements (v1)

Last updated: 2026-02-23  
Owner: JD
Goal: **Get low-noise Telegram DMs** that tell you *when it’s worth looking*, plus a **lightweight recommendation + key levels** so you can decide fast.

---

## 0) What we are building (one sentence)

A Vercel-hosted API that pulls OKX perps data, computes short-horizon deltas (5m/15m/30m/1h/4h), stores minimal state in Upstash, and **sends Telegram DMs only when alert criteria are hit** (or when manually forced).

---

## 1) Architectural Authority

### 1.1 `/api/multi` — Data Only

`/api/multi`:

- Fetches OKX perps snapshot data
- Computes deltas for multiple time horizons
- Maintains the rolling 5m series in Upstash
- Returns structured JSON

It **MUST NOT**:

- Send Telegram messages
- Evaluate alert criteria
- Enforce cooldown
- Write alert state (`lastSentAt`, `lastState15m`)
- Make alert decisions

**Acceptance test:** calling `/api/multi` under any query parameters must *not* produce a Telegram DM.

---

### 1.2 `/api/alert` — Only Alert Sender

`/api/alert` is the **only endpoint allowed to send Telegram DMs** and to evaluate alert logic.

It is responsible for:

- Calling `/api/multi`
- Evaluating criteria
- Enforcing per-symbol cooldown
- Computing recommendation + levels
- Writing alert state (`lastSentAt`, `lastState15m`)
- Sending Telegram messages

No other route may send Telegram.

---

## 2) Primary user workflow (hybrid)

### A) Automatic (low-noise)

- Vercel Cron hits `/api/alert` on a cadence (e.g., every 5 minutes).
- **DM is sent only when criteria hit and cooldown allows.**

### B) Manual snapshot

- One-click snapshot via:

/api/alert?force=1

- Always sends formatted Telegram DM.
- Bypasses criteria and cooldown.

### Drilldown

- DM includes a link to:

/api/multi?…

- This is raw JSON for inspection and debugging.

---

## 3) Recommendation feature (FIRST-CLASS)

Every DM section for a symbol must include:

### 3.1 Bias
- Derived from 15m lean (fallback to driver lean).
- Displayed as:

bias=long|short|neutral

### 3.2 Actionable watch line
Based on bias and levels. Examples:

- If bias=short:
> Breakdown < 1h low = continuation; reclaim > 1h mid = fade risk
- If bias=long:
> Breakout > 1h high = continuation; lose < 1h mid = fade risk

### 3.3 Key levels
Computed from stored 5m series:

- **1h high / low / mid**
- **4h high / low / mid** (if available; otherwise indicated as warmup)

Source: Upstash `series5m:{instId}`.

---

## 4) Alert Criteria v1

Trigger a DM for a symbol if **any** of the following:

### (1) Setup flip
15m state changed vs last stored state.

### (2) Momentum confirmation
- 5m lean == 15m lean  
- AND abs(5m price_change_pct) ≥ 0.10%

### (3) Positioning shock
- 15m oi_change_pct ≥ +0.50%  
- AND abs(15m price_change_pct) ≥ 0.20%

### (4) Manual override
- `force=1` always sends

---

## 5) Anti-spam

### Cooldown
- Per symbol: **20 minutes** (configurable via env var `ALERT_COOLDOWN_MINUTES`)
- Ignored when `force=1`

Only `/api/alert` may write:

- `alert:lastSentAt:{instId}`

---

## 6) Dry Mode (Testing Contract)

When `dry=1` is present:

- Evaluate criteria
- Return JSON normally
- **Never send Telegram**
- **Never write any state** (no lastSentAt, no lastState15m)

Dry = *pure read-only run*.

---

## 7) Endpoints (contract)

### 7.1 `/api/multi`
Purpose:
- Fetch OKX data
- Compute deltas
- Maintain rolling 5m series

Must not:
- Send Telegram
- Write alert state or cooldown

### 7.2 `/api/alert`
Purpose:
- Call `/api/multi`
- Evaluate criteria
- Enforce cooldown
- Compute recommendation + levels
- Send Telegram

Input query params:
- `symbols=...`
- `driver_tf=...`
- `force=1`
- `debug=1`
- `dry=1`

Output JSON includes:
- `ok`
- `sent: true|false`
- `dry: true|false`
- `multiUrl`
- `triggered_count`

Telegram behavior:
- With `force=1`: include all symbols
- Otherwise: only triggered symbols

---

## 8) Storage (Upstash)

### Rolling series
Key: `series5m:{instId}`  
Used for deltas + levels

### Alert state
Keys:
- `alert:lastState15m:{instId}`
- `alert:lastSentAt:{instId}`

Only non-dry `/api/alert` may write these.

---

## 9) Acceptance criteria (definition of done)

System is correct when:

1. `/api/multi` never sends Telegram DMs.
2. `/api/alert` is the only sender.
3. `/api/alert` sends DM only when:
 - criteria met and not in cooldown, or
 - `force=1`
4. `dry=1` triggers no Telegram and no writes.
5. `debug=1` does not affect DM behavior.
6. Recommendation and levels always present in DM.
7. All thresholds/cooldown configurable via `CFG` + env vars.

---

## 10) Quick links

- Manual forced snapshot:  

/api/alert?symbols=BTCUSDT&force=1

- Safe test mode:  

/api/alert?symbols=BTCUSDT&debug=1&dry=1

- Drilldown raw data:  

/api/multi?symbols=BTCUSDT&driver_tf=5m




⸻

If you’d like, I can also generate the next doc — architecture.md — describing internal flows, Upstash schema, keys, sequence diagrams, and integration points in detail.