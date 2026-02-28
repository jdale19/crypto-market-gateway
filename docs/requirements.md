Crypto Market Gateway — Requirements (v2.7)
Source of Truth: Repository Audit
Date: 2026-02-28

------------------------------------------------------------
1) SYSTEM GOAL

The Crypto Market Gateway sends low-noise Telegram DMs
only when an entry is actionable at the time of evaluation
under the active mode logic.

Binary contract:

• Entry valid now → Send DM
• Entry not valid → No DM

No “heads up” alerts.

------------------------------------------------------------
2) ARCHITECTURE

2.1 /api/snapshot — Data Authority

• Only endpoint that calls OKX
• Writes 5m bucket snapshots:
    snap5m:{instId}:{bucket}
• TTL retention applied
• Safe to run every 5 minutes

Must NOT:
• Send Telegram
• Evaluate alert criteria
• Write alert state

------------------------------------------------------------

2.2 /api/multi — Derivation Engine (Snapshot Reader)

• Must run in snapshot-only mode for alerts
• Reads snapshot data from Upstash
• Maintains rolling:
    series5m:{instId}
• Computes derived deltas:
    5m
    15m
    30m
    1h
    4h
• Computes 1h levels (hi/lo/mid)
• Supports driver_tf override

Must NOT:
• Send Telegram
• Enforce cooldown
• Write alert state

------------------------------------------------------------

2.3 /api/alert — Alert Engine (Only Telegram Sender)

Responsibilities:

• Authenticate via ALERT_SECRET
• Call /api/multi in snapshot mode
• Apply detection filters
• Apply macro gate
• Apply regime adjustments (if enabled)
• Apply entry validity rules
• Enforce cooldown
• Write:
    alert:lastSentAt:{instId}
    alert:lastState:{mode}:{instId}
    alert:lastState15m:{instId} (legacy mirror)
• Write heartbeat
• Send Telegram DM

------------------------------------------------------------
3) SCHEDULING CONTRACT

Snapshot Job:
Cron: */5 * * * *
Endpoint:
    /api/snapshot?symbols=...

Alert Job:
Cron: 1-59/5 * * * *
Endpoint:
    /api/alert?key=...&driver_tf=5m

Alert must always call:
    /api/multi?...&source=snapshot

------------------------------------------------------------
4) MODE SYSTEM

Modes supported:
• scalp
• swing
• build

Mode priority:
SCALP > SWING > BUILD

Mode resolution precedence:
1) query ?mode=
2) DEFAULT_MODES (comma list)
3) DEFAULT_MODE
4) fallback "scalp"

------------------------------------------------------------
5) BIAS SOURCE BY MODE

scalp → 5m lean
swing → 1h lean
build → 4h lean

------------------------------------------------------------
6) STRUCTURE REQUIREMENT

1h levels required:
• hi
• lo
• mid

Warmup gate:
If 1h levels not ready → no alert (unless force=1)

------------------------------------------------------------
7) DETECTION LAYER (PRE-FILTER)

Triggers:

A) setup_flip
    State changed vs lastState

B) momentum_confirm
    abs(5m price_change_pct) >= ALERT_MOMENTUM_ABS_5M_PRICE_PCT

C) positioning_shock
    OI shock OR price shock (5m or 15m)

If no triggers AND force != 1 → skip symbol

State seeding:
Even when skipped, lastState must be updated.

------------------------------------------------------------
8) MACRO GATE

If enabled:

Compute BTC 4h bull expansion:

BTC 4h lean == long
AND price_change_pct >= ALERT_MACRO_BTC_4H_PRICE_PCT_MIN
AND oi_change_pct >= ALERT_MACRO_BTC_4H_OI_PCT_MIN

If true AND ALERT_MACRO_BLOCK_SHORTS_ON_ALTS=1:
Block short signals on alts.

------------------------------------------------------------
9) B1 STRUCTURAL PROXIMITY

edge = ALERT_STRONG_EDGE_PCT_1H × (1h high − 1h low)

Long B1 zone:
price ≤ lo + edge

Short B1 zone:
price ≥ hi − edge

Usage:
scalp → B1 required
swing/build → required only for reversal path

------------------------------------------------------------
10) ENTRY RULES

10.1 SCALP (STRICT)

Requires:

• Detection trigger
• 1h warmup passed
• Macro gate passed
• B1 zone valid
• Entry trigger active:
    Long:
        price > 1h high
        OR sweep below 1h low and reclaim
    Short:
        price < 1h low
        OR sweep above 1h high and reject
• Strict OI confirmation:
    15m oi_change_pct >= ALERT_SHOCK_OI_15M_PCT

------------------------------------------------------------

10.2 SWING / BUILD

Two paths:

A) BREAK
    Long: price > 1h high
    Short: price < 1h low

B) REVERSAL
    Must be in B1 zone
    AND 5m move away from extreme >= ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT

OI context rule:
If 15m oi_change_pct < ALERT_SWING_MIN_OI_PCT → block entry

------------------------------------------------------------
11) LEVERAGE MODEL (ADVISORY ONLY)

Enabled via ALERT_LEVERAGE_ENABLED.

Per-mode risk budget:
• ALERT_LEVERAGE_RISK_BUDGET_PCT_SCALP
• ALERT_LEVERAGE_RISK_BUDGET_PCT_SWING
• ALERT_LEVERAGE_RISK_BUDGET_PCT_BUILD

Base leverage:
riskBudgetPct / structureDistancePct

Adjusted down if:
• OI volatility exceeds thresholds
• Funding exceeds thresholds

Hard cap:
ALERT_LEVERAGE_MAX_CAP

This does NOT affect gating.
It only affects DM text.

------------------------------------------------------------
12) REGIME ADJUST (OPTIONAL)

If ALERT_REGIME_ENABLED=1:

Expansion regime:
    Upgrade strength thresholds.

Contraction regime:
    Allow B1 upgrade multiplier:
        ALERT_REGIME_CONTRACTION_UPGRADE_EDGE_MULT

Regime does not override entry validity.
It modifies structural strength behavior only.

------------------------------------------------------------
13) COOLDOWN

ALERT_COOLDOWN_MINUTES

Key:
alert:lastSentAt:{instId}

Blocks repeat sends unless force=1.

------------------------------------------------------------
14) HEARTBEAT

Key:
ALERT_HEARTBEAT_KEY
TTL:
ALERT_HEARTBEAT_TTL_SECONDS

Written on every run unless dry=1.

------------------------------------------------------------
15) ENV VARIABLES (FULL LIST FROM CODE)

Core:
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
ALERT_SECRET
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID

Defaults:
DEFAULT_SYMBOLS
DEFAULT_MODE
DEFAULT_MODES
DEFAULT_RISK_PROFILE

Detection:
ALERT_MOMENTUM_ABS_5M_PRICE_PCT
ALERT_SHOCK_OI_15M_PCT
ALERT_SHOCK_ABS_15M_PRICE_PCT

Structure:
ALERT_STRONG_EDGE_PCT_1H
ALERT_SCALP_SWEEP_LOOKBACK_POINTS
ALERT_SWING_MIN_OI_PCT
ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT

Macro:
ALERT_MACRO_GATE_ENABLED
ALERT_MACRO_BTC_SYMBOL
ALERT_MACRO_BTC_4H_PRICE_PCT_MIN
ALERT_MACRO_BTC_4H_OI_PCT_MIN
ALERT_MACRO_BLOCK_SHORTS_ON_ALTS

Regime:
ALERT_REGIME_ENABLED
ALERT_REGIME_EXPANSION_4H_PRICE_PCT_MIN
ALERT_REGIME_EXPANSION_4H_OI_PCT_MIN
ALERT_REGIME_CONTRACTION_4H_ABS_PRICE_PCT_MAX
ALERT_REGIME_CONTRACTION_OI_4H_PCT_MAX
ALERT_REGIME_CONTRACTION_UPGRADE_ENABLED
ALERT_REGIME_CONTRACTION_UPGRADE_EDGE_MULT

Leverage:
ALERT_LEVERAGE_ENABLED
ALERT_LEVERAGE_RISK_BUDGET_PCT_SCALP
ALERT_LEVERAGE_RISK_BUDGET_PCT_SWING
ALERT_LEVERAGE_RISK_BUDGET_PCT_BUILD
ALERT_LEVERAGE_MAX_CAP
ALERT_LEVERAGE_OI_REDUCE1
ALERT_LEVERAGE_OI_REDUCE2
ALERT_LEVERAGE_FUNDING_REDUCE1
ALERT_LEVERAGE_FUNDING_REDUCE2

Snapshot/Multi:
MULTI_DATA_SOURCE
SNAPSHOT_KEY_PREFIX
SNAPSHOT_SYMBOL_FALLBACK_PREFIX
SERIES_TTL_MINUTES
DEFAULT_TFS

------------------------------------------------------------
END OF DOCUMENT