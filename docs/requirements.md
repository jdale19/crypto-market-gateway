Crypto Market Gateway — Requirements (v2.6)
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
- Mode-aware bias selection (timeframe depends on mode)
- BTC macro gate (risk-control filter)
- B1 structural proximity (1h “edge” zone)
- Mode-specific entry trigger logic (breakout/sweep/scalp; break/reversal/swing)
- Cooldown + state gating
- Snapshot-sourced data only (for alerts), for rate-limit safety

If entry validity rules are not satisfied now → no DM.

The system does not send “heads up” alerts in automatic mode.
It sends alerts only when the entry condition is active according to the mode rules.

------------------------------------------------------------
1) ARCHITECTURE (FROZEN)

1.1 /api/snapshot — ONLY OKX Caller (data authority)
Purpose:
Populate Upstash with bucket-aligned snapshots so downstream endpoints can run
without hitting OKX.

Responsibilities:
- Fetch OKX perps data (SWAP only)
- Resolve instId via cached instrument map
- Write 5m bucket snapshots:
  snap5m:{instId}:{bucket}
- TTL: 24h (or equivalent retention)

Must:
- Be the ONLY endpoint that calls OKX
- Be safe to run every 5 minutes

Must NOT:
- Send Telegram
- Evaluate alert criteria
- Write alert state (cooldown/lastSent/lastState)

------------------------------------------------------------

1.2 /api/multi — Snapshot Reader + Derivation Engine (data only)
Purpose:
Return a structured multi-symbol view of derived deltas/structure for analysis
and for /api/alert consumption.

Responsibilities:
- In snapshot mode: read current values from Upstash snapshots (NO OKX calls)
- Maintain rolling 5m series:
  series5m:{instId}  (24h window derived from 5m points)
- Compute multi-timeframe deltas derived from the stored 5m series:
  5m, 15m, 30m, 1h, 4h
- Provide driver_tf output and per-tf deltas

Must:
- Support snapshot-only mode via:
  ?source=snapshot OR ?snapshot=1 OR env MULTI_DATA_SOURCE=snapshot
- Update series once per bucket using lastBucket:{instId} gate
- Derive deltas from the 5m series only (no direct OKX usage in snapshot mode)

Must NOT:
- Send Telegram
- Enforce cooldown
- Evaluate alert criteria
- Write alert state (except maintaining series + lastBucket)

Alert pipeline MUST call:
  /api/multi?...&source=snapshot

------------------------------------------------------------

1.3 /api/alert — ONLY Telegram Sender (state + delivery)
Purpose:
Evaluate entry validity and send Telegram DMs only when actionable.

Responsibilities:
- Authenticate requests (ALERT_SECRET via bearer or query key)
- Call /api/multi in snapshot mode
- Apply detection filters (mode-aware)
- Apply macro risk gate
- Apply warmup gate (structure availability)
- Apply entry validity rules (mode-specific)
- Enforce cooldown
- Write alert state (lastSentAt, lastState)
- Write heartbeat (run visibility)
- Send Telegram DM

Only this endpoint may send Telegram.

------------------------------------------------------------
2) SCHEDULING CONTRACT (QStash)

Job A — Snapshot Writer
URL:
  /api/snapshot?symbols=...
Cron:
  */5 * * * *
Goal:
  Keep snapshot keys fresh for the current 5m bucket.

Job B — Alert Evaluator
URL:
  /api/alert?key=...&driver_tf=5m
Cron:
  1-59/5 * * * *
Goal:
  Run alert evaluation shortly after snapshots update.

------------------------------------------------------------
4) USER CONFIGURABLE DEFAULTS

Supported query parameters:
- mode=scalp|swing|build
- risk_profile=conservative|normal|aggressive
- driver_tf=5m|15m|30m|1h|4h
- force=1
- dry=1
- debug=1
- symbols=...

Precedence:
1) Explicit query param
2) Env defaults

Env defaults:
- DEFAULT_MODE
- DEFAULT_RISK_PROFILE=normal

------------------------------------------------------------
5) MODE CONTRACT (ALIGNED WITH CODE)

Mode determines:
- Which lean drives bias
- Which timeframe drives setup_flip detection
- How strict OI confirmation is
- What constitutes an actionable entry trigger

BIAS SOURCE (CURRENT IMPLEMENTATION):
- scalp → bias uses 5m lean
- swing → bias uses 1h lean
- build → bias uses 4h lean

------------------------------------------------------------
7) STRUCTURE & LEVELS

Required:
- 1h high / low / mid  (12 × 5m points)

Warmup gate:
levels["1h"].warmup must be false for non-force alerts.

------------------------------------------------------------
9) DETECTION LAYER (MODE-AWARE PRE-FILTER)

Purpose:
Determine whether a symbol is worth evaluating for entry validity on this run.
This reduces noise and state churn.

If no detection triggers fire AND force != 1 → symbol is skipped.

9.1 Trigger Types

A) setup_flip
- State changed vs stored last state
- Scalp uses 5m state
- Swing/build uses 15m state

B) momentum_confirm
- abs(5m price_change_pct) ≥ ALERT_MOMENTUM_ABS_5M_PRICE_PCT (default 0.10%)
- NOTE: lean alignment is NOT required (loosened)

C) positioning_shock
- Trigger if EITHER OI shock OR price shock (loosened):
  - OI shock: (5m OR 15m) oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT (default 0.50%)
  - Price shock: abs(5m OR 15m price_change_pct) ≥ ALERT_SHOCK_ABS_15M_PRICE_PCT (default 0.20%)

9.2 State Seeding Rule (IMPORTANT)
Even when a symbol is skipped due to no detection triggers, /api/alert MUST seed/refresh
lastState so that a future setup_flip can fire in quiet regimes:

- If dry != 1 and curState != "unknown":
  write lastState for this mode:
    alert:lastState:{mode}:{instId} = curState
  and for swing/build also mirror legacy:
    alert:lastState15m:{instId} = curState

------------------------------------------------------------
10) MACRO GATE (BTC RISK FILTER)

If enabled, compute BTC “bull expansion” regime using BTC 4h delta:

btcBullExpansion4h = (
  BTC 4h lean == "long" AND
  BTC 4h price_change_pct >= ALERT_MACRO_BTC_4H_PRICE_PCT_MIN (default 2.0) AND
  BTC 4h oi_change_pct    >= ALERT_MACRO_BTC_4H_OI_PCT_MIN    (default 0.5)
)

If ALERT_MACRO_BLOCK_SHORTS_ON_ALTS=1 AND btcBullExpansion4h=true:
- Block short signals on non-BTC symbols (unless force=1)

------------------------------------------------------------
11) B1 STRUCTURAL PROXIMITY (1h EDGE ZONE)

Edge:
edge = ALERT_STRONG_EDGE_PCT_1H × (1h high − 1h low)
Default: 0.15

B1 zone boundaries:
- Near Low (B1 long zone): price ≤ lo + edge
- Near High (B1 short zone): price ≥ hi − edge

Mode usage:
- scalp → B1 REQUIRED (must be in the correct B1 zone before entry trigger evaluation)
- swing/build → B1 is used by REVERSAL entry path (not required for BREAK path)

------------------------------------------------------------
12) ENTRY VALIDITY RULES (ACTIONABLE NOW)

12.1 SCALP (STRICT)

Requirements (non-force):

1) Detection triggers present
2) Warmup passed (1h levels ready)
3) Macro gate passed (or not applicable)
4) B1 strong (must be in correct B1 zone)
5) Entry trigger active (NOW):
   Long:
   - current price > 1h high
     OR
   - sweep below 1h low AND current price reclaimed above 1h low
   Short:
   - current price < 1h low
     OR
   - sweep above 1h high AND current price rejected below 1h high

6) Strict OI confirmation (scalp):
   - 15m oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT

Notes:
- Sweep logic is approximated from the stored 5m series lookback points:
  - use recent min/max from series5m:{instId} over ALERT_SCALP_SWEEP_LOOKBACK_POINTS (default 3)

------------------------------------------------------------
12.2 SWING / BUILD (REALISTIC)

Goal:
Provide “professional trader” entries even on range/chop days.
Two valid entry paths:

A) BREAK (existing)
- Long: current price > 1h high
- Short: current price < 1h low

B) REVERSAL (NEW)
- Requires:
  1) price is in the correct B1 zone (near 1h extreme), AND
  2) small 5m push away from the extreme (micro-confirm)

Reversal micro-confirm threshold:
- ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT (default 0.05%)

Long reversal valid if:
- price ≤ (1h low + edge)
- AND 5m price_change_pct ≥ ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT

Short reversal valid if:
- price ≥ (1h high − edge)
- AND 5m price_change_pct ≤ -ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT

OI context rule (swing/build):
- 15m oi_change_pct must NOT be sharply negative against direction:
  - if 15m oi_change_pct < ALERT_SWING_MIN_OI_PCT (default -0.50%) → no entry

------------------------------------------------------------
13) COOLDOWN

Default:
ALERT_COOLDOWN_MINUTES = 20

Blocks repeat sends for a given instId unless force=1.

State key:
- alert:lastSentAt:{instId}

------------------------------------------------------------
14) DRY MODE

dry=1:
- No Telegram send
- No state writes (lastSentAt / lastState)
- No heartbeat writes

------------------------------------------------------------
15) HEARTBEAT (RUN VISIBILITY)

Unless dry=1, /api/alert writes a heartbeat record every run to Upstash so it’s easy
to prove the scheduler is calling the endpoint even when no alerts are sent.

Key:
- ALERT_HEARTBEAT_KEY (default "alert:lastRun")
TTL:
- ALERT_HEARTBEAT_TTL_SECONDS (default 24h)

Heartbeat includes:
- ok, mode, risk_profile
- sent boolean
- triggered_count
- itemErrors
- a small topSkips sample for debugging

When debug=1, response includes heartbeat_last_run.

------------------------------------------------------------
16) TELEGRAM DELIVERY (MESSAGE CONTRACT)

Send DM only if entry validity is true for ≥1 symbol after all gates.

Message includes:
- header: “⚡️ OKX perps alert (driver_tf)” + flags ([FORCE], [DRY] when applicable)
- ISO timestamp
- for each triggered symbol:
  - symbol + price
  - bias
  - 1h H/L
  - one-line “Entry:” reason (human readable, trader-style)
- drilldown link to /api/multi with:
  - alerted symbols + BTCUSDT

“Matching one-liner” policy:
- Trigger line must read like a trading call, not engineering telemetry.
  Examples:
  - “Entry: bounce at 1h low zone … + 5m turn up …”
  - “Entry: break above 1h high …”

------------------------------------------------------------
18) SYSTEM INVARIANTS

- Only /api/snapshot calls OKX
- /api/alert consumes /api/multi in snapshot mode only
- Binary send contract:
  Entry valid now → DM
  Entry not valid now → silent
- /api/alert is the only Telegram sender

------------------------------------------------------------
20) CONFIGURABLE ENV VARS (CURRENTLY IMPLEMENTED)

Core:
- DEFAULT_MODE
- DEFAULT_RISK_PROFILE
- ALERT_COOLDOWN_MINUTES

Detection:
- ALERT_MOMENTUM_ABS_5M_PRICE_PCT
- ALERT_SHOCK_OI_15M_PCT
- ALERT_SHOCK_ABS_15M_PRICE_PCT

Structure:
- ALERT_STRONG_EDGE_PCT_1H

Swing/build:
- ALERT_SWING_MIN_OI_PCT
- ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT  (NEW in v2.6)

Macro:
- ALERT_MACRO_GATE_ENABLED
- ALERT_MACRO_BTC_SYMBOL
- ALERT_MACRO_BTC_4H_PRICE_PCT_MIN
- ALERT_MACRO_BTC_4H_OI_PCT_MIN
- ALERT_MACRO_BLOCK_SHORTS_ON_ALTS

Heartbeat:
- ALERT_HEARTBEAT_KEY
- ALERT_HEARTBEAT_TTL_SECONDS