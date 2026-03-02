Crypto Market Gateway — Requirements (v2.8)

Source of Truth: Repository Audit + Production Validation
Date: 2026-03-02

⸻

1) SYSTEM GOAL

The Crypto Market Gateway sends low-noise Telegram DMs only when an entry is actionable at the time of evaluation under the active mode logic.

Binary contract:

• Entry valid now → Send DM
• Entry not valid → No DM

No early signals.
No informational alerts.

⸻

2) ARCHITECTURE (AUTHORITATIVE FLOW)

2.1 /api/snapshot — Market Data Authority

Only endpoint permitted to call OKX.

Responsibilities:

• Fetch OKX SWAP data
• Write strict 5m bucket snapshots
snap5m:{instId}:{bucket}
• TTL applied (24h)
• Safe to run every 5 minutes

Must NOT:

• Send Telegram
• Enforce cooldown
• Evaluate alert rules
• Write alert state

Snapshot is the sole external market data authority.

⸻

2.2 /api/multi — Derivation Engine (Snapshot Reader Only)

When used by /api/alert, multi MUST run in snapshot-only mode.

Production requirement:

MULTI_DATA_SOURCE = snapshot

Responsibilities:

• Read snap5m:{instId}:{bucket}
• Maintain rolling:
series5m:{instId}
• Trim safely using positive indices
• Compute deltas:
5m / 15m / 30m / 1h / 4h
• Compute 1h structure levels (hi / lo / mid)
• Support driver_tf override

Must NOT:

• Call OKX when MULTI_DATA_SOURCE=snapshot
• Send Telegram
• Enforce cooldown
• Write alert state

multi is purely a deterministic derivation layer.

⸻

2.3 /api/alert — Alert Engine (Only Telegram Sender)

Only component allowed to send Telegram.

Responsibilities:

• Authenticate via ALERT_SECRET
• Call /api/multi?source=snapshot
• Apply detection filters
• Apply macro gate
• Apply regime adjustments
• Apply structural rules
• Apply mode logic
• Enforce cooldown
• Write state keys:
alert:lastSentAt:{instId}
alert:lastState:{mode}:{instId}
alert:lastState15m:{instId} (legacy mirror)
• Write heartbeat
• Send Telegram DM

Alert never calls OKX directly.

⸻

3) SCHEDULING CONTRACT

Snapshot Job:

*/5 * * * *
/api/snapshot?symbols=...

Alert Job:

1-59/5 * * * *
/api/alert?key=...&driver_tf=5m

Guarantee:

Snapshot runs at :00
Alert runs at :01

This ensures snapshot bucket exists before alert reads.

No race condition permitted.

Alert must always call:

/api/multi?...&source=snapshot


⸻

4) DATA SOURCE CONTRACT

Production must satisfy:

MULTI_DATA_SOURCE = snapshot

If this is not set, multi will call OKX directly.

Snapshot mode expected source output:

source: "upstash_snapshot+upstash_series"

If alert debug does not show this source, the data flow is misconfigured.

⸻

5) MODE SYSTEM

Supported modes:

• scalp
• swing
• build

Priority:

SCALP > SWING > BUILD

Resolution precedence:
	1.	?mode=
	2.	DEFAULT_MODES (comma list, lowercase, no spaces)
	3.	DEFAULT_MODE
	4.	fallback “scalp”

Example safe DEFAULT_MODES:

scalp,swing,build


⸻

6) BIAS SOURCE BY MODE

scalp → 5m lean
swing → 1h lean
build → 4h lean

⸻

7) STRUCTURE REQUIREMENT

1h structure required:

• hi
• lo
• mid

Warmup gate:

If 1h levels not available → no alert (unless force=1)

⸻

8) DETECTION LAYER (PRE-FILTER)

Triggers:

A) setup_flip
State changed vs lastState

B) momentum_confirm
abs(5m price_change_pct) >= ALERT_MOMENTUM_ABS_5M_PRICE_PCT

C) positioning_shock
OI shock OR price shock

If no triggers AND force != 1 → skip symbol

State must still seed even when skipped.

⸻

9) MACRO GATE

If enabled:

BTC 4h must satisfy:

• lean == long
• price_change_pct >= ALERT_MACRO_BTC_4H_PRICE_PCT_MIN
• oi_change_pct >= ALERT_MACRO_BTC_4H_OI_PCT_MIN

If true AND ALERT_MACRO_BLOCK_SHORTS_ON_ALTS=1:

Block short entries on alts.

⸻

10) B1 STRUCTURAL PROXIMITY

edge = ALERT_STRONG_EDGE_PCT_1H × (1h high − 1h low)

Long B1:
price ≤ lo + edge

Short B1:
price ≥ hi − edge

Usage:

scalp → always required
swing/build → required for reversal path

⸻

11) ENTRY RULES

11.1 SCALP (STRICT)

Requires:

• Detection trigger
• Warmup passed
• Macro passed
• B1 valid
• Entry trigger:
Long:
price > 1h high
OR sweep below 1h low and reclaim
Short:
price < 1h low
OR sweep above 1h high and reject
• 15m OI confirmation:
>= ALERT_SHOCK_OI_15M_PCT

⸻

11.2 SWING / BUILD

Two paths:

A) BREAK
Long: price > 1h high
Short: price < 1h low

B) REVERSAL
Must be in B1
AND 5m move away from extreme >= ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT

OI context:

If 15m oi_change_pct < ALERT_SWING_MIN_OI_PCT → block

⸻

12) LEVERAGE MODEL (ADVISORY ONLY)

Enabled by:

ALERT_LEVERAGE_ENABLED = 1

Per-mode risk budgets:

• ALERT_LEVERAGE_RISK_BUDGET_PCT_SCALP
• ALERT_LEVERAGE_RISK_BUDGET_PCT_SWING
• ALERT_LEVERAGE_RISK_BUDGET_PCT_BUILD

Base leverage:

riskBudgetPct / structureDistancePct

Adjusted down for:

• High OI volatility
• Extreme funding

Hard cap:

ALERT_LEVERAGE_MAX_CAP

Leverage affects DM text only.
Never gating.

⸻

13) REGIME ADJUST (OPTIONAL)

If:

ALERT_REGIME_ENABLED = 1

Expansion:

Tighten structural strength.

Contraction:

Allow B1 upgrade multiplier:
ALERT_REGIME_CONTRACTION_UPGRADE_EDGE_MULT

Regime modifies strength logic only.
Never overrides entry validity.

⸻

14) COOLDOWN

Key:

alert:lastSentAt:{instId}

Controlled by:

ALERT_COOLDOWN_MINUTES

force=1 bypasses.

⸻

15) HEARTBEAT

Key:

ALERT_HEARTBEAT_KEY

TTL:

ALERT_HEARTBEAT_TTL_SECONDS

Written every run unless dry=1.

⸻

16) TELEGRAM OUTPUT FORMAT

Mixed-entry DMs must include mode per symbol:

Example:

[SCALP] BTCUSDT ...
[SWING] LDOUSDT ...

Mode header may exist globally, but per-symbol mode printing is mandatory.

⸻

17) ENV VARIABLES (PRODUCTION AUDITED)

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
MULTI_DATA_SOURCE (must be snapshot in prod)
SNAPSHOT_KEY_PREFIX
SNAPSHOT_SYMBOL_FALLBACK_PREFIX

⸻

END OF DOCUMENT (v2.8)
