Crypto Market Gateway — Requirements (v2.5)
Last updated: 2026-02-27
Owner: jdale19

------------------------------------------------------------
SYSTEM GOAL (MODE-AWARE, STATE-BASED)

The Crypto Market Gateway sends low-noise Telegram DMs only when an entry is
currently actionable under the active user-specified mode and risk profile.

“Actionable” is defined by deterministic, mode-specific entry validity rules
evaluated at the time of the alert run using:

- Structure derived from stored 5m series (1h levels required)
- Participation (OI) used as confirmation or context (mode-dependent)
- Mode-aware bias selection
- BTC macro gate (risk-control filter)
- Edge filter near structural extremes (B1 / 1h edge rule)
- Mode-specific entry trigger logic
- Cooldown + state gating
- Snapshot-sourced data only (for alerts)

If entry validity rules are not satisfied now → no DM.

The system does not send informational or “heads up” alerts.
Binary contract: actionable now → DM, otherwise silent.

------------------------------------------------------------
1) ARCHITECTURE (FROZEN)

1.1 /api/snapshot — ONLY OKX Caller
- Fetches OKX perps data (SWAP only)
- Writes 5m bucket snapshots
- TTL: 24h
- Safe to run every 5 minutes
- Must NOT send Telegram
- Must NOT evaluate alert logic

1.2 /api/multi — Snapshot Reader + Derivation
- Reads snapshot-only data (no OKX calls)
- Maintains rolling 5m series (series5m:{instId})
- Derives 5m / 15m / 30m / 1h / 4h deltas
- Must NOT send Telegram
- Must NOT evaluate alert criteria

1.3 /api/alert — ONLY Telegram Sender
- Authenticates
- Calls /api/multi in snapshot mode
- Applies detection gate
- Applies macro gate
- Applies warmup gate
- Applies B1 edge filter
- Applies mode-specific entry validity
- Enforces cooldown
- Writes alert state
- Writes heartbeat
- Sends Telegram

------------------------------------------------------------
2) SCHEDULING

Snapshot:
  */5 * * * *

Alert:
  1-59/5 * * * *

Alert always consumes snapshot data only.

------------------------------------------------------------
4) USER CONFIGURABLE DEFAULTS

Query params:
- mode=scalp|swing|build
- risk_profile=conservative|normal|aggressive
- driver_tf
- force=1
- dry=1
- debug=1

Precedence:
1) Query param
2) Env default

Env:
- DEFAULT_MODE
- DEFAULT_RISK_PROFILE=normal

------------------------------------------------------------
5) MODE CONTRACT (CURRENT IMPLEMENTATION)

Bias source:
- scalp → 5m lean
- swing → 1h lean
- build → 4h lean

Detection state flip timeframe:
- scalp → 5m state
- swing/build → 15m state

------------------------------------------------------------
7) STRUCTURE & LEVELS

Derived from stored 5m series.

Required:
- 1h high / low / mid (12 × 5m points)

Warmup:
levels["1h"].warmup must be false unless force=1.

------------------------------------------------------------
9) DETECTION LAYER (OPENED APERTURE — CURRENT CODE)

Purpose:
Determine whether a symbol proceeds to full entry evaluation.

Detection triggers (ANY may fire):

A) setup_flip
- State changed vs stored lastState
  - scalp → 5m state
  - swing/build → 15m state

B) momentum_confirm
- abs(5m price_change_pct) ≥ ALERT_MOMENTUM_ABS_5M_PRICE_PCT
- No lean alignment requirement

C) positioning_shock
- Triggered if EITHER of the following is true:
    - 5m oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT
    OR
    - abs(5m price_change_pct) ≥ ALERT_SHOCK_ABS_15M_PRICE_PCT
    OR
    - 15m oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT
    OR
    - abs(15m price_change_pct) ≥ ALERT_SHOCK_ABS_15M_PRICE_PCT

Shock logic uses OR, not AND.

If no detection triggers fire and force != 1 → symbol skipped.

------------------------------------------------------------
11) EDGE FILTER (B1)

edge = ALERT_STRONG_EDGE_PCT_1H × (1h high − 1h low)

Default: 0.15

Long strong if:
price ≤ lo + edge

Short strong if:
price ≥ hi − edge

Mode rules:
- scalp → B1 required
- swing/build → may bypass if structural break active

------------------------------------------------------------
12) ENTRY VALIDITY RULES

12.1 SCALP

Requirements (non-force):

1) Detection triggered
2) Warmup passed
3) Macro gate passed
4) B1 edge strong
5) Entry trigger active:

   Long:
   - price > 1h high
     OR
   - sweep below 1h low AND reclaimed above 1h low

   Short:
   - price < 1h low
     OR
   - sweep above 1h high AND rejected below 1h high

6) Strict OI confirmation:
   - 15m oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT

------------------------------------------------------------
12.2 SWING

Requirements:

1) Detection triggered
2) Warmup passed
3) Macro gate passed
4) Entry trigger active:
   - Long: price > 1h high
   - Short: price < 1h low
5) OI context rule:
   - 15m oi_change_pct ≥ ALERT_SWING_MIN_OI_PCT (default -0.50%)

B1 not required if structural break active.

------------------------------------------------------------
13) TELEGRAM DELIVERY

DM only if ≥1 symbol passes full entry validity.

Include:
- symbol
- price
- bias
- 1h H/L
- trigger line
- drilldown link (alerted symbols + BTC)

------------------------------------------------------------
15) COOLDOWN

ALERT_COOLDOWN_MINUTES = 20

Blocks repeat sends unless force=1.

------------------------------------------------------------
16) DRY MODE

dry=1:
- No Telegram
- No state writes
- No heartbeat writes

------------------------------------------------------------
17) HEARTBEAT

/api/alert writes heartbeat each run unless dry=1.

------------------------------------------------------------
18) SYSTEM INVARIANTS

- Only /api/snapshot calls OKX
- /api/alert uses snapshot-only data
- Deterministic 5m cadence
- Binary send contract

------------------------------------------------------------
20) CONFIGURABLE ENV VARS

- ALERT_MOMENTUM_ABS_5M_PRICE_PCT
- ALERT_SHOCK_OI_15M_PCT
- ALERT_SHOCK_ABS_15M_PRICE_PCT
- ALERT_STRONG_EDGE_PCT_1H
- ALERT_SWING_MIN_OI_PCT
- ALERT_MACRO_* thresholds
- ALERT_COOLDOWN_MINUTES
- DEFAULT_MODE
- DEFAULT_RISK_PROFILE