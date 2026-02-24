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