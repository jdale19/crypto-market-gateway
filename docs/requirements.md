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
- Mode-aware bias selection (timeframe depends on mode)
- BTC macro gate (risk-control filter)
- Edge filter near structural extremes (B1 / 1h edge rule)
- Mode-specific entry trigger logic
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
- TTL: 24h

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

Must NOT:
- Send Telegram
- Enforce cooldown
- Evaluate alert criteria
- Write alert state

Alert pipeline MUST call:
  /api/multi?...&source=snapshot

------------------------------------------------------------

1.3 /api/alert — ONLY Telegram Sender (state + delivery)
Purpose:
Evaluate entry validity and send Telegram DMs only when actionable.

Responsibilities:
- Authenticate requests
- Call /api/multi in snapshot mode
- Apply detection filters (mode-aware)
- Apply macro risk gate
- Apply warmup gate (structure availability)
- Apply edge filter (B1 / 1h edge)
- Apply mode-specific entry validity rules
- Enforce cooldown
- Write alert state
- Write heartbeat
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

Precedence:
1) Explicit query param
2) Env defaults

Env defaults:
- DEFAULT_MODE (current production may override)
- DEFAULT_RISK_PROFILE=normal

------------------------------------------------------------
5) MODE CONTRACT (ALIGNED WITH CODE)

Mode determines:
- Which lean drives bias
- Which timeframe drives detection
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
Determine whether a symbol is worth evaluating for entry validity.

9.1 Scalp Detection (5m-native)

A) setup_flip
- 5m state changed vs stored last state

B) momentum_confirm
- abs(5m price_change_pct) ≥ ALERT_MOMENTUM_ABS_5M_PRICE_PCT (default 0.10%)

C) positioning_shock
- 5m oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT (default 0.50%)
- abs(5m price_change_pct) ≥ ALERT_SHOCK_ABS_15M_PRICE_PCT (default 0.20%)

9.2 Swing/Build Detection (15m-based)

A) setup_flip
- 15m state changed vs stored last state

B) momentum_confirm
- 5m lean == 15m lean
- abs(5m price_change_pct) ≥ ALERT_MOMENTUM_ABS_5M_PRICE_PCT

C) positioning_shock
- 15m oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT
- abs(15m price_change_pct) ≥ ALERT_SHOCK_ABS_15M_PRICE_PCT

If no detection triggers fire and force != 1 → symbol skipped.

------------------------------------------------------------
11) EDGE FILTER (B1) — 1h STRUCTURAL PROXIMITY

Edge:
edge = ALERT_STRONG_EDGE_PCT_1H × (1h high − 1h low)
Default: 0.15

Long valid if:
price ≤ lo + edge

Short valid if:
price ≥ hi − edge

Mode requirements:
- scalp → REQUIRED
- swing/build → optional if structural break active

------------------------------------------------------------
12) ENTRY VALIDITY RULES

12.1 SCALP

Requirements (non-force):

1) Scalp detection triggers present
2) Warmup passed
3) Macro gate passed
4) Edge filter strong
5) Entry trigger active:

   Long:
   - current price > 1h high
     OR
   - sweep below 1h low AND current price reclaimed above 1h low

   Short:
   - current price < 1h low
     OR
   - sweep above 1h high AND current price rejected below 1h high

6) Strict OI confirmation:
   - 15m oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT

------------------------------------------------------------
12.2 SWING

Requirements:

1) Swing detection triggers present
2) Warmup passed
3) Macro gate passed
4) Entry trigger active:
   - Long: price > 1h high
   - Short: price < 1h low
5) OI context:
   - 15m oi_change_pct ≥ ALERT_SWING_MIN_OI_PCT (default -0.50%)

------------------------------------------------------------
13) TELEGRAM DELIVERY

Send DM only if entry validity true for ≥1 symbol after all gates.

Include:
- symbol
- price
- bias
- 1h H/L
- trigger line
- drilldown link (alerted symbols + BTC)

------------------------------------------------------------
15) COOLDOWN

Default:
ALERT_COOLDOWN_MINUTES = 20

Blocks repeat sends unless force=1.

------------------------------------------------------------
16) DRY MODE

dry=1:
- No Telegram send
- No state writes
- No heartbeat writes

------------------------------------------------------------
17) HEARTBEAT

/api/alert writes heartbeat record each run (unless dry=1).

------------------------------------------------------------
18) SYSTEM INVARIANTS

- Only /api/snapshot calls OKX
- /api/alert consumes snapshot mode only
- Binary send contract:
  Entry valid now → DM
  Entry not valid now → silent

------------------------------------------------------------
20) CONFIGURABLE ENV VARS (CURRENTLY IMPLEMENTED)

- ALERT_MOMENTUM_ABS_5M_PRICE_PCT
- ALERT_SHOCK_OI_15M_PCT
- ALERT_SHOCK_ABS_15M_PRICE_PCT
- ALERT_STRONG_EDGE_PCT_1H
- ALERT_SWING_MIN_OI_PCT
- ALERT_MACRO_* thresholds
- ALERT_COOLDOWN_MINUTES
- DEFAULT_MODE
- DEFAULT_RISK_PROFILE