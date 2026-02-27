Crypto Market Gateway — Requirements (v2.2)
Last updated: 2026-02-27
Owner: jdale19

------------------------------------------------------------
SYSTEM GOAL

The Crypto Market Gateway sends low-noise Telegram DMs only when a trade is
currently executable under the strict, mode-specific execution rules defined
by the system.

Execution validity is determined at evaluation time using:

- Structural levels derived from 5m series (1h required)
- Positioning confirmation (OI context or spike depending on mode)
- Mode-aware bias logic
- Macro regime gating
- B1 structural edge rules
- Mode-specific execution triggers
- Risk-profile-adjusted thresholds
- Cooldown enforcement

A trade is considered executable only if ALL required conditions for the
active mode evaluate true at the current snapshot.

If execution conditions are not satisfied → no DM is sent.

The system does not send informational or anticipatory alerts.
It sends alerts only when execution conditions are active.

------------------------------------------------------------
1) ARCHITECTURE

1.1 /api/snapshot — ONLY OKX Caller

Responsibilities:
- Fetch OKX perps data
- Resolve instId via cached instrument map
- Write 5m bucket snapshots to Upstash:
  snap5m:{instId}:{bucket}
- TTL: 24h
- Compute 5m delta vs previous bucket
- Classify state
- Support batch symbol writes

Must:
- Be the ONLY endpoint calling OKX
- Be safe to run every 5 minutes

Must NOT:
- Send Telegram
- Evaluate alert criteria
- Write alert state

------------------------------------------------------------

1.2 /api/multi — Snapshot Reader + Derivation Engine

Responsibilities:
- Read snapshots when source=snapshot
- Maintain rolling series:
  series5m:{instId}
- Compute multi-timeframe deltas:
  5m, 15m, 30m, 1h, 4h
- Compute levels from rolling 5m series:
  1h high / low / mid
  4h high / low / mid (if warm)

Must NOT:
- Call OKX in production alert mode
- Send Telegram
- Enforce cooldown
- Write alert state

Production alert always calls:
  /api/multi?...&source=snapshot

------------------------------------------------------------

1.3 /api/alert — ONLY Telegram Sender

Responsibilities:
- Authenticate
- Call /api/multi?source=snapshot
- Evaluate criteria
- Apply macro gate
- Apply warmup gate
- Apply B1 edge rule
- Apply mode rules
- Apply strict execution gating
- Enforce cooldown
- Write alert state
- Write heartbeat
- Send Telegram

Only this endpoint may send Telegram.

------------------------------------------------------------
2) SCHEDULING CONTRACT

Two independent scheduled jobs:

Job A — Snapshot Writer
  /api/snapshot?symbols=...
Cron:
  */5 * * * *

Job B — Alert Evaluator
  /api/alert?key=...&driver_tf=5m
Cron:
  1-59/5 * * * *

Design guarantee:
- Snapshot runs before alert inside each 5m UTC bucket.
- Alert reads snapshot mode only.
- Alert never calls OKX.

------------------------------------------------------------
3) RATE LIMIT GUARANTEE

Steady state:

- Snapshot → calls OKX
- Multi → reads Upstash only
- Alert → reads snapshot only

OKX calls per 5m cycle = 1 snapshot batch

Alert cannot cause OKX rate issues.

------------------------------------------------------------
4) USER CONFIGURABLE DEFAULTS

Supported inputs:
- mode=scalp|swing|build
- risk_profile=conservative|normal|aggressive

Precedence:
1. Query param
2. Env default

Defaults:
- DEFAULT_MODE=scalp
- DEFAULT_RISK_PROFILE=normal

------------------------------------------------------------
5) MODE CONTRACT

Mode is a user-specified parameter that determines bias source,
execution strictness, and positioning requirements.

Supported modes:
- scalp
- swing
- build

Mode selection affects:
1) Bias timeframe
2) Structural requirements
3) OI confirmation rules
4) Execution trigger definition
5) Edge strictness enforcement

SCALP MODE
- Bias derived from 15m lean (5m confirmation).
- B1 edge REQUIRED.
- Strict 15m OI spike REQUIRED (≥ configured threshold).
- Execution valid only while breakout or sweep-reclaim condition is active.
- Designed for immediate execution sensitivity.

SWING MODE
- Bias derived from 4h lean (15m confirmation).
- Execution requires structural break beyond 1h level.
- B1 edge OR structural break sufficient.
- OI used as context only (must not be sharply negative).
- Execution valid while structural break remains intact.

BUILD MODE
- Bias derived from 4h structure.
- Focus on structural positioning and controlled exposure.
- Execution requires actionable structural condition.
- OI context evaluated but not spike-dependent.
- Designed for accumulation or strategic positioning within defined zones.

------------------------------------------------------------
6) RISK PROFILE CONTRACT

Risk profile modifies numeric thresholds but does not alter architectural invariants.

Supported profiles:
- conservative
- normal
- aggressive

Risk profile may adjust:
- B1 edge percentage
- OI spike threshold
- Momentum threshold
- Cooldown duration (if configured)

Risk profile never bypasses:
- Macro gate
- Warmup gate
- Execution trigger requirement
- Binary execution contract

------------------------------------------------------------
7) BIAS LOGIC

scalp → 15m lean
swing → 4h lean
build → 4h lean

------------------------------------------------------------
8) LEVELS

Derived from rolling 5m series.

Required:
- 1h high / low / mid

Optional:
- 4h high / low / mid

Rounding:
- ≥1000 → 2 decimals
- 1–999 → 3 decimals
- <1 → 4 decimals

Triggers must print explicit numeric values.

------------------------------------------------------------
9) ALERT CRITERIA (Detection Layer)

1) Setup flip
2) Momentum confirmation
3) Positioning shock
4) force=1

------------------------------------------------------------
10) WARMUP GATE

Non-force alerts require:
levels["1h"].warmup == false

------------------------------------------------------------
11) MACRO GATE

BTC Bull Expansion 4H blocks SHORT bias on non-BTC symbols if:

- BTC 4h lean = long
- price_change_pct ≥ 2.0
- oi_change_pct ≥ 0.5

Macro reads snapshot data only.

------------------------------------------------------------
12) B1 EDGE RULE

Let:
- hi = 1h high
- lo = 1h low
- range = hi - lo
- edge = ALERT_STRONG_EDGE_PCT_1H × range

Default:
ALERT_STRONG_EDGE_PCT_1H = 0.15

Long:
price ≤ lo + edge

Short:
price ≥ hi - edge

Required for reco=strong.

------------------------------------------------------------
13) STRICT EXECUTION — SCALP

Must satisfy ALL:

1. Criteria hit
2. B1 edge satisfied
3. Price trigger active
4. 15m OI spike ≥ configured threshold

Binary execution only.
No WAIT alerts.

------------------------------------------------------------
14) SWING MODE EXECUTION

Requires:
- Criteria hit
- (B1 edge OR structural break)
- Price trigger active

OI:
- No strict spike required
- Must not be sharply negative against direction

------------------------------------------------------------
15) BUILD MODE EXECUTION

Requires:
- Criteria hit
- Actionable structural condition
- Price trigger aligned with structural intent

No informational alerts.
No anticipatory alerts.

------------------------------------------------------------
16) TELEGRAM BEHAVIOR

Send only when:
- criteria met
- warmup passed
- macro gate passed
- mode-specific execution conditions satisfied
- OI rules satisfied per mode
- not in cooldown

Otherwise silent.

------------------------------------------------------------
17) DRILLDOWN LINK

Includes:
- alerted symbols
- BTCUSDT

------------------------------------------------------------
18) COOLDOWN

Default: 20 minutes
Ignored when force=1.

------------------------------------------------------------
19) DRY MODE

dry=1:
- No Telegram
- No alert state writes
- No heartbeat writes

------------------------------------------------------------
20) HEARTBEAT

Key:
alert:lastRun

Contains:
- timestamp
- mode
- risk_profile
- sent boolean
- triggered_count

Used to verify scheduler health.

------------------------------------------------------------
21) SYSTEM INVARIANTS

21.1 Single External Data Authority
Only /api/snapshot may call OKX.

21.2 Deterministic Time Bucketing
bucket = floor(UTC_timestamp_ms / 300000)

21.3 Write-Then-Read Ordering
Snapshot must run before alert within each bucket.

21.4 Idempotent Snapshot Writes
Multiple writes within same bucket are safe.

21.5 Binary Execution Contract
Executable_now == true → DM
Executable_now == false → Silent

21.6 Cooldown Guarantee
No duplicate DM within cooldown window.

21.7 Redeploy Safety
State must live in Upstash, not memory.

------------------------------------------------------------
22) FORMAL TEST MATRIX

A) Snapshot Layer Tests
- Bucket rollover test
- Repeated snapshot within same bucket
- Missing previous bucket → warmup_5m true

B) Multi Layer Tests
- source=snapshot → zero OKX calls
- Missing snapshot → snapshot_missing only for that symbol
- Level rounding correctness

C) Alert Layer Tests
- Scalp requires OI spike
- Swing does not require OI spike
- Macro blocks short when BTC bull expansion
- Cooldown blocks repeat DM
- force=1 bypasses cooldown
- Warmup gate blocks early alert
- Numeric trigger lines include explicit levels

D) Edge Condition Tests
- Price exactly at lo + edge
- Price exactly at hi - edge
- OI exactly at threshold
- 1h range near zero
- Bucket boundary execution

------------------------------------------------------------
23) PRODUCTION SAFETY CHECKLIST

Before any change:

- Does this introduce OKX calls outside snapshot?
- Does this alter bucket determinism?
- Does this bypass cooldown?
- Does this allow non-binary alerts?
- Does this break scheduling order?

If yes → reject change.