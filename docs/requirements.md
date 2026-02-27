Crypto Market Gateway — Requirements (v2.4)
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
- Provide debug counters proving snapshot vs OKX usage

Must NOT:
- Send Telegram
- Enforce cooldown
- Evaluate alert criteria
- Write alert state (cooldown/lastSent/lastState)

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
- Write heartbeat (job observability)
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
  Run alert evaluation shortly after snapshots update, within the same bucket cycle.

Design guarantee:
- Snapshot runs before alert inside each 5m UTC bucket.
- /api/alert consumes snapshot-only data.
- /api/alert never calls OKX.

------------------------------------------------------------
3) RATE-LIMIT & DATA SOURCE GUARANTEE

Steady state:
- /api/snapshot  → calls OKX
- /api/multi     → reads Upstash only (snapshot mode)
- /api/alert     → reads snapshot mode only

OKX calls per 5m cycle = one snapshot batch (per configured symbols).
Alerting cannot increase OKX call volume.

------------------------------------------------------------
4) USER CONFIGURABLE DEFAULTS (PUBLIC CONTRACT)

Supported query parameters:
- mode=scalp|swing|build
- risk_profile=conservative|normal|aggressive
- driver_tf=5m|15m|30m|1h|4h
- force=1          (override detection + cooldown; see section 9)
- dry=1            (no Telegram + no state writes; see section 16)
- debug=1          (include debug payloads, heartbeat visibility)

Precedence:
1) Explicit query param
2) Env defaults

Env defaults:
- DEFAULT_MODE=scalp
- DEFAULT_RISK_PROFILE=normal

------------------------------------------------------------
5) MODE CONTRACT (AS INTENDED)

Mode determines:
- Which lean drives bias
- Which timeframe drives detection (pre-filter)
- How strict OI is
- What constitutes an actionable entry trigger

Supported modes:
- scalp
- swing
- build

BIAS SOURCE (UPDATED SPEC):
- scalp → bias uses 15m lean (fast intent, but not tick-level)
- swing → bias uses 1h lean (fallback 4h → 15m)
- build → bias uses 4h lean (fallback 1h → 15m)

PRECISION NOTE:
Modes are evaluated on a 5-minute cadence using snapshot-derived data.
“Scalp” here means “structural scalp under cadence,” not 1-minute/tick execution.

------------------------------------------------------------
6) RISK PROFILE CONTRACT (CURRENT STATE)

Purpose:
Allow future threshold tuning without changing endpoint contracts.

Current implementation status:
- risk_profile accepted and surfaced in /api/alert debug output
- risk_profile does not change thresholds unless explicitly configured via env rules

Invariants risk_profile never bypasses:
- Macro gate
- Warmup gate
- Entry validity requirement
- Binary “send vs silent” contract

------------------------------------------------------------
7) STRUCTURE & LEVELS (1h REQUIRED)

Purpose:
Anchor alerts to structure so entry validity is not just momentum noise.

Levels derived from stored 5m series:
Required:
- 1h high / low / mid  (needs 12 x 5m points)

Optional:
- 4h high / low / mid (if warm)

Rounding:
- ≥1000 → 2 decimals
- 1–999 → 3 decimals
- <1 → 4 decimals

All trigger lines must print numeric values explicitly.

------------------------------------------------------------
8) WARMUP GATE (STRUCTURE AVAILABILITY)

Purpose:
Prevent alerts before enough structural history exists.

Rule:
Non-force alerts require:
levels["1h"].warmup == false

------------------------------------------------------------
9) DETECTION LAYER (MODE-AWARE PRE-FILTERS)

Purpose:
Avoid evaluating entry validity on every symbol every run unless there is a setup worth checking.

Detection triggers are NOT the same as entry triggers.
Detection answers: “is it worth checking this symbol right now?”
Entry validity answers: “is the entry active right now?”

9.1 Scalp Detection (5m-native)
A) setup_flip_5m
- 5m state changed vs stored last 5m state

B) momentum_5m
- abs(5m price_change_pct) ≥ ALERT_SCALP_MOMENTUM_ABS_5M_PRICE_PCT (default 0.10%)

C) positioning_shock_5m
- 5m oi_change_pct ≥ ALERT_SCALP_SHOCK_OI_5M_PCT (default: configurable)
- abs(5m price_change_pct) ≥ ALERT_SCALP_SHOCK_ABS_5M_PRICE_PCT (default: configurable)

9.2 Swing/Build Detection (15m-based)
A) setup_flip_15m
- 15m state changed vs stored last 15m state

B) momentum_confirm
- 5m lean == 15m lean
- abs(5m price_change_pct) ≥ ALERT_MOMENTUM_ABS_5M_PRICE_PCT (default 0.10%)

C) positioning_shock_15m
- 15m oi_change_pct ≥ ALERT_SHOCK_OI_15M_PCT (default 0.50%)
- abs(15m price_change_pct) ≥ ALERT_SHOCK_ABS_15M_PRICE_PCT (default 0.20%)

9.3 force=1 (query parameter)
- Overrides detection gating and cooldown gating
- Still respects authentication
- Still respects dry mode behavior
- Macro/warmup behavior remains as implemented unless explicitly coded to bypass

If no detection triggers are true and force!=1 → symbol is skipped (silent).

------------------------------------------------------------
10) BTC MACRO GATE (RISK CONTROL)

Purpose:
Reduce low-quality fade alerts on alts during strong BTC-led expansion.

Definition: BTC Bull Expansion 4H
BTC is considered in bull expansion if:
- BTC 4h lean == long
- BTC 4h price_change_pct ≥ ALERT_MACRO_BTC_4H_PRICE_PCT_MIN (default 2.0)
- BTC 4h oi_change_pct ≥ ALERT_MACRO_BTC_4H_OI_PCT_MIN (default 0.5)

Behavior:
- If BTC bull expansion is true and ALERT_MACRO_BLOCK_SHORTS_ON_ALTS=1,
  then block SHORT bias alerts on non-BTC symbols.

Inverse macro behavior (blocking longs during BTC bear expansion) is not part of this spec
unless explicitly implemented.

------------------------------------------------------------
11) EDGE FILTER (B1) — 1h STRUCTURAL PROXIMITY

Purpose:
Prefer entries near structural extremes rather than mid-range chop.

Definition:
hi = 1h high
lo = 1h low
range = hi - lo
edge = ALERT_STRONG_EDGE_PCT_1H × range
Default: ALERT_STRONG_EDGE_PCT_1H = 0.15

Edge condition:
- Long edge valid if price ≤ lo + edge
- Short edge valid if price ≥ hi - edge

Mode requirements:
- scalp: edge filter REQUIRED (reco must be strong)
- swing/build: edge filter evaluated but entry may still be valid via structural break logic

“B1” meaning:
Primary structural edge filter on the 1h range.

------------------------------------------------------------
12) ENTRY VALIDITY RULES (MODE-SPECIFIC)

Terminology:
Use “entry validity” or “entry trigger active” (not “execution”).

12.1 SCALP — Strict Entry Validity (structural scalp under 5m cadence)
Purpose:
Only alert when the market is actively breaking structure AND participation confirms.

Requirements (non-force):
1) Scalp detection triggers present (section 9.1)
2) Warmup passed (section 8)
3) Macro gate passed (section 10)
4) Edge filter strong (section 11)
5) Entry trigger active (approximated using current snapshot price):
   Long:
   - current price > 1h high
     OR
   - sweep below 1h low AND current price reclaimed above 1h low
   Short:
   - current price < 1h low
     OR
   - sweep above 1h high AND current price rejected back below 1h high
6) Strict OI confirmation (5m-native for scalp):
   5m oi_change_pct ≥ ALERT_SCALP_STRICT_OI_5M_PCT (default: configurable)

Precision note:
This is 5m-cadence scalp. True 1-minute scalp requires architectural changes.

12.2 SWING — Entry Validity (1h bias)
Purpose:
Alert on meaningful structure breaks with less reliance on OI spikes.

Requirements (non-force):
1) Swing detection triggers present (section 9.2)
2) Warmup passed
3) Macro gate passed
4) Entry trigger active:
   - Long: current price > 1h high
   - Short: current price < 1h low
5) Edge filter OR structural break:
   - Structural break is the active entry trigger itself (beyond 1h high/low)
6) OI context (not spike):
   - Must not be sharply negative against direction
   - Codified as: 15m oi_change_pct ≥ ALERT_SWING_MIN_OI_PCT (default -0.50%)

12.3 BUILD — Entry Validity (4h bias)
Purpose:
Alert only when there is an actionable structural condition for positioning. No informational alerts.

Requirements (non-force):
- Build detection triggers present (section 9.2)
- Warmup + macro gates pass
- Must satisfy an actionable structural condition consistent with build intent
- OI used as context, not spike-dependent

------------------------------------------------------------
13) DELIVERY LAYER — TELEGRAM

Purpose:
Telegram is the delivery mechanism for validated entry states.

Rule:
Send DM only when entry validity is true for at least one symbol
after applying all gates + cooldown.

Message must include:
- symbol, price
- bias
- 1h high/low
- entry trigger line with numeric levels
- drilldown link (scoped)

------------------------------------------------------------
14) DRILLDOWN LINK

Purpose:
Provide a one-click context view in /api/multi for only the relevant symbols.

Behavior:
Drilldown includes:
- only alerted symbols
- plus BTCUSDT

------------------------------------------------------------
15) COOLDOWN

Purpose:
Reduce spam during persistent breaks and prevent repeated DMs for the same condition.

Default:
ALERT_COOLDOWN_MINUTES = 20

Behavior:
- Blocks repeat sends for a symbol within cooldown window
- Ignored when force=1

------------------------------------------------------------
16) DRY MODE

Purpose:
Safe testing without sending messages or mutating alert state.

dry=1:
- No Telegram send
- No alert state writes (cooldown, lastSent, lastState)
- No heartbeat writes

------------------------------------------------------------
17) HEARTBEAT

Purpose:
Operational observability — prove scheduler is firing even when no alerts trigger.

Behavior:
- /api/alert writes a heartbeat record to Upstash each run (unless dry=1)
- When debug=1, /api/alert returns heartbeat_last_run

------------------------------------------------------------
18) SYSTEM INVARIANTS

18.1 Single external data authority
Only /api/snapshot may call OKX.

18.2 Deterministic time bucketing
bucket = floor(UTC_timestamp_ms / 300000)

18.3 Write-then-read ordering
Snapshot must run before alert within each bucket.

18.4 Idempotent snapshot writes
Multiple snapshot calls within same bucket are safe.

18.5 Binary send contract
Entry valid now → DM
Entry not valid now → silent

18.6 Redeploy safety
State lives in Upstash, not memory.

------------------------------------------------------------
19) ACCEPTANCE CRITERIA

1) /api/multi never sends Telegram
2) /api/alert is the sole Telegram sender
3) /api/alert calls /api/multi in snapshot mode in production
4) Scalp detection is 5m-native (no 15m dependency)
5) Scalp requires strict OI confirmation (5m)
6) Swing bias uses 1h lean (fallback 4h → 15m)
7) Swing does not require OI spike threshold
8) No informational/WAIT alerts in automatic mode
9) Trigger lines include explicit numeric levels
10) Drilldown scoped to alerted symbols + BTC
11) Cooldown enforced except when force=1
12) OKX calls occur only in /api/snapshot
13) Debug counters prove data source usage

------------------------------------------------------------
20) CONFIGURABILITY

All thresholds are configurable via env vars, including:
- ALERT_MOMENTUM_ABS_5M_PRICE_PCT
- ALERT_SHOCK_OI_15M_PCT
- ALERT_SHOCK_ABS_15M_PRICE_PCT
- ALERT_STRONG_EDGE_PCT_1H
- ALERT_SWING_MIN_OI_PCT
- ALERT_MACRO_* thresholds
- ALERT_COOLDOWN_MINUTES

New (for scalp detection + strict OI):
- ALERT_SCALP_MOMENTUM_ABS_5M_PRICE_PCT
- ALERT_SCALP_SHOCK_OI_5M_PCT
- ALERT_SCALP_SHOCK_ABS_5M_PRICE_PCT
- ALERT_SCALP_STRICT_OI_5M_PCT