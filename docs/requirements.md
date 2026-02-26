Crypto Market Gateway — Requirements (v1.3)
Last updated: 2026-02-26
Owner: jdale19

SYSTEM GOAL
Send low-noise Telegram DMs only when a trade is executable within ~15 minutes, using structure (1h levels), OI confirmation, mode-aware bias, macro context, and strict execution gating.
If it is not actionable now → no DM.

1) ARCHITECTURE

1.1 /api/multi — Data Only
Responsibilities:
- Fetch OKX perps snapshot
- Compute deltas (5m, 15m, 30m, 1h, 4h)
- Maintain rolling 5m series in Upstash
- Compute levels from stored 5m series:
  - 1h high / low / mid
  - 4h high / low / mid (if warm)
- Return structured JSON

It MUST NOT:
- Send Telegram
- Enforce cooldown
- Evaluate alert criteria
- Write alert state

1.2 /api/alert — Only Alert Sender
Responsibilities:
- Authenticate
- Call /api/multi
- Evaluate criteria
- Apply macro gates
- Apply warmup gate
- Apply B1 edge rule
- Apply mode rules
- Apply strict execution trigger
- Enforce cooldown
- Write alert state
- Send Telegram

Only this endpoint may send Telegram.

2) USER CONFIGURABLE DEFAULTS

Supported inputs:
- mode=scalp|swing|build
- risk_profile=conservative|normal|aggressive

Precedence:
1. Explicit query param
2. Stored setting (Upstash, optional)
3. Env default

Env defaults:
- DEFAULT_MODE (default: scalp)
- DEFAULT_RISK_PROFILE (default: normal)

Defaults apply to both /api/multi and /api/alert.

3) BIAS LOGIC (MODE-AWARE)

scalp → 15m lean (confirm 5m)
swing → 4h lean (confirm 15m)
build → 4h lean (1D proxy optional)

Output:
bias=long|short|neutral

4) LEVELS

From stored 5m series:
- 1h high / low / mid (required)
- 4h high / low / mid (optional)

Round levels based on price:
≥ 1000 → 2 decimals
1–999 → 3 decimals
<1 → 4 decimals

Triggers must print numeric values explicitly.
Example:
trigger: next 15m close > 1987.56 (1h high)

5) ALERT CRITERIA (Detection Layer)

1) Setup flip
15m state changed vs stored state

2) Momentum confirmation
5m lean == 15m lean
AND abs(5m price_change_pct) ≥ 0.10%

3) Positioning shock
15m oi_change_pct ≥ 0.50%
AND abs(15m price_change_pct) ≥ 0.20%

4) force=1

6) WARMUP GATE

Non-force alerts require:
levels["1h"].warmup == false

7) MACRO GATE

BTC Bull Expansion 4H:
If BTC 4h:
- lean=long
- price_change_pct ≥ 2.0
- oi_change_pct ≥ 0.5

Block SHORT bias alerts on non-BTC symbols.

8) B1 EDGE RULE

Let:
hi = 1h high
lo = 1h low
range = hi - lo
edge = ALERT_STRONG_EDGE_PCT_1H × range

Default:
ALERT_STRONG_EDGE_PCT_1H = 0.15

Long: price ≤ lo + edge
Short: price ≥ hi - edge

Must be true for reco=strong.

9) STRICT EXECUTION RULES (Scalp Mode)

Non-force scalp alert sends ONLY if ALL are true:

1) Criteria hit
2) B1 edge satisfied

3) Price trigger active (current 15m close):

Long:
- 15m close > 1h high
OR
- sweep < 1h low AND 15m close back above 1h low

Short:
- 15m close < 1h low
OR
- sweep > 1h high AND 15m close back below 1h high

4) Strict OI confirmation:

15m oi_change_pct ≥ 0.50%

If OI spike not present → no DM.
No WAIT alerts.
Binary execution only.

10) SWING MODE EXECUTION

Requires:
- Criteria hit
- B1 edge satisfied OR structural break
- Price trigger active (15m close beyond level)

OI used as context only:
- No strict 0.50% spike required
- Must not be sharply negative against direction

11) BUILD MODE

Focus on:
- Structural zones
- Ladder adds
- Liquidation safety

Execution must still be actionable.
No heads-up only alerts.

12) TELEGRAM BEHAVIOR

Send DM only when:
- criteria met
- warmup passed
- macro gate passed
- B1 edge satisfied
- execution trigger active
- OI rules satisfied (if scalp)
- not in cooldown

Otherwise → silent.

13) DRILLDOWN LINK

DM drilldown includes:
- Only alerted symbol(s)
- PLUS BTCUSDT

14) COOLDOWN

ALERT_COOLDOWN_MINUTES = 20
Ignored when force=1.

15) DRY MODE

dry=1:
- No Telegram
- No state writes

16) ACCEPTANCE CRITERIA

1. /api/multi never sends Telegram
2. /api/alert is sole sender
3. Scalp sends only when strict execution rule satisfied
4. Swing does not require 15m OI ≥ 0.50%
5. No WAIT alerts in automatic mode
6. Triggers include numeric level values
7. Drilldown scoped correctly
8. Cooldown enforced
9. All thresholds configurable via env