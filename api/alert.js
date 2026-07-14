// /api/alert.js
// Crypto Market Gateway — mode-aware alerts (scalp strict, swing realistic)
//
// CHANGE (minimal rework):
// - MULTI MODE SELECTION: support automation modes scalp/swing via mode query or DEFAULT_MODES env var
// - PRIORITY: Premium is sendable; non-Premium cannot preempt Premium across modes
// - SCALP: unchanged logic (strict breakout/sweep + strict OI confirmation + B1 required)
// - SWING: "B1 reversal" entry option (bounce/reject near 1h extremes); Build is no longer an automation mode
// - DM COPY: explicit numeric zone ranges (ex: 1.594–1.597)
// - MESSAGE CONTRACT: concise manual TG with recipe tier, management hint, edge/watch, and entry only
// - STATE SEEDING: always seed lastState; for swing/build mirror legacy lastState15m
// - LEVERAGE RECO: rendered in message, and ALERT_MIN_LEVERAGE can hard-gate trades at render stage
// - ANALYTICS TELEMETRY: ET day/session fields added for fired/random/skipped rows where emitted
// - MANUAL TG V11: only the two validated Swing recipes remain live; weak Scalp routes are analytics-only
// - RANKED TELEGRAM: one message per qualifying recipe, with up to three ranked symbol alternatives
// - TELEMETRY FIX: preserve execution wick atom metadata when merging candidate context
// - ANALYTICS-ONLY DISCOVERY: retain demoted Scalp routes and add regression-derived catch-up, breadth-ignition, and spot-led crowding stamps
// - PREMIUM SUPPRESSION: former Liquidity Snap Long and BTC/breadth washout pilots are analytics-only; weak Swing Long continuation/breakout and BTC OI compression stay blocked
// - ANALYTICS POSTING: report posted/throttled/failed webhook health in heartbeat and debug output
// - EXTERNAL TELEMETRY: legacy side-aware aggregate is deprecated; raw COIN/VIX/DXY/QQQ/SPX/US2Y telemetry is capture-only
// - TWO-COHORT ANALYTICS: Random is sampled before any candidate/selector gate; Fired is persisted only for Premium alerts successfully sent to Telegram. Candidate/Premium metadata remain fields, never cohorts.
//
// Notes:
// - Behavior: same per-mode rules; we just evaluate multiple modes in order and choose first that triggers.
// - Default modes now use DEFAULT_MODES env var (comma list). DEFAULT_MODE is still honored as fallback.
// - Leverage reco; can also be used to change gating.

const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const EVAL_BUCKET_MS = 5 * 60 * 1000;

// Stable evaluation order only; Telegram sendability is Premium-first, not mode-first.
const MODE_PRIORITY = ["scalp", "swing"];

const ANALYTICS_VERSION_TAGS = Object.freeze({
  selector_version: "selector_v3_2_external_aggregate_deprecated_2026_07_06",
  confidence_version: "confidence_v2_1_external_aggregate_deprecated_2026_07_06",
  trade_read_version: "trade_read_v1_1_external_aggregate_deprecated_2026_07_06",
  ext_context_version: "external_telemetry_v1_aggregate_deprecated_2026_07_06",
  btc_short_tf_version: "btc_short_tf_soft_v1_2026_04_14",
  entry_idea_version: "entry_ideas_v1_2026_04_20",
  premium_recipe_version: "manual_tg_recipes_v11_swing_only_ranked_shortlists_2026_07_14",
  candidate_stamp_version: "2026-07-14-regression_stitched_scalp_candidates_v1",
  random_baseline_version: "random_pre_gate_full_universe_v3_2026_07_06",
});

function getAnalyticsVersionTags() {
  return { ...ANALYTICS_VERSION_TAGS };
}

function getDeployInfo() {
  return {
    vercel: !!process.env.VERCEL,
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || null,
    sha:
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.VERCEL_GITHUB_COMMIT_SHA ||
      process.env.GITHUB_SHA ||
      null,
    ref:
      process.env.VERCEL_GIT_COMMIT_REF ||
      process.env.VERCEL_GITHUB_COMMIT_REF ||
      process.env.GITHUB_REF_NAME ||
      null,
  };
}
function makeAnalyticsPostResult({
  status = "not_attempted",
  eventCount = 0,
  batchCount = 0,
  failedBatchCount = 0,
  errorCode = null,
} = {}) {
  const normalStatus = String(status || "not_attempted");
  const safeCount = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  return {
    status: normalStatus,
    // A scheduled event that is throttled or intentionally disabled was not
    // durably persisted, so it is not analytics-healthy even though the main
    // alert handler itself may have completed successfully.
    ok: normalStatus === "posted" || normalStatus === "no_events",
    eventCount: safeCount(eventCount),
    batchCount: safeCount(batchCount),
    failedBatchCount: safeCount(failedBatchCount),
    errorCode: errorCode ? String(errorCode) : null,
  };
}

function analyticsHeartbeatFields(result) {
  const safe = result && typeof result === "object"
    ? result
    : makeAnalyticsPostResult();

  return {
    analytics_status: String(safe.status || "not_attempted"),
    analytics_ok: typeof safe.ok === "boolean" ? safe.ok : null,
    analytics_event_count: Number.isFinite(Number(safe.eventCount))
      ? Math.max(0, Math.floor(Number(safe.eventCount)))
      : 0,
    analytics_batch_count: Number.isFinite(Number(safe.batchCount))
      ? Math.max(0, Math.floor(Number(safe.batchCount)))
      : 0,
    analytics_failed_batch_count: Number.isFinite(Number(safe.failedBatchCount))
      ? Math.max(0, Math.floor(Number(safe.failedBatchCount)))
      : 0,
    analytics_error_code: safe.errorCode ? String(safe.errorCode) : null,
  };
}

function analyticsResponseSummary(result) {
  const fields = analyticsHeartbeatFields(result);
  return {
    status: fields.analytics_status,
    ok: fields.analytics_ok,
    event_count: fields.analytics_event_count,
    batch_count: fields.analytics_batch_count,
    failed_batch_count: fields.analytics_failed_batch_count,
    error_code: fields.analytics_error_code,
  };
}

async function postAnalyticsBatch(events, meta = {}) {
  const eventCount = Array.isArray(events) ? events.length : 0;

  if (!Array.isArray(events) || eventCount === 0) {
    return makeAnalyticsPostResult({ status: "no_events", eventCount: 0 });
  }

  if (!process.env.ANALYTICS_WEBHOOK_URL) {
    return makeAnalyticsPostResult({ status: "disabled", eventCount });
  }

  // Keep outbound analytics writes small. The direct Apps Script ingest accepts
  // the existing batch payload contract and writes one rectangular range per
  // request, without routing the payload through an n8n Google Sheets node.
  const maxEventsPerPostRaw = Number(process.env.ANALYTICS_MAX_EVENTS_PER_POST || 3);
  const maxEventsPerPost = Number.isInteger(maxEventsPerPostRaw) && maxEventsPerPostRaw > 0
    ? Math.min(maxEventsPerPostRaw, 10)
    : 3;

  const minPostMinutes = Number(process.env.ANALYTICS_MIN_POST_INTERVAL_MINUTES || 0);
  const throttleKey = String(
    process.env.ANALYTICS_POST_THROTTLE_KEY || "alert:analytics:lastPostAt"
  );
  const containsFired = events.some(
    (event) => String(event?.observation_type || "").toLowerCase() === "fired"
  );

  // Random sampling may be rate-limited to control ingest volume. Fired rows
  // must never be suppressed by that throttle because Fired is the persisted
  // record of a Telegram alert that was actually delivered.
  if (!containsFired && Number.isFinite(minPostMinutes) && minPostMinutes > 0) {
    try {
      const lastPostRaw = await redis.get(throttleKey);
      const lastPostAt = lastPostRaw == null ? null : Number(lastPostRaw);

      if (
        Number.isFinite(lastPostAt) &&
        Date.now() - lastPostAt < minPostMinutes * 60 * 1000
      ) {
        return makeAnalyticsPostResult({ status: "throttled", eventCount });
      }
    } catch (_) {
      // Preserve existing behavior: a throttle-read problem must not prevent
      // a normal analytics attempt. The POST result below remains authoritative.
    }
  }

  const analyticsIngestKey = String(
    process.env.ANALYTICS_INGEST_SHARED_SECRET || ""
  ).trim();

  let postedBatchCount = 0;
  for (let start = 0; start < eventCount; start += maxEventsPerPost) {
    const batch = events.slice(start, start + maxEventsPerPost);
    const payload = {
      source: "gateway",
      ts: Date.now(),
      ...meta,
      events: batch,
    };

    // The existing n8n ingest ignores this field. The direct Apps Script endpoint
    // requires it, so it can reject unauthenticated writes without exposing the
    // secret in the endpoint URL or repository.
    if (analyticsIngestKey) payload.ingest_key = analyticsIngestKey;

    let response;
    let responseBody = null;

    try {
      response = await fetch(process.env.ANALYTICS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // Apps Script web apps usually return HTTP 200 even for application-level
      // rejections. Treat an explicit { ok: false } response as a failed post so
      // heartbeat telemetry remains truthful.
      const responseText = await response.text();
      if (responseText) {
        try {
          responseBody = JSON.parse(responseText);
        } catch (_) {
          responseBody = null;
        }
      }
    } catch (_) {
      const result = makeAnalyticsPostResult({
        status: "failed",
        eventCount,
        batchCount: postedBatchCount,
        failedBatchCount: 1,
        errorCode: "analytics_webhook_request_failed",
      });
      console.error("[analytics] post failed", result.errorCode);
      return result;
    }

    const applicationRejected = responseBody && responseBody.ok === false;
    if (!response.ok || applicationRejected) {
      const result = makeAnalyticsPostResult({
        status: "failed",
        eventCount,
        batchCount: postedBatchCount,
        failedBatchCount: 1,
        errorCode: applicationRejected
          ? String(responseBody.error || "analytics_webhook_rejected")
          : `analytics_webhook_http_${response.status}`,
      });
      console.error("[analytics] post failed", result.errorCode);
      return result;
    }

    postedBatchCount += 1;
  }

  if (Number.isFinite(minPostMinutes) && minPostMinutes > 0) {
    await redis.set(throttleKey, String(Date.now())).catch(() => null);
  }

  return makeAnalyticsPostResult({
    status: "posted",
    eventCount,
    batchCount: postedBatchCount,
  });
}

const CFG = {
  cooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 20),
  minRR: Number(process.env.ALERT_MIN_RR || 1.5),
  randomBaselineEnabled: String(process.env.RANDOM_BASELINE_ENABLED || "0") === "1",
  randomBaselinePct: Number(process.env.RANDOM_BASELINE_PCT || 10),
  premiumRealert: {
    // Optional, safe default. Controls whether a repeat Premium reminder is still near the original entry.
    entryTolerancePct: Number(process.env.ALERT_PREMIUM_REALERT_ENTRY_TOLERANCE_PCT || 0.35),
  },
  recipeRouting: {
    shortlistSize: Number(process.env.ALERT_RECIPE_SHORTLIST_SIZE || 3),
    cooldownMinutesByMode: {
      scalp: Number(process.env.ALERT_RECIPE_COOLDOWN_MINUTES_SCALP || 60),
      swing: Number(process.env.ALERT_RECIPE_COOLDOWN_MINUTES_SWING || 240),
    },
  },
  stop: {
  // candle flip method for reversals
  reversalUseWick: String(process.env.ALERT_STOP_REVERSAL_USE_WICK || "0") === "1", // 0=body, 1=wick
  reversalBodyPct: Number(process.env.ALERT_STOP_REVERSAL_BODY_PCT || 1.0), // 0..1 (1 = full flipped body)
  reversalPadPct: Number(process.env.ALERT_STOP_REVERSAL_PAD_PCT || 0.05), // percent (0.05 = 0.05%)
  contPadPct: Number(process.env.ALERT_STOP_CONT_PAD_PCT || 0.03),          // percent
},
  
  // Defaults
  // DEFAULT_MODES="scalp,swing" (comma list). Build is manual/research-only and ignored here.
  // Fallbacks: DEFAULT_MODE then "scalp"
  defaultModesRaw: String(process.env.DEFAULT_MODES || "").toLowerCase(),
  defaultMode: String(process.env.DEFAULT_MODE || "scalp").toLowerCase(), // legacy fallback
  defaultRisk: String(process.env.DEFAULT_RISK_PROFILE || "normal").toLowerCase(),

  // Detection thresholds
  momentumAbs5mPricePct: Number(process.env.ALERT_MOMENTUM_ABS_5M_PRICE_PCT || 0.1),
  shockOi15mPct: Number(process.env.ALERT_SHOCK_OI_15M_PCT || 0.5),
  shockAbs15mPricePct: Number(process.env.ALERT_SHOCK_ABS_15M_PRICE_PCT || 0.2),

  // Levels windows (from stored 5m series)
  levelWindows: {
  "15m": 3,   // NEW (scalp invalidation)
  "30m": 6,
  "1h": 12,
  "4h": 48,
},

  // B1 edge (structural proximity)
  strongEdgePct1h: Number(process.env.ALERT_STRONG_EDGE_PCT_1H || 0.15),

  minTpPctByMode: {
  scalp: Number(process.env.ALERT_MIN_TP_PCT_SCALP || 0.25),
  swing: Number(process.env.ALERT_MIN_TP_PCT_SWING || 1.0),
  build: Number(process.env.ALERT_MIN_TP_PCT_BUILD || 3.0),
},

minRangePctByMode: {
  scalp: Number(process.env.ALERT_MIN_RANGE_PCT_SCALP || 0.4),
  swing: Number(process.env.ALERT_MIN_RANGE_PCT_SWING || 0.9),
  build: Number(process.env.ALERT_MIN_RANGE_PCT_BUILD || 1.0),
},
  
  // Swing reversal micro-confirm (5m push away from extreme)
  swingReversalMin5mMovePct: Number(process.env.ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT || 0.05),
 
  // Directional Pull Score (swing/build only, neutral-rescue only)
    dps: {
    enabled: String(process.env.ALERT_DPS_ENABLED || "1") === "1",
    threshold: Number(process.env.ALERT_DPS_THRESHOLD || 0.35),
    favoredReversalMult: Number(process.env.ALERT_DPS_FAVORED_REVERSAL_MULT || 0.85),
  },

  bottoming: {
    enabled: String(process.env.ALERT_BOTTOMING_ENABLED || "1") === "1",
    lookbackCandles: Number(process.env.ALERT_BOTTOMING_LOOKBACK_CANDLES || 6),
    repeatLookback: Number(process.env.ALERT_BOTTOM_WICK_LOOKBACK || 3),
    repeatWickCount: Number(process.env.ALERT_BOTTOM_WICK_REPEAT_COUNT || 2),
    pricePct: Number(process.env.ALERT_EXHAUSTION_PRICE_PCT || 0.35),
    oiPct: Number(process.env.ALERT_EXHAUSTION_OI_PCT || 0.25),
    nonConfirmOiPct: Number(process.env.ALERT_EXHAUSTION_NONCONFIRM_OI_PCT || 0.1),
    decelMult: Number(process.env.ALERT_BOTTOMING_DECEL_MULT || 0.8),
    scoreMin: Number(process.env.ALERT_BOTTOMING_SCORE_MIN || 2.5),
    shortPenaltyScoreMin: Number(process.env.ALERT_BOTTOMING_SHORT_PENALTY_SCORE_MIN || 2.5),
    shortBlockScoreMin: Number(process.env.ALERT_BOTTOMING_SHORT_BLOCK_SCORE_MIN || 3.5),
  },
  
  telegramMaxChars: 3900,

  // External-market telemetry only. These fields are persisted for research but
  // intentionally do not affect selector eligibility, confidence, or TG copy.
  // Legacy ALERT_EXT_CONTEXT_* score/weight/source settings are intentionally ignored.
  externalTelemetry: {
    enabled: String(
      process.env.ALERT_EXTERNAL_TELEMETRY_ENABLED ||
      process.env.ALERT_EXT_CONTEXT_ENABLED ||
      "1"
    ) === "1",
    timeoutMs: Number(process.env.ALERT_EXTERNAL_TELEMETRY_TIMEOUT_MS || 2500),
    cacheTtlSeconds: Number(process.env.ALERT_EXTERNAL_TELEMETRY_CACHE_TTL_SECONDS || 300),
    cacheKey: String(process.env.ALERT_EXTERNAL_TELEMETRY_CACHE_KEY || "alert:externalTelemetry:v1"),
    yahooChartBaseUrl: String(
      process.env.ALERT_EXTERNAL_TELEMETRY_YAHOO_CHART_BASE_URL ||
      "https://query1.finance.yahoo.com/v8/finance/chart"
    ).replace(/\/$/, ""),
    yahooSymbols: {
      coin: String(process.env.ALERT_EXTERNAL_TELEMETRY_COIN_SYMBOL || "COIN"),
      dxy: String(process.env.ALERT_EXTERNAL_TELEMETRY_DXY_SYMBOL || "DX-Y.NYB"),
      qqq: String(process.env.ALERT_EXTERNAL_TELEMETRY_QQQ_SYMBOL || "QQQ"),
      spx: String(process.env.ALERT_EXTERNAL_TELEMETRY_SPX_SYMBOL || "^GSPC"),
    },
    vixUrl: String(
      process.env.ALERT_EXTERNAL_TELEMETRY_VIX_URL ||
      "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"
    ),
    us2yUrlTemplate: String(
      process.env.ALERT_EXTERNAL_TELEMETRY_US2Y_URL_TEMPLATE ||
      "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
    ),
  },

  anomaly: {
  enabled: String(process.env.ALERT_ANOMALY_ENABLED || "1") === "1",
  tf: String(process.env.ALERT_ANOMALY_TF || "15m").toLowerCase(),
  basketSymbols: normalizeSymbols(
  process.env.DEFAULT_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,NEARUSDT,SUIUSDT"
),
  minBasketSize: Number(process.env.ALERT_ANOMALY_MIN_BASKET_SIZE || 3),
  fallbackBasketSize: Number(process.env.ALERT_ANOMALY_FALLBACK_BASKET_SIZE || 5),
},

  // Macro gate (mode-aware timeframe)
macro: {
  enabled: String(process.env.ALERT_MACRO_GATE_ENABLED || "1") === "1",
  btcSymbol: String(process.env.ALERT_MACRO_BTC_SYMBOL || "BTCUSDT").toUpperCase(),

  // Mode -> BTC delta timeframe used for macro
  // Defaults: scalp=1h, swing=1h, build=4h
  btcTfByMode: {
  scalp: String(process.env.ALERT_MACRO_BTC_TF_SCALP || "1h").toLowerCase(),
  swing: String(process.env.ALERT_MACRO_BTC_TF_SWING || "4h").toLowerCase(),
  build: String(process.env.ALERT_MACRO_BTC_TF_BUILD || "4h").toLowerCase(),
},

  // Thresholds apply to the selected BTC timeframe
  btcPricePctMin: Number(process.env.ALERT_MACRO_BTC_PRICE_PCT_MIN || 2.0),
  btcOiPctMin: Number(process.env.ALERT_MACRO_BTC_OI_PCT_MIN || 0.5),

  blockShortsOnAltsWhenBtcBull: String(process.env.ALERT_MACRO_BLOCK_SHORTS_ON_ALTS || "1") === "1",
},
    // Short-TF BTC tape is a soft signal only. It is used for confidence/read quality, not hard entry gating.
  btcShortTf: {
    enabled: String(process.env.ALERT_BTC_SHORT_TF_ENABLED || "1") === "1",
    price5mMinPct: Number(process.env.ALERT_BTC_SHORT_TF_PRICE_5M_MIN_PCT || 0.10),
    price15mMinPct: Number(process.env.ALERT_BTC_SHORT_TF_PRICE_15M_MIN_PCT || 0.20),
    confidenceBoost: Number(process.env.ALERT_BTC_SHORT_TF_CONFIDENCE_BOOST || 0.15),
    confidencePenalty: Number(process.env.ALERT_BTC_SHORT_TF_CONFIDENCE_PENALTY || 0.25),
  },

  // Optional regime adjust (kept; does not bypass entry rules)
  regime: {
    enabled: String(process.env.ALERT_REGIME_ENABLED || "1") === "1",

    expansionPricePctMin: Number(process.env.ALERT_REGIME_EXPANSION_4H_PRICE_PCT_MIN || 3.0),
    expansionOiPctMin: Number(process.env.ALERT_REGIME_EXPANSION_4H_OI_PCT_MIN || 1.0),

    contractionAbsPricePctMax: Number(process.env.ALERT_REGIME_CONTRACTION_4H_ABS_PRICE_PCT_MAX || 1.0),
    // NOTE: keeping your env name as provided (even if it’s a bit inconsistent)
    contractionOiPctMax: Number(process.env.ALERT_REGIME_CONTRACTION_OI_4H_PCT_MAX || -1.0),

    contractionUpgradeEnabled: String(process.env.ALERT_REGIME_CONTRACTION_UPGRADE_ENABLED || "1") === "1",
    contractionUpgradeEdgeMult: Number(process.env.ALERT_REGIME_CONTRACTION_UPGRADE_EDGE_MULT || 1.5),
  },

  scalp: {
    sweepLookbackPoints: Number(process.env.ALERT_SCALP_SWEEP_LOOKBACK_POINTS || 3),
  },
  wick: {
    minPct: Number(process.env.ALERT_WICK_MIN_PCT || 0.15),
    sweepLookbackPoints: Number(process.env.ALERT_WICK_SWEEP_LOOKBACK_POINTS || 3),
  },
  // Swing/build OI context rule
  swing: {
    minOiPct: Number(process.env.ALERT_SWING_MIN_OI_PCT || -0.5),
  },

  flowPersists: {
    enabled: String(process.env.ALERT_FLOW_PERSISTS_ENABLED || "1") === "1",
    tfs: String(process.env.ALERT_FLOW_PERSISTS_TFS || "5m,15m,30m")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((tf) => ["5m", "15m", "30m", "1h", "4h"].includes(tf)),
    minMatches: Number(process.env.ALERT_FLOW_PERSISTS_MIN_MATCHES || 3),
    requireOiPositive:
      String(process.env.ALERT_FLOW_PERSISTS_REQUIRE_OI_POSITIVE || "1") === "1",
    maxFundingAbs: Number(process.env.ALERT_FLOW_PERSISTS_MAX_FUNDING_ABS || 0.01),
    min5mPricePct: Number(process.env.ALERT_FLOW_PERSISTS_MIN_5M_PRICE_PCT || 0.03),
  },

  entryIdeas: {
    ignitionBreakout: {
      enabled: String(process.env.ALERT_IDEA_IGNITION_ENABLED || "1") === "1",
      lookbackCandles: Number(process.env.ALERT_IDEA_IGNITION_LOOKBACK || 10),
      minBodyMult: Number(process.env.ALERT_IDEA_IGNITION_MIN_BODY_MULT || 1.5),
      minBodyPct: Number(process.env.ALERT_IDEA_IGNITION_MIN_BODY_PCT || 0.12),
      minOiRiseCount: Number(process.env.ALERT_IDEA_IGNITION_MIN_OI_RISE_COUNT || 2),
      oiRiseLookback: Number(process.env.ALERT_IDEA_IGNITION_OI_RISE_LOOKBACK || 3),
      maxFundingAbs: Number(process.env.ALERT_IDEA_IGNITION_MAX_FUNDING_ABS || 0.01),
    },
    liquiditySnap: {
      enabled: String(process.env.ALERT_IDEA_LIQUIDITY_SNAP_ENABLED || "1") === "1",
      lookbackCandles: Number(process.env.ALERT_IDEA_LIQUIDITY_SNAP_LOOKBACK || 10),
      minReclaimPct: Number(process.env.ALERT_IDEA_LIQUIDITY_SNAP_MIN_RECLAIM_PCT || 0.0),
      minWickQualityScore: Number(process.env.ALERT_IDEA_LIQUIDITY_SNAP_MIN_WICK_SCORE || 2.5),
    },
    slowLeverageSqueeze: {
      enabled: String(process.env.ALERT_IDEA_SLOW_SQUEEZE_ENABLED || "1") === "1",
      oiCandles: Number(process.env.ALERT_IDEA_SLOW_SQUEEZE_OI_CANDLES || 6),
      minOiRiseCount: Number(process.env.ALERT_IDEA_SLOW_SQUEEZE_MIN_OI_RISE_COUNT || 5),
      maxPricePct: Number(process.env.ALERT_IDEA_SLOW_SQUEEZE_MAX_PRICE_PCT || 0.6),
      breakLookbackCandles: Number(process.env.ALERT_IDEA_SLOW_SQUEEZE_BREAK_LOOKBACK || 10),
    },
    slowShortBreak: {
      enabled: String(process.env.ALERT_IDEA_SHORT_BREAK_ENABLED || "1") === "1",
      fundingMin: Number(process.env.ALERT_IDEA_SHORT_FUNDING_MIN || 0.01),
      oiRiseCandles: Number(process.env.ALERT_IDEA_SHORT_OI_RISE_CANDLES || 6),
      maxPricePct: Number(process.env.ALERT_IDEA_SHORT_MAX_PRICE_PCT || 0.6),
      breakLookbackCandles: Number(process.env.ALERT_IDEA_SHORT_BREAK_LOOKBACK || 10),
    },
  },

  // --- Leverage Model (rendered copy + optional hard floor via ALERT_MIN_LEVERAGE) ---
  leverage: {
    // master switch (optional)
    enabled: String(process.env.ALERT_LEVERAGE_ENABLED || "1") === "1",

    // MODE-AWARE risk budget (% of account) used for the STRUCTURE proxy sizing calc
    // Legacy fallback: ALERT_RISK_BUDGET_PCT if you don’t set per-mode vars.
    riskBudgetPctByMode: {
      scalp: Number(
        process.env.ALERT_LEVERAGE_RISK_BUDGET_PCT_SCALP ||
          process.env.ALERT_RISK_BUDGET_PCT ||
          0.5
      ),
      swing: Number(
        process.env.ALERT_LEVERAGE_RISK_BUDGET_PCT_SWING ||
          process.env.ALERT_RISK_BUDGET_PCT ||
          1.0
      ),
      build: Number(
        process.env.ALERT_LEVERAGE_RISK_BUDGET_PCT_BUILD ||
          process.env.ALERT_RISK_BUDGET_PCT ||
          1.5
      ),
    },

    // Hard cap so we don’t suggest insanity
    maxCap: Number(process.env.ALERT_LEVERAGE_MAX_CAP || 15),

    // OI instability thresholds (abs %)
    oiReduce1: Number(process.env.ALERT_LEVERAGE_OI_REDUCE1 || 1.0),
    oiReduce2: Number(process.env.ALERT_LEVERAGE_OI_REDUCE2 || 2.5),

    // Funding stretch thresholds (abs)
    fundingReduce1: Number(process.env.ALERT_LEVERAGE_FUNDING_REDUCE1 || 0.0004),
    fundingReduce2: Number(process.env.ALERT_LEVERAGE_FUNDING_REDUCE2 || 0.0008),
  },

  // Heartbeat (debug/run visibility)
  heartbeat: {
    key: String(process.env.ALERT_HEARTBEAT_KEY || "alert:lastRun"),
    ttlSeconds: Number(process.env.ALERT_HEARTBEAT_TTL_SECONDS || 60 * 60 * 24),
  },

  keys: {
    lastState: (mode, id) => `alert:lastState:${String(mode || "unknown")}:${id}`,
    last15mState: (id) => `alert:lastState15m:${id}`, // legacy
    lastSentAt: (id, mode) => `alert:lastSentAt:${id}:${String(mode || "unknown")}`,
    lastFiredAlert: (id, mode) => `alert:lastFiredAlert:${id}:${String(mode || "unknown")}`,
    lastPremiumAlert: (id, mode) => `alert:lastPremiumAlert:${id}:${String(mode || "unknown")}`,
    lastRecipeSentAt: (recipeId) => `alert:lastRecipeSentAt:${String(recipeId || "unknown")}`,
    series5m: (id) => `series5m:${id}`,
    externalTelemetry: () => CFG.externalTelemetry.cacheKey,
  },
};

function normalizeSymbols(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

async function getPrevClosePair(instId) {
  const raw = await redis.lrange(CFG.keys.series5m(instId), -3, -1);
  const pts = (raw || []).map(safeJsonParse).filter(Boolean);
  const closes = pts.map(p => asNum(p?.p)).filter(x => x != null);
  if (closes.length < 2) return null;
  return { prev: closes[closes.length - 2], last: closes[closes.length - 1] };
}

function stopTfForMode(mode) {
  const m = String(mode || "scalp").toLowerCase();
  if (m === "scalp") return "15m"; // tighter structure for scalps
  if (m === "swing") return "1h";
  if (m === "build") return "4h";
  return "1h";
}

async function computeStopLossPx({ instId, mode, bias, price, levels, execReason }) {
  const px = asNum(price);
  if (px == null) return null;

  const reason = String(execReason || "").toLowerCase();
  const isReversal =
    reason.includes("b1_reversal") ||
    reason.includes("wick_reclaim") ||
    reason.includes("wick_reject") ||
    reason.includes("wick_flush_reclaim") ||
    reason.includes("wick_spike_reject") ||
    reason.includes("liquidity_snap_reversal");

  const b = String(bias || "neutral").toLowerCase();
  if (b !== "long" && b !== "short") return null;

  // ---- REVERSAL STOP ----
  // Prefer real wick anchoring for wick-driven reversals. Fallback to body-flip for generic reversals.
  if (isReversal) {
    const useWick = CFG.stop.reversalUseWick && reason.includes("wick");

    if (useWick) {
      const recentPts = await getRecentSeriesPoints(instId, Math.max(2, CFG.wick.sweepLookbackPoints));
      if (recentPts.length) {
        const wickLows = recentPts
          .map((pt) => asNum(pt?.l ?? pt?.p))
          .filter((x) => x != null);
        const wickHighs = recentPts
          .map((pt) => asNum(pt?.h ?? pt?.p))
          .filter((x) => x != null);
        const wickLow = wickLows.length ? Math.min(...wickLows) : null;
        const wickHigh = wickHighs.length ? Math.max(...wickHighs) : null;
        const pad = Math.abs(Number(CFG.stop.reversalPadPct) || 0) / 100;

        if (b === "long" && wickLow != null) {
          let sl = wickLow;
          if (pad > 0) sl = sl * (1 - pad);
          if (Number.isFinite(sl) && sl < px) return sl;
        }

        if (b === "short" && wickHigh != null) {
          let sl = wickHigh;
          if (pad > 0) sl = sl * (1 + pad);
          if (Number.isFinite(sl) && sl > px) return sl;
        }
      }
    }

    const pair = await getPrevClosePair(instId);
    if (!pair) return null;

    const prev = pair.prev;
    const last = pair.last;
    const body = Math.abs(last - prev);
    if (!Number.isFinite(body) || body <= 0) return null;

    const dist = body * Math.max(0, Math.min(1, CFG.stop.reversalBodyPct));

    let sl = null;
    if (b === "long") sl = px - dist;
    if (b === "short") sl = px + dist;

    const pad = Math.abs(Number(CFG.stop.reversalPadPct) || 0) / 100;
    if (pad > 0) {
      if (b === "long") sl = sl * (1 - pad);
      if (b === "short") sl = sl * (1 + pad);
    }
    return sl;
  }

  // ---- CONTINUATION STOP (structure on stop TF) ----
  const tf = stopTfForMode(mode);
  const lvl = levels?.[tf];
  if (!lvl || lvl.warmup) return null;

  const hi = asNum(lvl.hi);
  const lo = asNum(lvl.lo);
  if (hi == null || lo == null) return null;

  const pad = Math.abs(Number(CFG.stop.contPadPct) || 0) / 100;

  let sl = null;
  if (b === "long") sl = lo;
  if (b === "short") sl = hi;

  if (pad > 0) {
    if (b === "long") sl = sl * (1 - pad);
    if (b === "short") sl = sl * (1 + pad);
  }
  return sl;
}



function invalidationTfForMode(mode) {
  const m = String(mode || "scalp").toLowerCase();
  if (m === "scalp") return "15m";
  if (m === "swing") return "1h";
  if (m === "build") return "4h";
  return "1h";
}

function normalizeDriverTf(raw) {
  const tf = String(raw || "5m").toLowerCase();
  return ["5m", "15m", "30m", "1h", "4h"].includes(tf) ? tf : "5m";
}

function normalizeRisk(raw) {
  const r = String(raw || "").toLowerCase();
  return ["conservative", "normal", "aggressive"].includes(r) ? r : null;
}

// multi-mode parsing
function normalizeModes(raw) {
  const allowed = new Set(MODE_PRIORITY);
  return String(raw || "")
    .toLowerCase()
    .split(",")
    .map((m) => m.trim())
    .filter((m) => allowed.has(m));
}

function prioritizeModes(modes) {
  const set = new Set(modes);
  return MODE_PRIORITY.filter((m) => set.has(m));
}

const asNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const abs = (x) => (x == null ? null : Math.abs(Number(x)));

const fmtPrice = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(4);
};

const fmtPct = (x, digits = 2) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(digits)}%`;
};

async function fetchWithTimeout(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "Cache-Control": "no-store",
        Accept: "application/json,text/csv,text/xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithTimeout(url, timeoutMs = 2500) {
  const response = await fetchWithTimeout(url, timeoutMs);
  return response.text();
}

async function fetchJsonWithTimeout(url, timeoutMs = 2500) {
  const response = await fetchWithTimeout(url, timeoutMs);
  return response.json();
}

function computePctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function parseYahooChartDayPct(payload) {
  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens = Array.isArray(quote?.open) ? quote.open : [];
  const closes = Array.isArray(quote?.close) ? quote.close : [];

  for (let i = Math.min(opens.length, closes.length) - 1; i >= 0; i -= 1) {
    const openPx = Number(opens[i]);
    const closePx = Number(closes[i]);
    if (Number.isFinite(openPx) && openPx > 0 && Number.isFinite(closePx) && closePx > 0) {
      return computePctChange(closePx, openPx);
    }
  }

  const validCloses = closes.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (validCloses.length >= 2) {
    return computePctChange(validCloses[validCloses.length - 1], validCloses[validCloses.length - 2]);
  }

  throw new Error("yahoo_chart_prices_missing");
}

function parseCsvRow(line) {
  return String(line || "")
    .split(",")
    .map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

function parseCboeVixDayPct(text) {
  const lines = String(text || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const headerIndex = lines.findIndex((line) => /\bdate\b/i.test(line) && /\bopen\b/i.test(line) && /\bclose\b/i.test(line));
  if (headerIndex < 0) throw new Error("cboe_vix_header_missing");

  const header = parseCsvRow(lines[headerIndex]).map((name) => name.toUpperCase());
  const dateIndex = header.indexOf("DATE");
  const openIndex = header.indexOf("OPEN");
  const closeIndex = header.indexOf("CLOSE");
  if (dateIndex < 0 || openIndex < 0 || closeIndex < 0) throw new Error("cboe_vix_columns_missing");

  const rows = lines
    .slice(headerIndex + 1)
    .map(parseCsvRow)
    .map((cells) => ({
      dateMs: Date.parse(String(cells[dateIndex] || "")),
      open: Number(cells[openIndex]),
      close: Number(cells[closeIndex]),
    }))
    .filter((row) => Number.isFinite(row.close) && row.close > 0);

  if (!rows.length) throw new Error("cboe_vix_prices_missing");
  const datedRows = rows.filter((row) => Number.isFinite(row.dateMs));
  const orderedRows = datedRows.length ? datedRows.sort((a, b) => a.dateMs - b.dateMs) : rows;
  const latest = orderedRows[orderedRows.length - 1];
  if (Number.isFinite(latest.open) && latest.open > 0) {
    return computePctChange(latest.close, latest.open);
  }
  if (rows.length >= 2) {
    return computePctChange(latest.close, rows[rows.length - 2].close);
  }
  throw new Error("cboe_vix_change_missing");
}

function extractXmlTag(text, tagName) {
  const escaped = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(
    new RegExp(`<\\/?(?:[A-Za-z0-9_-]+:)?${escaped}\\b[^>]*>([^<]*)<\\/(?:[A-Za-z0-9_-]+:)?${escaped}>`, "i")
  );
  return match ? String(match[1] || "").trim() : null;
}

function parseTreasuryUs2yDelta(text) {
  const entries = String(text || "").match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const rows = entries
    .map((entry) => {
      const dateRaw = extractXmlTag(entry, "NEW_DATE");
      const valueRaw = extractXmlTag(entry, "BC_2YEAR");
      const dateMs = Date.parse(String(dateRaw || ""));
      const value = Number(valueRaw);
      return { dateMs, value };
    })
    .filter((row) => Number.isFinite(row.dateMs) && Number.isFinite(row.value));

  if (rows.length < 2) throw new Error("treasury_us2y_values_missing");
  rows.sort((a, b) => a.dateMs - b.dateMs);
  return rows[rows.length - 1].value - rows[rows.length - 2].value;
}

function metricFailureReason(label, res) {
  if (!res) return `${label}_missing`;
  if (res.status === "rejected") {
    return res.reason?.name === "AbortError"
      ? `${label}_timeout`
      : `${label}_${res.reason?.message || "fetch_failed"}`;
  }
  return `${label}_non_finite`;
}

function buildYahooChartUrl(symbol) {
  const baseUrl = CFG.externalTelemetry.yahooChartBaseUrl;
  const encodedSymbol = encodeURIComponent(String(symbol || ""));
  return `${baseUrl}/${encodedSymbol}?range=5d&interval=1d&includePrePost=false&events=history`;
}

function buildTreasuryUs2yUrl() {
  const template = String(CFG.externalTelemetry.us2yUrlTemplate || "");
  return template.replaceAll("{year}", String(new Date().getUTCFullYear()));
}

function buildExternalTelemetrySummary(ctx = {}) {
  const source = ctx?.source || {};
  const labels = [
    `coin:${source.coin || "missing"}`,
    `vix:${source.vix || "missing"}`,
    `dxy:${source.dxy || "missing"}`,
    `qqq:${source.qqq || "missing"}`,
    `spx:${source.spx || "missing"}`,
    `us2y:${source.us2y || "missing"}`,
  ];
  return `telemetry_only|${labels.join(",")}`;
}

async function readExternalTelemetryCache() {
  const raw = await redis.get(CFG.keys.externalTelemetry()).catch(() => null);
  const cached = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!cached || typeof cached !== "object") return null;

  const fetchedAt = Number(cached?.fetchedAt);
  const ttlMs = Math.max(0, Number(CFG.externalTelemetry.cacheTtlSeconds || 0)) * 1000;
  if (!Number.isFinite(fetchedAt) || !ttlMs || Date.now() - fetchedAt > ttlMs) return null;
  return { ...cached, cache: "hit" };
}

async function writeExternalTelemetryCache(snapshot) {
  await redis
    .set(CFG.keys.externalTelemetry(), JSON.stringify(snapshot))
    .catch(() => null);
}

async function loadExternalTelemetry() {
  const out = {
    ok: false,
    bias: "neutral",
    coinDayPct: null,
    vixDayPct: null,
    dxyDayPct: null,
    qqqDayPct: null,
    spxDayPct: null,
    us2yDelta: null,
    reason: null,
    source: {
      coin: "yahoo_chart",
      vix: "cboe_csv",
      dxy: "yahoo_chart",
      qqq: "yahoo_chart",
      spx: "yahoo_chart",
      us2y: "treasury_xml",
    },
    fetchedAt: Date.now(),
    cache: "miss",
  };

  if (!CFG.externalTelemetry?.enabled) {
    out.reason = "telemetry_only|disabled";
    return out;
  }

  const cached = await readExternalTelemetryCache();
  if (cached) return cached;

  const timeoutMs = CFG.externalTelemetry.timeoutMs;
  const symbols = CFG.externalTelemetry.yahooSymbols || {};
  const tasks = [
    ["coin", () => fetchJsonWithTimeout(buildYahooChartUrl(symbols.coin), timeoutMs).then(parseYahooChartDayPct)],
    ["vix", () => fetchTextWithTimeout(CFG.externalTelemetry.vixUrl, timeoutMs).then(parseCboeVixDayPct)],
    ["dxy", () => fetchJsonWithTimeout(buildYahooChartUrl(symbols.dxy), timeoutMs).then(parseYahooChartDayPct)],
    ["qqq", () => fetchJsonWithTimeout(buildYahooChartUrl(symbols.qqq), timeoutMs).then(parseYahooChartDayPct)],
    ["spx", () => fetchJsonWithTimeout(buildYahooChartUrl(symbols.spx), timeoutMs).then(parseYahooChartDayPct)],
    ["us2y", () => fetchTextWithTimeout(buildTreasuryUs2yUrl(), timeoutMs).then(parseTreasuryUs2yDelta)],
  ];

  const settled = await Promise.allSettled(tasks.map(([_, run]) => run()));
  const metricMap = Object.fromEntries(tasks.map(([label], index) => [label, settled[index]]));

  const assign = (label, outputKey) => {
    const result = metricMap[label];
    if (result?.status === "fulfilled" && Number.isFinite(result.value)) out[outputKey] = result.value;
  };
  assign("coin", "coinDayPct");
  assign("vix", "vixDayPct");
  assign("dxy", "dxyDayPct");
  assign("qqq", "qqqDayPct");
  assign("spx", "spxDayPct");
  assign("us2y", "us2yDelta");

  const required = ["coinDayPct", "vixDayPct", "dxyDayPct", "qqqDayPct", "spxDayPct", "us2yDelta"];
  const failures = tasks
    .filter(([label], index) => {
      const outputKey = {
        coin: "coinDayPct",
        vix: "vixDayPct",
        dxy: "dxyDayPct",
        qqq: "qqqDayPct",
        spx: "spxDayPct",
        us2y: "us2yDelta",
      }[label];
      return !Number.isFinite(out[outputKey]);
    })
    .map(([label]) => metricFailureReason(label, metricMap[label]));

  out.ok = required.every((key) => Number.isFinite(out[key]));
  out.reason = out.ok
    ? "telemetry_only|ok"
    : `telemetry_only|partial|${failures.join("|") || "missing"}`;

  await writeExternalTelemetryCache(out);
  return out;
}

function average(nums = []) {
  const vals = (nums || []).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function classifyAnomalyPattern({ pricePct, oiPct }) {
  if (!Number.isFinite(pricePct) || !Number.isFinite(oiPct)) return "unknown";
  if (pricePct > 0 && oiPct > 0) return "long_build";
  if (pricePct < 0 && oiPct < 0) return "long_liq";
  if (pricePct > 0 && oiPct < 0) return "short_squeeze";
  if (pricePct < 0 && oiPct > 0) return "short_build";
  return "mixed";
}

function buildCrossAssetAnomaly({
  items = [],
  tf = CFG.anomaly?.tf || "15m",
  preferredBasket = CFG.anomaly?.basketSymbols || ["BTCUSDT", "ETHUSDT", "SOLUSDT", "NEARUSDT", "SUIUSDT"],
  minBasketSize = CFG.anomaly?.minBasketSize || 3,
  fallbackBasketSize = CFG.anomaly?.fallbackBasketSize || 5,
}) {
  if (!CFG.anomaly?.enabled) {
    return {
      ok: false,
      reason: "disabled",
      tf,
      basket_symbols: [],
      ranking: [],
    };
  }

  const rows = (items || [])
    .filter((it) => it?.ok && it?.symbol)
    .map((it) => {
      const pricePct = asNum(it?.deltas?.[tf]?.price_change_pct);
      const oiPct = asNum(it?.deltas?.[tf]?.oi_change_pct);
      const fundingRate = asNum(it?.funding_rate);

      if (!Number.isFinite(pricePct) || !Number.isFinite(oiPct) || !Number.isFinite(fundingRate)) {
        return null;
      }

      return {
        symbol: String(it.symbol).toUpperCase(),
        pricePct,
        oiPct,
        fundingRate,
      };
    })
    .filter(Boolean);

  const preferredSet = new Set(
    (preferredBasket || []).map((s) => String(s || "").toUpperCase()).filter(Boolean)
  );

  let basketRows = rows.filter((r) => preferredSet.has(r.symbol));

  if (basketRows.length < minBasketSize) {
    basketRows = rows
      .slice()
      .sort((a, b) => {
        const aPri = preferredSet.has(a.symbol) ? 0 : 1;
        const bPri = preferredSet.has(b.symbol) ? 0 : 1;
        if (aPri !== bPri) return aPri - bPri;
        return a.symbol.localeCompare(b.symbol);
      })
      .slice(0, Math.min(fallbackBasketSize, rows.length));
  }

  if (basketRows.length < minBasketSize) {
    return {
      ok: false,
      reason: "basket_too_small",
      tf,
      basket_symbols: basketRows.map((r) => r.symbol),
      ranking: [],
    };
  }

  const basketPricePct = average(basketRows.map((r) => r.pricePct));
  const basketOiPct = average(basketRows.map((r) => r.oiPct));
  const basketFundingRate = average(basketRows.map((r) => r.fundingRate));

  if (
    !Number.isFinite(basketPricePct) ||
    !Number.isFinite(basketOiPct) ||
    !Number.isFinite(basketFundingRate)
  ) {
    return {
      ok: false,
      reason: "basket_invalid",
      tf,
      basket_symbols: basketRows.map((r) => r.symbol),
      ranking: [],
    };
  }

  const ranking = rows
    .map((r) => {
      const priceOiGap = Math.abs(r.oiPct - r.pricePct);
      const fundingDeviationBps = Math.abs((r.fundingRate - basketFundingRate) * 10000);
      const oiTrendDeviation = Math.abs(r.oiPct - basketOiPct);
      const priceDeviation = Math.abs(r.pricePct - basketPricePct);

      const score = Number(
        (priceOiGap + fundingDeviationBps + oiTrendDeviation + priceDeviation).toFixed(2)
      );

      return {
        symbol: r.symbol,
        score,
        pattern: classifyAnomalyPattern({ pricePct: r.pricePct, oiPct: r.oiPct }),
        price_pct: Number(r.pricePct.toFixed(4)),
        oi_pct: Number(r.oiPct.toFixed(4)),
        funding_rate: r.fundingRate,
        basket_price_pct: Number(basketPricePct.toFixed(4)),
        basket_oi_pct: Number(basketOiPct.toFixed(4)),
        basket_funding_rate: basketFundingRate,
        components: {
          price_oi_gap: Number(priceOiGap.toFixed(2)),
          funding_deviation_bps: Number(fundingDeviationBps.toFixed(2)),
          oi_trend_deviation: Number(oiTrendDeviation.toFixed(2)),
          price_deviation: Number(priceDeviation.toFixed(2)),
        },
      };
    })
    .sort((a, b) => b.score - a.score);

  return {
    ok: true,
    tf,
    basket_symbols: basketRows.map((r) => r.symbol),
    basket: {
      price_pct: Number(basketPricePct.toFixed(4)),
      oi_pct: Number(basketOiPct.toFixed(4)),
      funding_rate: basketFundingRate,
    },
    ranking,
  };
}

function computeRiskReward({ entryPrice, stopLossPx, tp }) {
  const entry = asNum(entryPrice);
  const sl = asNum(stopLossPx);
  const take = asNum(tp);

  if (entry == null || sl == null || take == null || entry <= 0) return null;

  const rewardPct = (Math.abs(take - entry) / entry) * 100;
  const riskPct = (Math.abs(entry - sl) / entry) * 100;

  if (!Number.isFinite(rewardPct) || !Number.isFinite(riskPct) || riskPct <= 0) return null;

  return {
    rewardPct,
    riskPct,
    rr: rewardPct / riskPct,
  };
}

function buildTpLadder({ bias, entryPrice, levels }) {
  const entry = asNum(entryPrice);
  const dir = String(bias || "").toLowerCase();
  const lvl = levels?.["4h"];

  if (entry == null || entry <= 0 || (dir !== "long" && dir !== "short")) return [];
  if (!lvl || lvl.warmup) return [];

  const hi = asNum(lvl.hi);
  const lo = asNum(lvl.lo);
  const mid = asNum(lvl.mid);
  if (hi == null || lo == null || mid == null || !(hi > lo)) return [];

  const range = hi - lo;
  const rawTargets = dir === "long"
    ? [mid, hi, hi + range * 0.5, hi + range]
    : [mid, lo, lo - range * 0.5, lo - range];

  const targets = [];
  for (const raw of rawTargets) {
    const tp = asNum(raw);
    if (tp == null) continue;
    if (dir === "long" && tp <= entry) continue;
    if (dir === "short" && tp >= entry) continue;
    if (targets.some((x) => Math.abs(x.tp - tp) <= Math.max(entry * 0.000001, 0.00000001))) continue;

    targets.push({
      label: `TP${targets.length + 1}`,
      tp,
      tpPct: (Math.abs(tp - entry) / entry) * 100,
    });
  }

  return targets;
}

function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

// ---- Heartbeat helpers ----
async function writeHeartbeat(payload, { dry }) {
  if (dry) return;
  try {
    await redis.set(CFG.heartbeat.key, JSON.stringify(payload));
    await redis.expire(CFG.heartbeat.key, CFG.heartbeat.ttlSeconds);
  } catch {}
}

async function readHeartbeat() {
  try {
    const raw = await redis.get(CFG.heartbeat.key);
    return safeJsonParse(raw);
  } catch {
    return null;
  }
}

function getModeCfg(mode) {
  const m = String(mode || "scalp").toLowerCase();
  return {
    minTpPct: Number(CFG.minTpPctByMode?.[m] ?? 0),
    minRangePct: Number(CFG.minRangePctByMode?.[m] ?? 0),
  };
}

function horizonMinForMode(mode) {
  const m = String(mode || "scalp").toLowerCase();
  if (m === "scalp") return 60;
  if (m === "swing") return 240;
  if (m === "build") return 1440;
  return 240;
}

function buildEvaluationTiming(baseTs, horizonMin) {
  const hasHorizon = Number.isFinite(Number(horizonMin)) && Number(horizonMin) > 0;
  if (!hasHorizon) {
    return {
      dueTs: "",
      evalBucket: "",
      evalTsEffective: "",
    };
  }

  const dueTs = Number(baseTs) + Number(horizonMin) * 60 * 1000;
  const evalBucket = Math.floor(dueTs / EVAL_BUCKET_MS);

  return {
    dueTs,
    evalBucket,
    evalTsEffective: evalBucket * EVAL_BUCKET_MS,
  };
}

function getEtSessionTelemetry(ts = Date.now()) {
  const n = Number(ts);
  const date = Number.isFinite(n) ? new Date(n) : new Date();

  const fallback = {
    day_of_week_et: "",
    day_num_et: "",
    is_weekend_et: "",
    is_us_equity_rth: "",
    us_equity_session: "",
  };

  if (!Number.isFinite(date.getTime())) return fallback;

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);

    const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const dayShort = String(partMap.weekday || "");
    const weekdayNum = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[dayShort];
    const weekdayName = {
      Sun: "Sunday",
      Mon: "Monday",
      Tue: "Tuesday",
      Wed: "Wednesday",
      Thu: "Thursday",
      Fri: "Friday",
      Sat: "Saturday",
    }[dayShort] || "";

    const hour = Number(partMap.hour);
    const minute = Number(partMap.minute);

    if (!Number.isFinite(weekdayNum) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return fallback;
    }

    const minuteOfDay = hour * 60 + minute;
    const isWeekend = weekdayNum === 0 || weekdayNum === 6;
    const isRth = !isWeekend && minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;

    let session = "overnight";
    if (isWeekend) session = "weekend";
    else if (isRth) session = "regular";
    else if (minuteOfDay >= 4 * 60 && minuteOfDay < 9 * 60 + 30) session = "pre_market";
    else if (minuteOfDay >= 16 * 60 && minuteOfDay < 20 * 60) session = "after_hours";

    return {
      day_of_week_et: weekdayName,
      day_num_et: weekdayNum,
      is_weekend_et: isWeekend,
      is_us_equity_rth: isRth,
      us_equity_session: session,
    };
  } catch (_) {
    return fallback;
  }
}

function summarizeSkips(skipped) {
  return {
    itemErrors: (skipped || []).filter((s) => String(s?.reason || "") === "item_not_ok").length,
    topSkips: (skipped || []).slice(0, 12).map((s) => ({
      symbol: s.symbol,
      mode: s.mode,
      reason: s.reason,
    })),
  };
}

// Uses 1h range as the structural “room to trade” proxy
function rangePct1h({ levels, price }) {
  const l1h = levels?.["1h"];
  const p = asNum(price);
  if (!l1h || l1h.warmup || p == null || p <= 0) return null;

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  if (hi == null || lo == null) return null;

  const range = hi - lo;
  if (!(range > 0)) return null;

  return (range / p) * 100;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { ok: false, detail: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };
  }

  const maxChars = Number(CFG.telegramMaxChars || 3800);

  async function sendOne(chunk) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    });

    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) return { ok: false, detail: j };
    return { ok: true };
  }

  function chunkPlainText(rawText) {
    const parts = String(rawText || "")
      .split("\n\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const chunks = [];
    let current = "";

    for (const part of parts) {
      const next = current ? `${current}\n\n${part}` : part;

      if (next.length <= maxChars) {
        current = next;
        continue;
      }

      if (current) chunks.push(current);

      if (part.length <= maxChars) {
        current = part;
        continue;
      }

      const lines = part.split("\n");
      let lineChunk = "";

      for (const line of lines) {
        const nextLine = lineChunk ? `${lineChunk}\n${line}` : line;

        if (nextLine.length <= maxChars) {
          lineChunk = nextLine;
          continue;
        }

        if (lineChunk) chunks.push(lineChunk);

        if (line.length <= maxChars) {
          lineChunk = line;
          continue;
        }

        for (let i = 0; i < line.length; i += maxChars) {
          chunks.push(line.slice(i, i + maxChars));
        }

        lineChunk = "";
      }

      current = lineChunk;
    }

    if (current) chunks.push(current);
    return chunks;
  }

  function buildTelegramChunks(rawText) {
    const textValue = String(rawText || "");
    const marker = "\nPASTE_ROWS_PIPE\n";

    if (!textValue.includes(marker)) {
      return chunkPlainText(textValue);
    }

    const [preambleRaw, pipeRaw] = textValue.split(marker);
    const chunks = [];

    const preambleChunks = chunkPlainText(preambleRaw);
    chunks.push(...preambleChunks);

    const pipeLines = String(pipeRaw || "").split("\n");
    const header = pipeLines[0] || "";
    const rows = pipeLines.slice(1).filter(Boolean);

    const pipePrefix = `PASTE_ROWS_PIPE\n${header}`;
    let current = pipePrefix;

    for (const row of rows) {
      const next = `${current}\n${row}`;

      if (next.length <= maxChars) {
        current = next;
        continue;
      }

      if (current && current !== pipePrefix) {
        chunks.push(current);
      }

      if ((`${pipePrefix}\n${row}`).length <= maxChars) {
        current = `${pipePrefix}\n${row}`;
        continue;
      }

      const rowLabel = row.split("|")[0] || row.slice(0, 50);
      const safeRoom = Math.max(500, maxChars - pipePrefix.length - 32);
      const rowParts = [];

      for (let i = 0; i < row.length; i += safeRoom) {
        rowParts.push(row.slice(i, i + safeRoom));
      }

      for (let i = 0; i < rowParts.length; i++) {
        chunks.push(
          `${pipePrefix}\n${rowLabel}|row_part_${i + 1}_of_${rowParts.length}|${rowParts[i]}`
        );
      }

      current = pipePrefix;
    }

    if (current && current !== pipePrefix) {
      chunks.push(current);
    }

    return chunks.filter(Boolean);
  }

  const chunks = buildTelegramChunks(text);

  for (const chunk of chunks) {
    const sent = await sendOne(chunk);
    if (!sent.ok) return sent;
  }

  return { ok: true, chunk_count: chunks.length };
}

// State write helper to satisfy v2.6 seeding rule (mirror legacy for swing/build)
async function writeLastState(mode, instId, curState, { dry }) {
  if (dry) return;
  if (!curState || curState === "unknown") return;
  try {
    await redis.set(CFG.keys.lastState(mode, instId), curState);
    if (mode !== "scalp") await redis.set(CFG.keys.last15mState(instId), curState); // legacy mirror
  } catch {}
}

async function computeLevelsFromSeries(instId) {
  const need = Math.max(...Object.values(CFG.levelWindows));
  const raw = await redis.lrange(CFG.keys.series5m(instId), -need, -1);

  const pts = (raw || []).map(safeJsonParse).filter(Boolean);
  const out = {};

  for (const [label, n] of Object.entries(CFG.levelWindows)) {
    if (pts.length < n) {
      out[label] = { warmup: true };
      continue;
    }

        const highs = pts
      .slice(-n)
      .map((p) => asNum(p?.h ?? p?.p))
      .filter((x) => x != null);

    const lows = pts
      .slice(-n)
      .map((p) => asNum(p?.l ?? p?.p))
      .filter((x) => x != null);

    if (!highs.length || !lows.length) {
      out[label] = { warmup: true };
      continue;
    }

    const hi = Math.max(...highs);
    const lo = Math.min(...lows);
    out[label] = {
      warmup: false,
      hi,
      lo,
      mid: (hi + lo) / 2,
    };
  }

  return out;
}

async function getRecentPricesFromSeries(instId, n) {
  const raw = await redis.lrange(CFG.keys.series5m(instId), -Math.max(1, n), -1);
  return (raw || [])
    .map(safeJsonParse)
    .filter(Boolean)
    .map((p) => asNum(p?.p))
    .filter((x) => x != null);
}

async function getRecentSeriesPoints(instId, n) {
  const raw = await redis.lrange(CFG.keys.series5m(instId), -Math.max(1, n), -1);
  return (raw || []).map(safeJsonParse).filter(Boolean);
}
function btcInstIdFromSymbol(symbol = "BTCUSDT") {
  const sym = String(symbol || "BTCUSDT").toUpperCase();
  if (sym.endsWith("USDT") && sym.length > 4) {
    return `${sym.slice(0, -4)}-USDT-SWAP`;
  }
  return "BTC-USDT-SWAP";
}

function pctChangeFromValues(first, last) {
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  return ((last - first) / first) * 100;
}

async function loadBtcTapeContext(instId) {
  const out = {
    ok: false,
    reason: "warmup",
    instId: instId || "",
    price5mPct: null,
    price15mPct: null,
    price30mPct: null,
    price60mPct: null,
    oi5mPct: null,
    oi15mPct: null,
    oi30mPct: null,
    oi60mPct: null,
    funding: null,
    funding5mAvg: null,
    funding15mAvg: null,
    funding30mAvg: null,
    tapeState: "neutral",
  };

  if (!instId) {
    out.reason = "missing_instid";
    return out;
  }

  const pts = await getRecentSeriesPoints(instId, 13);
  if (!Array.isArray(pts) || pts.length < 7) {
    out.reason = "warmup";
    return out;
  }

  const latest = pts[pts.length - 1] || {};
  const latestPrice = asNum(latest?.p);
  const latestOi = asNum(latest?.oi);
  const fundingNow = asNum(latest?.fr);

  const point1 = pts.length >= 2 ? pts[pts.length - 2] : null;
  const point3 = pts.length >= 4 ? pts[pts.length - 4] : null;
  const point6 = pts.length >= 7 ? pts[pts.length - 7] : null;
  const point12 = pts.length >= 13 ? pts[pts.length - 13] : null;

  out.price5mPct = pctChangeFromValues(asNum(point1?.p), latestPrice);
  out.price15mPct = pctChangeFromValues(asNum(point3?.p), latestPrice);
  out.price30mPct = pctChangeFromValues(asNum(point6?.p), latestPrice);
  out.price60mPct = pctChangeFromValues(asNum(point12?.p), latestPrice);

  out.oi5mPct = pctChangeFromValues(asNum(point1?.oi), latestOi);
  out.oi15mPct = pctChangeFromValues(asNum(point3?.oi), latestOi);
  out.oi30mPct = pctChangeFromValues(asNum(point6?.oi), latestOi);
  out.oi60mPct = pctChangeFromValues(asNum(point12?.oi), latestOi);

  out.funding = fundingNow;
  out.funding5mAvg = avg(pts.slice(-1).map((p) => asNum(p?.fr)));
  out.funding15mAvg = avg(pts.slice(-3).map((p) => asNum(p?.fr)));
  out.funding30mAvg = avg(pts.slice(-6).map((p) => asNum(p?.fr)));

  if (Number.isFinite(out.funding) && Number.isFinite(out.price30mPct)) {
    if (out.funding > 0 && out.price30mPct > 0) out.tapeState = "short_hostile";
    else if (out.funding < 0 && out.price30mPct < 0) out.tapeState = "long_hostile";
  }

  out.ok = true;
  out.reason = "ok";
  return out;
}

function wickPct(point, bias) {
  const h = asNum(point?.h ?? point?.p);
  const l = asNum(point?.l ?? point?.p);
  const c = asNum(point?.p);

  if (h == null || l == null || c == null || c <= 0) return null;

  if (bias === "short") return ((h - c) / c) * 100;
  if (bias === "long") return ((c - l) / c) * 100;
  return null;
}

function candleBodyPct(point) {
  const o = asNum(point?.o ?? point?.open);
  const c = asNum(point?.p ?? point?.c ?? point?.close);
  if (o == null || c == null || c <= 0) return null;
  return (Math.abs(c - o) / c) * 100;
}

function wickQuality(point, bias) {
  const h = asNum(point?.h ?? point?.p);
  const l = asNum(point?.l ?? point?.p);
  const c = asNum(point?.p ?? point?.c ?? point?.close);

  if (h == null || l == null || c == null || c <= 0) {
    return {
      wickPct: null,
      bodyPct: null,
      wickToBody: null,
      qualityScore: 0,
      dominant: false,
      strong: false,
      extreme: false,
      bodyAware: false,
    };
  }

  const wick = wickPct(point, bias);
  const body = candleBodyPct(point);
  const bodyAware = Number.isFinite(body) && body > 0;
  const wickToBody =
    Number.isFinite(wick) && bodyAware
      ? wick / Math.max(body, 0.0001)
      : null;

  const dominant = bodyAware
    ? Number.isFinite(wickToBody) && wickToBody >= 1.5
    : Number.isFinite(wick) && wick >= Math.max(CFG.wick.minPct * 1.75, CFG.wick.minPct + 0.12);

  const strong = bodyAware
    ? Number.isFinite(wick) &&
      wick >= Math.max(CFG.wick.minPct * 1.5, CFG.wick.minPct + 0.10) &&
      dominant
    : Number.isFinite(wick) && wick >= Math.max(CFG.wick.minPct * 2.0, CFG.wick.minPct + 0.18);

  const extreme = bodyAware
    ? Number.isFinite(wick) &&
      wick >= Math.max(CFG.wick.minPct * 2, CFG.wick.minPct + 0.20) &&
      Number.isFinite(wickToBody) &&
      wickToBody >= 2.5
    : Number.isFinite(wick) && wick >= Math.max(CFG.wick.minPct * 2.6, CFG.wick.minPct + 0.30);

  let qualityScore = 0;
  if (Number.isFinite(wick)) qualityScore += Math.min(3, wick / Math.max(CFG.wick.minPct, 0.01));
  if (Number.isFinite(wickToBody)) qualityScore += Math.min(3, wickToBody / 1.5);
  else if (Number.isFinite(wick)) qualityScore += Math.min(1.5, wick / Math.max(CFG.wick.minPct * 2, 0.02));

  return {
    wickPct: Number.isFinite(wick) ? wick : null,
    bodyPct: Number.isFinite(body) ? body : null,
    wickToBody: Number.isFinite(wickToBody) ? wickToBody : null,
    qualityScore,
    dominant,
    strong,
    extreme,
    bodyAware,
  };
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeDps({ levels, price, lastPoint }) {
  const l1h = levels?.["1h"];
  const p = asNum(price);

  if (!CFG.dps?.enabled || !l1h || l1h.warmup || p == null) {
    return { score: 0, bias: "neutral", pos01: null, wickEdge: null, locationScore: null };
  }

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  if (hi == null || lo == null || !(hi > lo)) {
    return { score: 0, bias: "neutral", pos01: null, wickEdge: null, locationScore: null };
  }

  const pos01 = clamp((p - lo) / (hi - lo), 0, 1);
  const locationScore = (pos01 - 0.5) * 2; // near high = +1 => short tilt

  const shortWick = wickQuality(lastPoint, "short");
  const longWick = wickQuality(lastPoint, "long");

  const shortEdge = Number(shortWick?.qualityScore || 0);
  const longEdge = Number(longWick?.qualityScore || 0);
  const wickEdge = (shortEdge - longEdge) / 3;

  const score = locationScore + wickEdge;

  let bias = "neutral";
  if (score >= CFG.dps.threshold) bias = "short";
  else if (score <= -CFG.dps.threshold) bias = "long";

  return { score, bias, pos01, wickEdge, locationScore };
}

function computeBottomingSignal({ item, points }) {
  const cfg = CFG.bottoming;
  if (!cfg?.enabled) {
    return { ok: false, triggered: false, score: 0, reasons: ["bottoming_disabled"] };
  }

  const need = Math.max(4, cfg.lookbackCandles);
  if (!Array.isArray(points) || points.length < need) {
    return { ok: false, triggered: false, score: 0, reasons: ["bottoming_warmup"] };
  }

  const recent = points.slice(-need);
  const last = recent[recent.length - 1];
  const prev = recent.slice(0, -1);

  const d5 = asNum(item?.deltas?.["5m"]?.price_change_pct);
  const d15 = asNum(item?.deltas?.["15m"]?.price_change_pct);
  const oi5 = asNum(item?.deltas?.["5m"]?.oi_change_pct);
  const oi15 = asNum(item?.deltas?.["15m"]?.oi_change_pct);

  let score = 0;
  const reasons = [];

  const downsideStress =
    (Number.isFinite(d15) && d15 <= -Math.abs(cfg.pricePct)) ||
    (Number.isFinite(d5) && d5 <= -(Math.abs(cfg.pricePct) * 0.5));

  if (downsideStress) {
    score += 1;
    reasons.push("downside_stress");
  }

  const oiStress =
    (Number.isFinite(oi5) && oi5 >= cfg.oiPct) ||
    (Number.isFinite(oi15) && oi15 >= cfg.oiPct);

  if (downsideStress && oiStress) {
    score += 1;
    reasons.push("oi_stress");
  }

  const wickWindow = recent.slice(-Math.max(2, cfg.repeatLookback));
  const lowerWickCount = wickWindow.reduce((count, pt) => {
    const meta = wickQuality(pt, "long");
    return count + (meta.strong || meta.extreme ? 1 : 0);
  }, 0);

  if (lowerWickCount >= cfg.repeatWickCount) {
    score += 1;
    reasons.push("repeat_lower_wicks");
  } else if (lowerWickCount >= 1) {
    score += 0.5;
    reasons.push("lower_wick_reject");
  }

  const barMoves = [];
  for (let i = 1; i < recent.length; i++) {
    const move = priceChangePctBetweenPoints(recent[i - 1], recent[i]);
    if (Number.isFinite(move)) barMoves.push(move);
  }

  const lastMove = barMoves.length ? barMoves[barMoves.length - 1] : null;
  const priorDownAbs = barMoves.slice(0, -1).filter((x) => x < 0).map((x) => Math.abs(x));
  const priorDownAvg = avg(priorDownAbs);

  const downsideDecel =
    Number.isFinite(lastMove) &&
    lastMove < 0 &&
    Number.isFinite(priorDownAvg) &&
    priorDownAvg > 0 &&
    Math.abs(lastMove) <= priorDownAvg * cfg.decelMult;

  if (downsideDecel) {
    score += 1;
    reasons.push("downside_decelerating");
  }

  const prevLows = prev.map((pt) => asNum(pt?.l ?? pt?.p)).filter((x) => x != null);
  const prevLow = prevLows.length ? Math.min(...prevLows) : null;
  const lastLow = asNum(last?.l ?? last?.p);
  const lastClose = asNum(last?.p ?? last?.c ?? last?.close);

  const positioningNonConfirm =
    Number.isFinite(lastLow) &&
    Number.isFinite(prevLow) &&
    lastLow < prevLow &&
    Number.isFinite(lastClose) &&
    lastClose > lastLow &&
    (
      !Number.isFinite(oi5) ||
      oi5 <= cfg.nonConfirmOiPct ||
      !Number.isFinite(oi15) ||
      oi15 <= cfg.nonConfirmOiPct
    );

  if (positioningNonConfirm) {
    score += 1;
    reasons.push("positioning_non_confirm");
  }

  const finalScore = Number(score.toFixed(2));

  return {
    ok: true,
    triggered: finalScore >= cfg.scoreMin,
    score: finalScore,
    reasons,
    downsideStress,
    oiStress,
    lowerWickCount,
    downsideDecel,
    positioningNonConfirm,
    lastMove,
    priorDownAvg,
  };
}

function avg(nums) {
  const vals = (nums || []).filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function countOiRiseIntervals(points) {
  let rises = 0;
  for (let i = 1; i < points.length; i++) {
    const prevOi = asNum(points[i - 1]?.oi);
    const curOi = asNum(points[i]?.oi);
    if (prevOi != null && curOi != null && curOi > prevOi) rises += 1;
  }
  return rises;
}

function priceChangePctBetweenPoints(firstPoint, lastPoint) {
  const first = asNum(firstPoint?.p);
  const last = asNum(lastPoint?.p);
  if (first == null || last == null || first <= 0) return null;
  return ((last - first) / first) * 100;
}

async function getIdeaWindow(instId, n) {
  const pts = await getRecentSeriesPoints(instId, n);
  return Array.isArray(pts) ? pts : [];
}

function ignitionBreakoutLongCheck(points, price, fundingRate) {
  const cfg = CFG.entryIdeas.ignitionBreakout;
  if (!cfg?.enabled) return { ok: false, reason: 'ignition_disabled' };
  const need = Math.max(cfg.lookbackCandles + 1, cfg.oiRiseLookback + 1, 4);
  if (!Array.isArray(points) || points.length < need) return { ok: false, reason: 'ignition_warmup' };

  const last = points[points.length - 1];
  const prev = points.slice(-(cfg.lookbackCandles + 1), -1);
  const prevHighs = prev.map((pt) => asNum(pt?.h ?? pt?.p)).filter((x) => x != null);
  if (!prevHighs.length) return { ok: false, reason: 'ignition_missing_highs' };

  const recentHigh = Math.max(...prevHighs);
  const bodyNow = candleBodyPct(last);
  const avgBody = avg(prev.slice(-5).map(candleBodyPct));
  const breakout = Number.isFinite(price) && Number.isFinite(recentHigh) && price > recentHigh;
  const bodyOk = Number.isFinite(bodyNow) && bodyNow >= cfg.minBodyPct && (!Number.isFinite(avgBody) || bodyNow >= avgBody * cfg.minBodyMult);

  const oiWindow = points.slice(-(cfg.oiRiseLookback + 1));
  const oiRiseCount = countOiRiseIntervals(oiWindow);
  const oiOk = oiRiseCount >= cfg.minOiRiseCount;
  const fundingOk = !Number.isFinite(fundingRate) || Math.abs(fundingRate) <= cfg.maxFundingAbs;

  if (breakout && bodyOk && oiOk && fundingOk) {
    return {
      ok: true,
      reason: 'ignition_breakout_long',
      entryLine: `ignition breakout above ${fmtPrice(recentHigh)} + expanding body + OI rise (${oiRiseCount}/${cfg.oiRiseLookback})`,
      detail: { recentHigh, bodyNow, avgBody, oiRiseCount },
    };
  }

  return { ok: false, reason: 'ignition_not_ready', detail: { recentHigh, bodyNow, avgBody, oiRiseCount, breakout, bodyOk, oiOk, fundingOk } };
}

function liquiditySnapReversalLongCheck(points, price, p5) {
  const cfg = CFG.entryIdeas.liquiditySnap;
  if (!cfg?.enabled) return { ok: false, reason: 'liq_snap_disabled' };
  const need = cfg.lookbackCandles + 1;
  if (!Array.isArray(points) || points.length < need) return { ok: false, reason: 'liq_snap_warmup' };

  const last = points[points.length - 1];
  const prev = points.slice(-(cfg.lookbackCandles + 1), -1);
  const prevLows = prev.map((pt) => asNum(pt?.l ?? pt?.p)).filter((x) => x != null);
  if (!prevLows.length) return { ok: false, reason: 'liq_snap_missing_lows' };

  const recentLow = Math.min(...prevLows);
  const lastLow = asNum(last?.l ?? last?.p);
  const wickMeta = wickQuality(last, 'long');
  const reclaimPct = Number.isFinite(price) && Number.isFinite(recentLow) && recentLow > 0 ? ((price - recentLow) / recentLow) * 100 : null;
  const swept = Number.isFinite(lastLow) && Number.isFinite(recentLow) && lastLow < recentLow;
  const reclaimed = Number.isFinite(price) && Number.isFinite(recentLow) && price > recentLow;
  const reclaimOk = Number.isFinite(reclaimPct) && reclaimPct >= cfg.minReclaimPct;
  const wickOk = wickMeta.strong || wickMeta.extreme || (Number.isFinite(wickMeta.qualityScore) && wickMeta.qualityScore >= cfg.minWickQualityScore);
  const turnOk = Number.isFinite(p5) && p5 > 0;

  if (swept && reclaimed && reclaimOk && wickOk && turnOk) {
    return {
      ok: true,
      reason: 'liquidity_snap_reversal_long',
      entryLine: `liquidity snap below ${fmtPrice(recentLow)} then reclaim + strong wick reversal`,
      wickMeta,
      detail: { recentLow, reclaimPct },
    };
  }

  return { ok: false, reason: 'liq_snap_not_ready', detail: { recentLow, lastLow, reclaimPct, swept, reclaimed, wickOk, turnOk } };
}

function slowLeverageSqueezeLongCheck(points, price) {
  const cfg = CFG.entryIdeas.slowLeverageSqueeze;
  if (!cfg?.enabled) return { ok: false, reason: 'slow_squeeze_disabled' };
  const need = Math.max(cfg.oiCandles + 1, cfg.breakLookbackCandles + 1);
  if (!Array.isArray(points) || points.length < need) return { ok: false, reason: 'slow_squeeze_warmup' };

  const oiWindow = points.slice(-(cfg.oiCandles + 1));
  const prevBreakWindow = points.slice(-(cfg.breakLookbackCandles + 1), -1);
  const prevHighs = prevBreakWindow.map((pt) => asNum(pt?.h ?? pt?.p)).filter((x) => x != null);
  if (!prevHighs.length) return { ok: false, reason: 'slow_squeeze_missing_highs' };

  const recentHigh = Math.max(...prevHighs);
  const oiRiseCount = countOiRiseIntervals(oiWindow);
  const pricePct = priceChangePctBetweenPoints(oiWindow[0], oiWindow[oiWindow.length - 1]);
  const breakout = Number.isFinite(price) && price > recentHigh;
  const compressionOk = Number.isFinite(pricePct) && pricePct > 0 && pricePct < cfg.maxPricePct;
  const oiOk = oiRiseCount >= cfg.minOiRiseCount;

  if (breakout && compressionOk && oiOk) {
    return {
      ok: true,
      reason: 'slow_leverage_squeeze_long',
      entryLine: `slow leverage squeeze: OI rose ${oiRiseCount}/${cfg.oiCandles} candles, price compressed, then broke ${fmtPrice(recentHigh)}`,
      detail: { recentHigh, oiRiseCount, pricePct },
    };
  }

  return { ok: false, reason: 'slow_squeeze_not_ready', detail: { recentHigh, oiRiseCount, pricePct, breakout, compressionOk, oiOk } };
}

function slowShortBreakdownCheck(points, price, fundingRate) {
  const cfg = CFG.entryIdeas.slowShortBreak;
  if (!cfg?.enabled) return { ok: false, reason: 'slow_short_disabled' };
  const need = Math.max(cfg.oiRiseCandles + 1, cfg.breakLookbackCandles + 1);
  if (!Array.isArray(points) || points.length < need) return { ok: false, reason: 'slow_short_warmup' };

  const oiWindow = points.slice(-(cfg.oiRiseCandles + 1));
  const prevBreakWindow = points.slice(-(cfg.breakLookbackCandles + 1), -1);
  const prevLows = prevBreakWindow.map((pt) => asNum(pt?.l ?? pt?.p)).filter((x) => x != null);
  if (!prevLows.length) return { ok: false, reason: 'slow_short_missing_lows' };

  const recentLow = Math.min(...prevLows);
  const oiRiseCount = countOiRiseIntervals(oiWindow);
  const pricePct = priceChangePctBetweenPoints(oiWindow[0], oiWindow[oiWindow.length - 1]);
  const fundingOk = Number.isFinite(fundingRate) && fundingRate > cfg.fundingMin;
  const oiOk = oiRiseCount >= cfg.oiRiseCandles;
  const driftOk = Number.isFinite(pricePct) && Math.abs(pricePct) < cfg.maxPricePct;
  const breakdown = Number.isFinite(price) && price < recentLow;

  if (fundingOk && oiOk && driftOk && breakdown) {
    return {
      ok: true,
      reason: 'slow_short_breakdown',
      entryLine: `funding stretched + OI rose ${oiRiseCount}/${cfg.oiRiseCandles} candles + broke ${fmtPrice(recentLow)}`,
      detail: { recentLow, oiRiseCount, pricePct, fundingRate },
    };
  }

  return { ok: false, reason: 'slow_short_not_ready', detail: { recentLow, oiRiseCount, pricePct, fundingRate, fundingOk, oiOk, driftOk, breakdown } };
}

// bias logic (mode intent)
function biasFromItem(item, mode) {
  const m = String(mode || "scalp").toLowerCase();

  const lean5m = String(item?.deltas?.["5m"]?.lean || item?.lean || "neutral").toLowerCase();
  const lean15m = String(item?.deltas?.["15m"]?.lean || lean5m || "neutral").toLowerCase();
  const lean1h = String(item?.deltas?.["1h"]?.lean || lean15m || "neutral").toLowerCase();
  const lean4h = String(item?.deltas?.["4h"]?.lean || lean1h || "neutral").toLowerCase();

  if (m === "build") return lean4h;
  if (m === "swing") return lean1h;
  return lean5m;
}

// B1 edge check
function edgeRecoCheck({ bias, levels, price, edgePct }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { strong: false, reason: "1h_warmup" };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const p = asNum(price);
  if (hi == null || lo == null || p == null) return { strong: false, reason: "missing_levels" };

  const range = hi - lo;
  if (!(range > 0)) return { strong: false, reason: "bad_range" };

  const edge = edgePct * range;

  if (bias === "long") {
    const ok = p <= lo + edge;
    return { strong: ok, reason: ok ? "long_near_low" : "long_not_near_low", edge, hi, lo };
  }
  if (bias === "short") {
    const ok = p >= hi - edge;
    return { strong: ok, reason: ok ? "short_near_high" : "short_not_near_high", edge, hi, lo };
  }
  return { strong: false, reason: "neutral_bias" };
}

function strongRecoB1({ bias, levels, price }) {
  return edgeRecoCheck({ bias, levels, price, edgePct: CFG.strongEdgePct1h });
}

// --- Leverage suggestion (advisory) ---
// Base = floor(riskBudgetPct / distance_to_invalidation_pct)
// Then reduce if OI is jumpy or funding is stretched.
function computeLeverageFromStop({ mode, entryPrice, stopLossPx, item, dynamicRisk = null }) {
  if (!CFG.leverage?.enabled) return null;

  const m = String(mode || "scalp").toLowerCase();
  const baseRiskBudgetPct = CFG.leverage?.riskBudgetPctByMode?.[m] ?? 1.0;
  const riskBudgetPct =
    dynamicRisk && Number.isFinite(Number(dynamicRisk.effectiveRiskPct))
      ? Number(dynamicRisk.effectiveRiskPct)
      : baseRiskBudgetPct;

  const entry = asNum(entryPrice);
  const sl = asNum(stopLossPx);
  if (entry == null || sl == null) return null;

  const stopDistPct = Math.abs((entry - sl) / entry) * 100;
  if (!Number.isFinite(stopDistPct) || stopDistPct <= 0) return null;

  const baseMax = Math.floor(
    Math.max(0, Number(riskBudgetPct) || 0) / Math.max(0.01, stopDistPct)
  );

  const oi5 = Math.abs(asNum(item?.deltas?.["5m"]?.oi_change_pct) ?? 0);
  const oi15 = Math.abs(asNum(item?.deltas?.["15m"]?.oi_change_pct) ?? 0);

  let oiMult = 1;
  if (oi5 > CFG.leverage.oiReduce2 || oi15 > CFG.leverage.oiReduce2) oiMult = 0.6;
  else if (oi5 > CFG.leverage.oiReduce1 || oi15 > CFG.leverage.oiReduce1) oiMult = 0.75;

  const funding = Math.abs(asNum(item?.funding_rate) ?? 0);

  let fMult = 1;
  if (funding > CFG.leverage.fundingReduce2) fMult = 0.6;
  else if (funding > CFG.leverage.fundingReduce1) fMult = 0.8;

  const adjustedMax = Math.max(
    1,
    Math.min(Math.floor(baseMax * oiMult * fMult), CFG.leverage.maxCap)
  );

  return {
    suggestedLow: Math.max(1, Math.floor(adjustedMax * 0.5)),
    suggestedHigh: adjustedMax,
    adjustedMax,
    stopDistPct,
    riskBudgetPct,
    baseRiskBudgetPct,
    flags: { oiReduced: oiMult < 1, fundingReduced: fMult < 1 },
    dynamicRisk: dynamicRisk || null,
  };
}

/**
 * CONFIDENCE ENGINE (rule-based, mechanical)
 *
 * Architecture:
 * - selectors decide whether an archetype is allowed to fire
 * - modifiers shape score only after a selector is valid
 * - external-market fields are telemetry-only; they do not shape selectors, confidence, or TG copy
 */
function getTradeProfile(t) {
  const mode = String(t?.mode || "").toLowerCase();
  const bias = String(t?.bias || "").toLowerCase();
  const execReason = String(t?.execReason || "").toLowerCase();
  const b1Strong = !!t?.b1?.strong;

  const reversalConfirmed =
    execReason.includes("b1_reversal") ||
    execReason.includes("wick_reclaim") ||
    execReason.includes("wick_reject") ||
    execReason.includes("wick_flush_reclaim") ||
    execReason.includes("wick_spike_reject") ||
    execReason.includes("liquidity_snap_reversal");

  const liquiditySnap = execReason.includes("liquidity_snap_reversal");
  const wickDriven = execReason.includes("wick");
  const flowPersists =
    execReason.includes("flow_persists_long") ||
    execReason.includes("flow_persists_short") ||
    execReason.includes("flow_persists");

  const pureBreakoutOnly =
    execReason.includes("break_above_") ||
    execReason.includes("break_below_");

  const structuredBreakout =
    execReason.includes("ignition_breakout") ||
    execReason.includes("slow_leverage_squeeze") ||
    execReason.includes("slow_short_breakdown");

  const lean15m = String(t?.ctx?.lean15m || "").toLowerCase();
  const lean1h = String(t?.ctx?.lean1h || "").toLowerCase();
  const oi15 = asNum(t?.ctx?.oi15);
  const oiAligned = lean15m === bias;
  const oiNeutral =
    lean15m === "neutral" ||
    lean15m === "" ||
    (Number.isFinite(oi15) && Math.abs(oi15) < CFG.shockOi15mPct);
  const oiWeak = !oiAligned && !oiNeutral;
  const oneHourAligned = lean1h === bias;
  const counter1hLean = lean1h && lean1h !== "neutral" && !oneHourAligned;

  const wickMeta = t?.ctx?.wickMeta || {};
  const wickStrong = !!wickMeta?.strong;
  const wickExtreme = !!wickMeta?.extreme;

  const bottoming = t?.ctx?.bottoming || {};
  const bottomingScore = asNum(bottoming?.score);
  const strongBottoming =
    !!bottoming?.triggered &&
    Number.isFinite(bottomingScore) &&
    bottomingScore >= CFG.bottoming.scoreMin;

  const btcTapeState = String(t?.ctx?.btcTapeState || "neutral").toLowerCase();
  const btcPrice5mPct = asNum(t?.ctx?.btc5mPrice5mPct);
  const btcPrice15mPct = asNum(t?.ctx?.btc5mPrice15mPct);
  const btcOi5mPct = asNum(t?.ctx?.btc5mOi5mPct);
  const btcOi15mPct = asNum(t?.ctx?.btc5mOi15mPct);
  const anomalyPattern = String(t?.ctx?.anomalyPattern || "").toLowerCase();
  const anomalyOiPct = asNum(t?.ctx?.anomalyOiPct);

  return {
    mode,
    bias,
    execReason,
    b1Strong,
    reversalConfirmed,
    liquiditySnap,
    wickDriven,
    flowPersists,
    pureBreakoutOnly,
    structuredBreakout,
    lean15m,
    lean1h,
    oi15,
    oiAligned,
    oiNeutral,
    oiWeak,
    oneHourAligned,
    counter1hLean,
    wickStrong,
    wickExtreme,
    strongBottoming,
    btcTapeState,
    btcPrice5mPct,
    btcPrice15mPct,
    btcOi5mPct,
    btcOi15mPct,
    anomalyPattern,
    anomalyOiPct,
  };
}

function classifySelectorFamily(profile) {
  const p = profile || {};
  if (p.mode === "swing" && p.bias === "long" && p.liquiditySnap) return "swing_long_liquidity_snap";
  if (p.mode === "swing" && p.bias === "long" && p.reversalConfirmed) return "swing_long_reversal";
  if (p.mode === "swing" && p.bias === "long" && p.flowPersists) return "swing_long_flow_persists";
  if (p.mode === "swing" && p.bias === "short" && p.flowPersists) return "swing_short_flow_persists";
  if (p.mode === "swing" && p.bias === "short" && p.structuredBreakout) return "swing_short_continuation";
  if (p.mode === "swing" && p.bias === "short" && p.reversalConfirmed) return "swing_short_reversal";
  if (p.pureBreakoutOnly) return "pure_breakout_only";
  if (p.structuredBreakout) return "structured_breakout";
  return "generic";
}

function evaluateSelectorPolicy(t) {
  const profile = getTradeProfile(t);
  const family = classifySelectorFamily(profile);
  const reasons = [];

  if (profile.mode === "build" && profile.execReason === "build_b1_reversal_short") {
    reasons.push("suppressed_build_b1_reversal_short");
  }

  if (profile.mode === "build" && profile.execReason === "build_flow_persists_long") {
    reasons.push("suppressed_build_flow_persists_long");
  }

 if (profile.mode === "swing" && profile.bias === "short" && profile.reversalConfirmed) {
  reasons.push("short_reversal_disabled");
}

  if (profile.pureBreakoutOnly) {
    reasons.push("pure_breakout_only_disabled");
  }

  if (profile.mode === "swing" && profile.bias === "long" && profile.flowPersists && !profile.reversalConfirmed) {
    // This family remains analytics-only while it is revalidated. Do not let the
    // retired external aggregate accidentally become a path back to TG eligibility.
    reasons.push("swing_long_flow_persists_demoted");
    if (profile.btcTapeState === "long_hostile") reasons.push("flow_persists_long_btc_hostile");
  }

    const shortContinuationStyle =
    profile.mode === "swing" &&
    profile.bias === "short" &&
    !profile.reversalConfirmed &&
    (profile.flowPersists || profile.structuredBreakout || profile.pureBreakoutOnly);

  if (shortContinuationStyle) {
    if (!Number.isFinite(profile.anomalyOiPct)) {
      reasons.push("short_continuation_needs_anomaly_oi");
    } else if (profile.anomalyOiPct >= 0) {
      reasons.push("short_continuation_needs_negative_anomaly_oi");
    }
  }

  return {
    allowed: reasons.length === 0,
    family,
    profile,
    reasons,
    reason: reasons.join("|"),
  };
}

function getAnomalyPatternAdj(profile) {
  const p = String(profile?.anomalyPattern || "").toLowerCase();
  const side = String(profile?.bias || "").toLowerCase();
  if (side === "short") {
    if (p === "long_liq") return 0.4;
    if (p === "short_build") return -0.35;
    if (p === "long_build") return -0.2;
    if (p === "short_squeeze") return 0.05;
    return 0;
  }

  if (p === "long_liq") return 0.2;
  if (p === "short_build") return -0.2;
  if (p === "long_build") return -0.05;
  if (p === "short_squeeze") return 0.05;
  return 0;
}

function computeConfidenceBase(t) {
  const p = getTradeProfile(t);

  if (p.bias === "short" && p.flowPersists && p.strongBottoming) return "C";

  if (p.mode === "swing" && p.bias === "long") {
    if (p.liquiditySnap && p.b1Strong && p.oiAligned && p.oneHourAligned) return "A";
    if (p.reversalConfirmed && p.b1Strong && p.oiAligned && (p.oneHourAligned || p.strongBottoming)) return "A";
    if (p.liquiditySnap && (p.oiAligned || p.oneHourAligned)) return "B";
    if (p.reversalConfirmed && !p.counter1hLean && (p.oiAligned || p.oneHourAligned || p.wickStrong)) return "B";
    if ((p.flowPersists || p.structuredBreakout) && p.oiAligned && p.oneHourAligned) return "C";
    if ((p.flowPersists || p.structuredBreakout) && (p.oiAligned || p.oneHourAligned)) return "C";
    return "C";
  }

  if (p.mode === "swing" && p.bias === "short") {
    if (p.reversalConfirmed) return "C";
    if ((p.flowPersists || p.structuredBreakout) && p.oiAligned && p.oneHourAligned) return "B";
    if ((p.flowPersists || p.structuredBreakout) && (p.oiAligned || p.oneHourAligned)) return "C";
    return "C";
  }

  if (p.b1Strong && p.reversalConfirmed && p.oiAligned && p.oneHourAligned) return "A";
  if (p.b1Strong && p.reversalConfirmed && (p.oiAligned || p.oneHourAligned)) return "B";
  if ((p.flowPersists || p.structuredBreakout) && (p.oiAligned || p.oneHourAligned)) return "C";
  return "C";
}

function confidenceScoreFromLabel(label) {
  if (label === "A") return 3;
  if (label === "B") return 2;
  return 1;
}

function confidenceLabelFromScore(score) {
  if (score >= 2.5) return "A";
  if (score >= 1.5) return "B";
  return "C";
}

function computeConfidence(t) {
  const profile = getTradeProfile(t);
  const selectorPolicy = evaluateSelectorPolicy(t);
  const baseConfidence = computeConfidenceBase(t);
  const baseScore = confidenceScoreFromLabel(baseConfidence);
  // Legacy external aggregate intentionally retired. Keep the published field at
  // zero for schema compatibility, while raw metrics remain in telemetry columns.
  const extAdj = 0;
  const anomalyPatternAdj = getAnomalyPatternAdj(profile);
  const btcShortTfSignal = getBtcShortTfSignal(profile);

  let adjustedScore = Number((baseScore + anomalyPatternAdj + btcShortTfSignal.confidenceAdj).toFixed(2));

  if (profile.mode === "swing" && profile.bias === "long" && profile.liquiditySnap) {
    adjustedScore += 0.5;
  } else if (profile.mode === "swing" && profile.bias === "long" && profile.reversalConfirmed) {
    adjustedScore += 0.25;
  }

  if (profile.mode === "swing" && profile.bias === "short" && profile.reversalConfirmed) {
    adjustedScore -= 0.75;
  }

  if (profile.mode === "swing" && profile.bias === "short" && profile.flowPersists && profile.oiAligned && profile.oneHourAligned) {
    adjustedScore += 0.25;
  }

  if (profile.pureBreakoutOnly) adjustedScore -= 0.5;
  if (profile.bias === "long" && profile.btcTapeState === "long_hostile") adjustedScore -= 0.25;
  if (profile.bias === "short" && profile.btcTapeState === "short_hostile") adjustedScore -= 0.25;

  const shortContinuationStyle =
    profile.mode === "swing" &&
    profile.bias === "short" &&
    !profile.reversalConfirmed &&
    (profile.flowPersists || profile.structuredBreakout || profile.pureBreakoutOnly);

  if (shortContinuationStyle && Number.isFinite(profile.anomalyOiPct) && profile.anomalyOiPct >= 0) {
    adjustedScore -= 0.35;
  }

  if (profile.mode === "swing" && profile.bias === "long" && profile.flowPersists && !profile.reversalConfirmed) {
    adjustedScore = Math.min(adjustedScore, 2.49);
  }

  if (profile.mode === "swing" && profile.bias === "short" && profile.reversalConfirmed) {
    adjustedScore = Math.min(adjustedScore, 1.49);
  }

  if (profile.bias === "short" && profile.flowPersists && profile.strongBottoming) {
    adjustedScore = Math.min(adjustedScore, 1.49);
  }

  if (!selectorPolicy.allowed) {
    adjustedScore = Math.min(adjustedScore, 1.49);
  }

  const finalScore = Number(adjustedScore.toFixed(2));
  const finalConfidence = confidenceLabelFromScore(finalScore);

  return {
    baseConfidence,
    baseScore,
    extAdj,
    anomalyPatternAdj,
    btcShortTfSignal,
    finalScore,
    finalConfidence,
    externalBias: "neutral",
    selectorFamily: selectorPolicy.family,
    selectorAllowed: selectorPolicy.allowed,
    selectorReason: selectorPolicy.reason,
  };
}
function prettifyDecisionToken(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\|/g, " + ")
    .trim();
}

function describeSelectorFamily(family, profile) {
  const f = String(family || "").toLowerCase();
  if (f === "swing_long_liquidity_snap") return "liquidity snap long";
  if (f === "swing_long_reversal") return "reversal long";
  if (f === "swing_long_flow_persists") return "flow persists long";
  if (f === "swing_short_flow_persists") return "flow persists short";
  if (f === "swing_short_continuation") return "short continuation";
  if (f === "swing_short_reversal") return "short reversal";
  if (f === "pure_breakout_only") return "pure breakout only";
  if (f === "structured_breakout") return "structured breakout";
  if (profile?.bias === "long") return "long setup";
  if (profile?.bias === "short") return "short setup";
  return "setup";
}

function getModelDecisionLabel(confidenceMeta) {
  if (confidenceMeta?.selectorAllowed === false) return "REJECTED";
  const label = String(confidenceMeta?.finalConfidence || "").toUpperCase();
  if (label === "A") return "PROMOTED";
  if (label === "B") return "VALID";
  return "CAPPED";
}

function buildModelDecisionReason(t, confidenceMeta) {
  const profile = getTradeProfile(t);
  if (confidenceMeta?.selectorAllowed === false && confidenceMeta?.selectorReason) {
    return prettifyDecisionToken(confidenceMeta.selectorReason);
  }

  const parts = [];
  parts.push(describeSelectorFamily(confidenceMeta?.selectorFamily, profile));

  const anomalyAdj = Number(confidenceMeta?.anomalyPatternAdj || 0);
  if (anomalyAdj > 0.1) parts.push("anomaly support");
  else if (anomalyAdj < -0.1) parts.push("anomaly drag");

  if (profile.oneHourAligned) parts.push("1h aligned");
  else if (profile.counter1hLean) parts.push("counter 1h lean");

  if (profile.mode === "swing" && profile.bias === "long" && profile.reversalConfirmed) {
    parts.push("reversal confirmed");
  }

  const unique = [];
  for (const part of parts) {
    const text = String(part || "").trim();
    if (!text || unique.includes(text)) continue;
    unique.push(text);
  }

  return unique.slice(0, 3).join(" + ") || "base setup";
}

function sideSignedMove(value, side) {
  const n = asNum(value);
  if (!Number.isFinite(n)) return null;
  return String(side || "").toLowerCase() === "short" ? -n : n;
}

function getBtcShortTfSignal(profile) {
  if (!CFG.btcShortTf?.enabled) {
    return { state: "off", label: "off", confidenceAdj: 0, reasons: [], cautions: [] };
  }

  const side = String(profile?.bias || "").toLowerCase();
  if (side !== "long" && side !== "short") {
    return { state: "neutral", label: "BTC short-TF neutral", confidenceAdj: 0, reasons: [], cautions: [] };
  }

  const p5 = sideSignedMove(profile?.btcPrice5mPct, side);
  const p15 = sideSignedMove(profile?.btcPrice15mPct, side);
  const min5 = Number(CFG.btcShortTf.price5mMinPct || 0);
  const min15 = Number(CFG.btcShortTf.price15mMinPct || 0);
  const reasons = [];
  const cautions = [];

  if (Number.isFinite(p15)) {
    if (p15 >= min15) reasons.push("BTC 15m aligned");
    else if (p15 <= -min15) cautions.push("BTC 15m hostile");
  }

  if (Number.isFinite(p5)) {
    if (p5 >= min5) reasons.push("BTC 5m aligned");
    else if (p5 <= -min5) cautions.push("BTC 5m hostile");
  }

  let state = "neutral";
  let confidenceAdj = 0;

  if (cautions.some((x) => x.includes("15m"))) {
    state = "hostile";
    confidenceAdj = -Math.abs(Number(CFG.btcShortTf.confidencePenalty || 0));
  } else if (reasons.some((x) => x.includes("15m")) && cautions.length === 0) {
    state = reasons.some((x) => x.includes("5m")) ? "strong_support" : "support";
    confidenceAdj = Math.abs(Number(CFG.btcShortTf.confidenceBoost || 0));
  } else if (cautions.length > 0) {
    state = "minor_hostile";
    confidenceAdj = -Math.abs(Number(CFG.btcShortTf.confidencePenalty || 0)) / 2;
  } else if (reasons.length > 0) {
    state = "minor_support";
    confidenceAdj = Math.abs(Number(CFG.btcShortTf.confidenceBoost || 0)) / 2;
  }

  return {
    state,
    label: state.replace(/_/g, " "),
    confidenceAdj: Number(confidenceAdj.toFixed(2)),
    reasons,
    cautions,
  };
}

function computeTradeRead({ t, confidenceMeta, rrInfo }) {
  const profile = getTradeProfile(t);
  const btcShortTf = confidenceMeta?.btcShortTfSignal || getBtcShortTfSignal(profile);
  const modelDecision = getModelDecisionLabel(confidenceMeta);
  const positives = [];
  const cautions = [];
  let score = 0;

  if (confidenceMeta?.selectorAllowed === false) {
    return {
      label: "WEAK",
      emoji: "❌",
      summary: "selector rejected",
      positives: [],
      cautions: [prettifyDecisionToken(confidenceMeta?.selectorReason || "selector rejected")],
    };
  }

  if (modelDecision === "PROMOTED") score += 1;
  else if (modelDecision === "VALID") score += 0.5;

  if (profile.mode === "swing" && profile.bias === "long") {
    if (profile.liquiditySnap) {
      score += 2;
      positives.push("liquidity snap reversal");
    } else if (profile.reversalConfirmed) {
      score += 1.5;
      positives.push("reversal confirmed");
    } else if (profile.flowPersists) {
      score -= 0.5;
      cautions.push("generic continuation");
    }

    if (profile.oneHourAligned) {
      score += 1;
      positives.push("1h aligned");
    } else if (profile.counter1hLean) {
      score -= 1;
      cautions.push("counter 1h lean");
    }
  } else if (profile.mode === "swing" && profile.bias === "short") {
    if (Number.isFinite(profile.anomalyOiPct) && profile.anomalyOiPct < 0) {
      score += 2;
      positives.push("negative anomaly OI");
    } else {
      score -= 2;
      cautions.push("no negative anomaly OI");
    }

    if (profile.strongBottoming) {
      score -= 2;
      cautions.push("bottoming warning");
    }

    if (profile.oneHourAligned) {
      score += 1;
      positives.push("1h aligned");
    } else if (profile.counter1hLean) {
      score -= 1;
      cautions.push("counter 1h lean");
    }

  }

  if (btcShortTf.state === "strong_support") {
    score += 1.5;
    positives.push("BTC 5/15 aligned");
  } else if (btcShortTf.state === "support") {
    score += 1;
    positives.push("BTC 15m aligned");
  } else if (btcShortTf.state === "hostile") {
    score -= 1.5;
    cautions.push("BTC 15m hostile");
  } else if (btcShortTf.state === "minor_hostile") {
    score -= 0.75;
    cautions.push("BTC 5m hostile");
  }

  let label = "MIXED";
  let emoji = "⚠️";
  if (score >= 4 && cautions.length <= 1) {
    label = "GOOD";
    emoji = "✅";
  } else if (score <= 1 || cautions.length >= 3) {
    label = "WEAK";
    emoji = "❌";
  }

  return {
    label,
    emoji,
    score: Number(score.toFixed(2)),
    summary: positives.slice(0, 3).join(" + ") || "limited confirmed edge",
    cautions: [...new Set(cautions)].slice(0, 3),
  };
}
function tradeStamp(label, reason, profile) {
  const cleanLabel = String(label || "").toUpperCase();
  const emoji = cleanLabel === "PREMIUM" ? "✅" : "";
  return { label: cleanLabel, emoji, reason, profile };
}

function premiumStamp(label, reason, profile) {
  return tradeStamp(label, reason, profile);
}

function isSendableTradeStamp(recipeStamp) {
  const label = String(recipeStamp?.label || "").toUpperCase();
  return label === "PREMIUM";
}


const LIVE_MANUAL_RECIPES = Object.freeze([
  Object.freeze({
    id: "swing_eth_relative_weakness_btc_funding_long",
    mode: "swing",
    side: "long",
    profile: "Swing Long: ETH-relative washout + elevated BTC funding",
    managementHint: "Harvest at the due-window move; runner only with clean follow-through.",
    matches: (t) => {
      const vsEth1h = asNum(t?.ctx?.symbolVsEth1hPct);
      const btcFunding15 = asNum(t?.ctx?.btc5mFunding15mAvg);
      return (
        Number.isFinite(vsEth1h) &&
        vsEth1h <= -0.35 &&
        Number.isFinite(btcFunding15) &&
        btcFunding15 >= 0.00008
      );
    },
    rankValue: (t) => asNum(t?.ctx?.symbolVsEth1hPct),
    rankMetric: (t) => `vs ETH 1h ${fmtPct(t?.ctx?.symbolVsEth1hPct, 3)}`,
    marketContext: (t) => [`BTC funding 15m avg ${formatFundingRate(t?.ctx?.btc5mFunding15mAvg)}`],
  }),
  Object.freeze({
    id: "swing_breadth_btc_oi_unwind_eth_lag_short",
    mode: "swing",
    side: "short",
    profile: "Swing Short: extreme breadth + BTC OI unwind + ETH-relative lag",
    managementHint: "Validate quickly; take partials by the due window and extend only with downside follow-through.",
    matches: (t) => {
      const breadth = asNum(t?.ctx?.cryptoBreadth1hPct);
      const btcOi60 = asNum(t?.ctx?.btc5mOi60mPct);
      const vsEth1h = asNum(t?.ctx?.symbolVsEth1hPct);
      return (
        Number.isFinite(breadth) &&
        breadth >= 80 &&
        Number.isFinite(btcOi60) &&
        btcOi60 <= -0.35 &&
        Number.isFinite(vsEth1h) &&
        vsEth1h <= 0
      );
    },
    rankValue: (t) => asNum(t?.ctx?.symbolVsEth1hPct),
    rankMetric: (t) => `vs ETH 1h ${fmtPct(t?.ctx?.symbolVsEth1hPct, 3)}`,
    marketContext: (t) => [
      `Breadth 1h ${fmtPct(t?.ctx?.cryptoBreadth1hPct, 1)}`,
      `BTC OI 60m ${fmtPct(t?.ctx?.btc5mOi60mPct, 3)}`,
    ],
  }),
]);

const LIVE_MANUAL_RECIPE_BY_ID = new Map(LIVE_MANUAL_RECIPES.map((recipe) => [recipe.id, recipe]));

function getLiveManualRecipe(recipeId) {
  return LIVE_MANUAL_RECIPE_BY_ID.get(String(recipeId || "")) || null;
}

function getRecipeShortlistSize() {
  const configured = Number(CFG.recipeRouting?.shortlistSize);
  if (!Number.isFinite(configured)) return 3;
  return Math.max(1, Math.min(5, Math.floor(configured)));
}

function getRecipeCooldownMinutes(recipe) {
  const configured = Number(CFG.recipeRouting?.cooldownMinutesByMode?.[recipe?.mode]);
  const fallback = recipe?.mode === "swing" ? 240 : 60;
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

function formatFundingRate(value) {
  const n = asNum(value);
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(6);
}

function sortManualRecipeCandidates(recipe, candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const av = asNum(recipe?.rankValue?.(a));
    const bv = asNum(recipe?.rankValue?.(b));
    if (Number.isFinite(av) && Number.isFinite(bv) && av !== bv) return av - bv;
    if (Number.isFinite(av) && !Number.isFinite(bv)) return -1;
    if (!Number.isFinite(av) && Number.isFinite(bv)) return 1;
    return String(a?.symbol || "").localeCompare(String(b?.symbol || ""));
  });
}

function buildRankedRecipeTelegramMessage(recipe, selections) {
  const ranked = selections || [];
  if (!recipe || ranked.length === 0) return "";

  const header = `⚡️ ${String(recipe.mode || "").toUpperCase()} ${String(recipe.side || "").toUpperCase()}`;
  const lines = [header, `PREMIUM ✅ | ${recipe.profile}`, ""];

  ranked.forEach((selection, index) => {
    const t = selection?.t || {};
    const reminder = selection?.repeatDecision?.isReminder ? " | Reminder" : "";
    const metric = recipe.rankMetric?.(t) || "";
    lines.push(`${index + 1}. ${t.symbol} — Entry ${fmtPrice(t.price)}${reminder}`);
    if (metric) lines.push(`   ${metric}`);
  });

  const contextLines = recipe.marketContext?.(ranked[0]?.t) || [];
  if (contextLines.length) {
    lines.push("");
    lines.push(`Market: ${contextLines.join(" | ")}`);
  }
  if (recipe.managementHint) lines.push(`Mgmt: ${recipe.managementHint}`);

  return lines.join("\n");
}

function buildManagementHint(t, recipeStamp) {
  const mode = String(t?.mode || "").toLowerCase();
  const bias = String(t?.bias || "").toLowerCase();
  const execReason = String(t?.execReason || "").toLowerCase();
  const recipeReason = String(recipeStamp?.reason || "").toLowerCase();
  const liveRecipe = getLiveManualRecipe(execReason);
  if (liveRecipe?.managementHint) return liveRecipe.managementHint;

  // Former TG pilots remain analytics-only during revalidation; do not attach
  // unvalidated management language to either family.

  if (recipeReason.includes("scalp_short_anomaly")) {
    return "Fast TP; exit if downside stalls.";
  }

  if (mode === "swing" && execReason === "swing_ignition_breakout_long") {
    return "Take partials into strength; runner only with follow-through.";
  }

  if (mode === "swing" && execReason === "swing_flow_persists_short") {
    return "Fast validation; exit if downside stalls.";
  }

  if (mode === "swing" && execReason === "swing_flow_persists_long") {
    return "Standard hold; runner only if MFE expands cleanly.";
  }

  if (mode === "scalp") {
    return bias === "short"
      ? "Fast scalp; cover quickly if downside stalls."
      : "Fast scalp; take profit quickly if follow-through stalls.";
  }

  if (recipeReason) {
    return "Manual management; do not blindly hold to due window.";
  }

  return "";
}

function compactTradeWatch(tradeRead) {
  // TG is Premium-only and should not surface generic analytical cautions.
  // Invalidating conditions belong in recipe gates; non-invalidating cautions stay in analytics.
  return "";
}

function isTruthyBoolean(value) {
  return value === true || String(value).toLowerCase() === "true" || String(value) === "1";
}

function computeRecipeStamp({ t, confidenceMeta, entryAtoms = {} }) {
  const mode = String(t?.mode || "").toLowerCase();
  const bias = String(t?.bias || "").toLowerCase();
  const execReason = String(t?.execReason || "").toLowerCase();
  const liveRecipe = getLiveManualRecipe(execReason);

  // Dedicated pooled-history recipes are complete routes. They intentionally do
  // not depend on the legacy selector or execution families, but the exact
  // approved predicate is rechecked here before granting Premium status.
  if (
    t?.analyticsOnly !== true &&
    liveRecipe &&
    liveRecipe.mode === mode &&
    liveRecipe.side === bias &&
    liveRecipe.matches(t)
  ) {
    return premiumStamp("PREMIUM", liveRecipe.id, liveRecipe.profile);
  }

  if (confidenceMeta?.selectorAllowed === false) {
    return { label: "", emoji: "", reason: "selector_rejected", profile: "" };
  }

  // Manual TG stance: Scalp/Swing only. Build is research-only.
  if (mode === "build") {
    return { label: "", emoji: "", reason: "build_manual_research_only", profile: "" };
  }

  // The former V9 Swing Short continuation route is intentionally demoted to
  // analytics-only. No legacy route can grant Premium status in V10.
  return { label: "", emoji: "", reason: "no_validated_manual_recipe", profile: "" };
}

const BLOCKED_PROMOTION_CANDIDATE_STAMPS = new Set([
  "suppressed_scalp_long_breadth_spotperp_washout",
  "suppressed_scalp_short_btc_oi_relative_lag",
  "suppressed_swing_long_liquidity_snap_revalidation",
  "suppressed_swing_long_flow_persists_long",
  "suppressed_swing_long_ignition_breakout_long",
  "suppressed_swing_long_btc_oi_compression_long",
  "candidate_swing_short_anom_oi_negative_btc15_negative",
]);

function addCandidateStamp(stamps, label, reason, profile) {
  const promotionBlocked = BLOCKED_PROMOTION_CANDIDATE_STAMPS.has(label);
  stamps.push({
    label,
    reason: promotionBlocked ? `promotion_blocked:${reason}` : reason,
    profile: promotionBlocked ? `Blocked: ${profile}` : profile,
    promotionBlocked,
  });
}

function computeCandidateStamps({ t, confidenceMeta, entryAtoms = {} }) {
  const stamps = [];
  const mode = String(t?.mode || "").toLowerCase();
  const bias = String(t?.bias || "").toLowerCase();

  // Candidate stamps are analytics-only. They must not grant TG/Premium eligibility.
  if (mode === "build") return stamps;

  const anomalyOiPct = asNum(t?.ctx?.anomalyOiPct);
  const anomalyPricePct = asNum(t?.ctx?.anomalyPricePct);
  const anomalyBasketOiPct = asNum(t?.ctx?.anomalyBasketOiPct);
  const anomalyPattern = String(t?.ctx?.anomalyPattern || "").toLowerCase();
  const anomalyScore = asNum(t?.ctx?.anomalyScore);
  const anomalyRank = asNum(t?.ctx?.anomalyRank);
  const anomalyFundingRate = asNum(t?.ctx?.anomalyFundingRate);
  const anomalyOiTrendDeviation = asNum(t?.ctx?.anomalyOiTrendDeviation);
  const coinDayPct = asNum(t?.ctx?.coinDayPct);
  const vixDayPct = asNum(t?.ctx?.vixDayPct);
  const dxyDayPct = asNum(t?.ctx?.dxyDayPct);
  const spxDayPct = asNum(t?.ctx?.spxDayPct);
  const btc15mPct = asNum(t?.ctx?.btc5mPrice15mPct);
  const btcFunding30mAvg = asNum(t?.ctx?.btc5mFunding30mAvg);
  const btcShortTfState = String(confidenceMeta?.btcShortTfSignal?.state || "neutral").toLowerCase();
  const symbolVsBtc15mPct = asNum(t?.ctx?.symbolVsBtc15mPct);
  const symbolVsBtc1hPct = asNum(t?.ctx?.symbolVsBtc1hPct);
  const symbolVsEth1hPct = asNum(t?.ctx?.symbolVsEth1hPct);
  const cryptoBreadth15mPct = asNum(t?.ctx?.cryptoBreadth15mPct);
  const cryptoBreadth1hPct = asNum(t?.ctx?.cryptoBreadth1hPct);
  const spotVsPerp15mPct = asNum(t?.ctx?.spotVsPerp15mPct);
  const spotVsPerp1hPct = asNum(t?.ctx?.spotVsPerp1hPct);
  const bookImbalance20 = asNum(t?.ctx?.bookImbalance20);
  const spreadBps = asNum(t?.ctx?.spreadBps);
  const btcOi15mPct = asNum(t?.ctx?.btc5mOi15mPct);
  const btcOi30mPct = asNum(t?.ctx?.btc5mOi30mPct);
  const btcPrice60mPct = asNum(t?.ctx?.btc5mPrice60mPct);
  const btcOi60mPct = asNum(t?.ctx?.btc5mOi60mPct);
  const anomalyPriceOiGap = asNum(t?.ctx?.anomalyPriceOiGap);
  const marketStructureOk = isTruthyBoolean(t?.ctx?.marketStructureOk);
  const inLowBand = isTruthyBoolean(entryAtoms?.entry_atom_in_low_band);
  const inHighBand = isTruthyBoolean(entryAtoms?.entry_atom_in_high_band);

  // Demoted July 2026 Scalp routes. Preserve exact qualification as blocked,
  // analytics-only stamps so forward evidence continues without Telegram noise.
  if (
    mode === "scalp" &&
    bias === "long" &&
    Number.isFinite(cryptoBreadth1hPct) &&
    cryptoBreadth1hPct <= 10 &&
    Number.isFinite(spotVsPerp1hPct) &&
    spotVsPerp1hPct <= -0.02
  ) {
    addCandidateStamp(
      stamps,
      "suppressed_scalp_long_breadth_spotperp_washout",
      "former live Scalp Long; breadth 1h <= 10%; spot/perp 1h <= -0.02%",
      "Scalp Long: demoted breadth washout + spot/perp divergence"
    );
  }

  if (
    mode === "scalp" &&
    bias === "short" &&
    Number.isFinite(btcOi15mPct) &&
    btcOi15mPct >= 0.02 &&
    btcOi15mPct <= 0.13 &&
    Number.isFinite(symbolVsBtc15mPct) &&
    symbolVsBtc15mPct >= -0.11 &&
    symbolVsBtc15mPct <= -0.02
  ) {
    addCandidateStamp(
      stamps,
      "suppressed_scalp_short_btc_oi_relative_lag",
      "former live Scalp Short; BTC OI 15m 0.02% to 0.13%; symbol vs BTC 15m -0.11% to -0.02%",
      "Scalp Short: demoted moderate BTC OI rise + BTC-relative lag"
    );
  }

  // Regression-derived stitched candidates. These remain analytics-only and
  // use only fields already available in the live pre-entry candidate context.
  const relativeBtcAcceleration =
    Number.isFinite(symbolVsBtc15mPct) && Number.isFinite(symbolVsBtc1hPct)
      ? symbolVsBtc15mPct - symbolVsBtc1hPct / 4
      : null;

  if (
    mode === "scalp" &&
    bias === "long" &&
    Number.isFinite(anomalyRank) &&
    anomalyRank <= 3 &&
    Number.isFinite(relativeBtcAcceleration) &&
    relativeBtcAcceleration <= -0.39 &&
    Number.isFinite(anomalyPriceOiGap) &&
    anomalyPriceOiGap >= 0.36
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_long_catchup_anomaly",
      "scalp long; anomaly rank <= 3; relative BTC acceleration <= -0.39%; anomaly price/OI gap >= 0.36",
      "Scalp Long: catch-up anomaly"
    );
  }

  const btcPriceOiPressure =
    Number.isFinite(btcPrice60mPct) && Number.isFinite(btcOi60mPct)
      ? btcPrice60mPct - btcOi60mPct
      : null;
  const breadthIgnition =
    Number.isFinite(cryptoBreadth15mPct) && Number.isFinite(cryptoBreadth1hPct)
      ? cryptoBreadth15mPct - cryptoBreadth1hPct
      : null;

  if (
    mode === "scalp" &&
    bias === "long" &&
    Number.isFinite(btcPriceOiPressure) &&
    btcPriceOiPressure <= -0.21 &&
    Number.isFinite(breadthIgnition) &&
    breadthIgnition >= 1.31
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_long_breadth_ignition_btc_positioning_pressure",
      "scalp long; BTC price60 minus OI60 <= -0.21; breadth15 minus breadth1h >= 1.31 points",
      "Scalp Long: breadth ignition + BTC positioning pressure"
    );
  }

  const spotPerpAcceleration =
    Number.isFinite(spotVsPerp15mPct) && Number.isFinite(spotVsPerp1hPct)
      ? spotVsPerp15mPct - spotVsPerp1hPct / 4
      : null;

  if (
    mode === "scalp" &&
    bias === "short" &&
    Number.isFinite(spotPerpAcceleration) &&
    spotPerpAcceleration >= 0.20 &&
    Number.isFinite(anomalyOiTrendDeviation) &&
    anomalyOiTrendDeviation >= 0.34
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_short_spot_led_crowding_fade",
      "scalp short; spot/perp acceleration >= 0.20; anomaly OI-trend deviation >= 0.34",
      "Scalp Short: spot-led crowding fade"
    );
  }

  if (
    mode === "swing" &&
    bias === "long" &&
    String(t?.execReason || "").toLowerCase() === "swing_liquidity_snap_reversal_long"
  ) {
    addCandidateStamp(
      stamps,
      "suppressed_swing_long_liquidity_snap_revalidation",
      "former TG Premium; keep analytics only pending entry-quality revalidation",
      "Swing Long liquidity-snap revalidation"
    );
  }

  if (mode === "swing" && bias === "long" && String(t?.execReason || "").toLowerCase() === "swing_flow_persists_long") {
    addCandidateStamp(
      stamps,
      "suppressed_swing_long_flow_persists_long",
      "suppressed weak swing long continuation; keep analytics only",
      "Suppressed: Swing Long flow persists long"
    );
  }

  if (mode === "swing" && bias === "long" && String(t?.execReason || "").toLowerCase() === "swing_ignition_breakout_long") {
    addCandidateStamp(
      stamps,
      "suppressed_swing_long_ignition_breakout_long",
      "suppressed weak swing long breakout; keep analytics only",
      "Suppressed: Swing Long ignition breakout long"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(coinDayPct) &&
    coinDayPct <= -4.8 &&
    Number.isFinite(spxDayPct) &&
    spxDayPct <= 0
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_macro_riskoff_coin_crash_spx_weak",
      "swing short; COIN day <= -4.8%; SPX day <= 0",
      "Swing Short: macro risk-off + coin crash"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(coinDayPct) &&
    coinDayPct <= -4.8 &&
    Number.isFinite(spxDayPct) &&
    spxDayPct <= 0 &&
    Number.isFinite(dxyDayPct) &&
    dxyDayPct >= -0.05
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_macro_riskoff_coin_crash_spx_weak_dxy_firm",
      "swing short; COIN day <= -4.8%; SPX day <= 0; DXY day >= -0.05%",
      "Swing Short: macro risk-off + firm DXY"
    );
  }

  if (
    mode === "swing" &&
    bias === "long" &&
    Number.isFinite(anomalyBasketOiPct) &&
    anomalyBasketOiPct >= 0.15
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_long_basket_oi_accumulation",
      "swing long; anomaly basket OI >= 0.15%",
      "Swing Long: basket OI accumulation"
    );
  }

  if (
    mode === "swing" &&
    bias === "long" &&
    Number.isFinite(anomalyBasketOiPct) &&
    anomalyBasketOiPct >= 0.15 &&
    anomalyPattern === "mixed"
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_long_basket_oi_accumulation_mixed_anomaly",
      "swing long; anomaly basket OI >= 0.15%; anomaly pattern mixed",
      "Swing Long: basket OI accumulation + mixed anomaly"
    );
  }

  if (
    mode === "swing" &&
    bias === "long" &&
    Number.isFinite(vixDayPct) &&
    vixDayPct >= 6.8 &&
    Number.isFinite(btcFunding30mAvg) &&
    btcFunding30mAvg <= 0.000005
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_long_vix_stress_low_btc_funding_relief",
      "swing long; VIX day >= 6.8%; BTC 30m funding avg <= 0.000005",
      "Swing Long: VIX stress + low BTC funding relief"
    );
  }

  if (
    mode === "swing" &&
    bias === "long" &&
    Number.isFinite(btc15mPct) &&
    btc15mPct <= -0.25 &&
    Number.isFinite(cryptoBreadth15mPct) &&
    cryptoBreadth15mPct <= 0
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_long_btc15_breadth_washout_relief",
      "swing long; BTC15 <= -0.25%; crypto breadth 15m <= 0%",
      "Swing Long: BTC15/breadth washout relief"
    );
  }

  if (
    mode === "swing" &&
    bias === "long" &&
    Number.isFinite(btc15mPct) &&
    btc15mPct <= -0.25 &&
    Number.isFinite(cryptoBreadth15mPct) &&
    cryptoBreadth15mPct <= 0 &&
    Number.isFinite(anomalyBasketOiPct) &&
    anomalyBasketOiPct >= 0.15
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_long_btc15_breadth_washout_basket_oi_rebound",
      "swing long; BTC15 <= -0.25%; crypto breadth 15m <= 0%; anomaly basket OI >= 0.15%",
      "Swing Long: BTC/breadth washout + basket OI rebound"
    );
  }

  if (
    mode === "scalp" &&
    bias === "short" &&
    Number.isFinite(anomalyOiTrendDeviation) &&
    anomalyOiTrendDeviation >= 0.63 &&
    Number.isFinite(anomalyPricePct) &&
    anomalyPricePct >= 0.5 &&
    Number.isFinite(anomalyRank) &&
    anomalyRank <= 7
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_short_ranked_price_oi_trend_pressure",
      "scalp short; anomaly OI trend deviation >= 0.63; anomaly price >= 0.5%; anomaly rank <= 7",
      "Scalp Short: ranked price/OI trend pressure"
    );
  }

  if (
    mode === "scalp" &&
    bias === "long" &&
    Number.isFinite(anomalyPriceOiGap) &&
    anomalyPriceOiGap >= 1.0
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_long_anomaly_price_oi_gap_impulse",
      "scalp long; anomaly price/OI gap >= 1.0",
      "Scalp Long: price/OI gap impulse"
    );
  }

  if (
    mode === "scalp" &&
    bias === "long" &&
    Number.isFinite(btcOi15mPct) &&
    btcOi15mPct <= -0.155 &&
    Number.isFinite(symbolVsBtc15mPct) &&
    symbolVsBtc15mPct <= -0.335
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_long_btc_oi_flush_relative_weakness_bounce",
      "scalp long; BTC OI 15m <= -0.155%; symbol <= -0.335% vs BTC over 15m",
      "Scalp Long: BTC OI flush + relative weakness bounce"
    );
  }

  const scalpShortAnomalyClean =
    mode === "scalp" &&
    bias === "short" &&
    Number.isFinite(anomalyScore) &&
    anomalyScore >= 1.2 &&
    (!Number.isFinite(coinDayPct) || coinDayPct <= 1.0) &&
    btcShortTfState !== "hostile" &&
    btcShortTfState !== "minor_hostile";

  if (scalpShortAnomalyClean) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_short_anomaly_pressure_coin_not_hot_btc_no_hostile_no_minor_hostile",
      "scalp short anomaly pressure; coin not hot; BTC short-TF clean",
      "Scalp Short: strict anomaly pressure"
    );
  }

  if (scalpShortAnomalyClean && Number.isFinite(symbolVsBtc15mPct) && symbolVsBtc15mPct >= 0.20) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_short_anomaly_clean_rsb15_overextended",
      "scalp short anomaly pressure; BTC short-TF clean; symbol >= 0.20% vs BTC over 15m",
      "Scalp Short: anomaly + BTC-relative overextension"
    );
  }

  if (
    scalpShortAnomalyClean &&
    inLowBand &&
    Number.isFinite(anomalyPriceOiGap) &&
    anomalyPriceOiGap >= 0.51
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_short_anomaly_clean_low_band_gap",
      "scalp short anomaly pressure; BTC short-TF clean; low-band entry; anomaly price/OI gap >= 0.51",
      "Scalp Short: anomaly + low-band gap"
    );
  }

  if (
    mode === "swing" &&
    bias === "long" &&
    Number.isFinite(btcOi60mPct) &&
    btcOi60mPct <= -1 &&
    Number.isFinite(btcOi30mPct) &&
    btcOi30mPct <= -0.5
  ) {
    addCandidateStamp(
      stamps,
      "suppressed_swing_long_btc_oi_compression_long",
      "suppressed weak swing long; BTC OI 60m <= -1 and BTC OI 30m <= -0.5",
      "Swing Long BTC OI compression"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(anomalyRank) &&
    anomalyRank <= 7 &&
    Number.isFinite(anomalyFundingRate) &&
    anomalyFundingRate >= 0.00008
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_ranked_anomaly_hot_funding",
      "swing short; anomaly rank <= 7; anomaly funding rate >= 0.00008",
      "Swing Short: ranked anomaly + hot funding"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(anomalyFundingRate) &&
    anomalyFundingRate >= 0.00008 &&
    Number.isFinite(anomalyPricePct) &&
    anomalyPricePct <= -0.15
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_hot_funding_price_down",
      "swing short; anomaly funding rate >= 0.00008; anomaly price <= -0.15%",
      "Candidate: Swing Short hot funding + anomaly price down"
    );
  }


  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(btcFunding30mAvg) &&
    btcFunding30mAvg >= 0.000024
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_btc_funding_high",
      "swing short; BTC 30m average funding >= 0.000024",
      "Candidate: Swing Short high BTC funding"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(anomalyRank) &&
    anomalyRank <= 7 &&
    Number.isFinite(anomalyFundingRate) &&
    anomalyFundingRate >= 0.00008 &&
    btcShortTfState === "hostile"
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_ranked_anomaly_hot_funding_btc_hostile",
      "swing short; anomaly rank <= 7; anomaly funding rate >= 0.00008; BTC short-TF hostile",
      "Swing Short: ranked anomaly + hot funding + BTC hostile"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(symbolVsEth1hPct) &&
    symbolVsEth1hPct <= -0.25 &&
    Number.isFinite(cryptoBreadth1hPct) &&
    cryptoBreadth1hPct >= 80
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_eth1h_weak_breadth1h_strong",
      "swing short; symbol <= -0.25% vs ETH over 1h; crypto breadth 1h >= 80%",
      "Swing Short: ETH-relative weakness in strong breadth"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(symbolVsEth1hPct) &&
    symbolVsEth1hPct <= -0.25 &&
    Number.isFinite(spotVsPerp1hPct) &&
    spotVsPerp1hPct >= 0.0277
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_eth1h_weak_spotperp_high",
      "swing short; symbol <= -0.25% vs ETH over 1h; spot/perp 1h >= 0.0277",
      "Swing Short: ETH-relative weakness + spot/perp support"
    );
  }


  if (
    mode === "swing" &&
    bias === "short" &&
    Number.isFinite(anomalyOiPct) &&
    anomalyOiPct < 0 &&
    Number.isFinite(btc15mPct) &&
    btc15mPct < 0
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_anom_oi_negative_btc15_negative",
      "swing short; anomaly OI negative; BTC15 negative",
      "Swing Short: OI unwind + BTC15 down"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    inHighBand &&
    Number.isFinite(anomalyOiPct) &&
    anomalyOiPct < 0 &&
    Number.isFinite(btc15mPct) &&
    btc15mPct < 0
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_high_band_anom_oi_negative_btc15_negative",
      "swing short; high-band entry; anomaly OI negative; BTC15 negative",
      "Swing Short: high-band OI unwind"
    );
  }

  if (
    mode === "swing" &&
    bias === "short" &&
    inHighBand &&
    Number.isFinite(anomalyOiPct) &&
    anomalyOiPct < 0 &&
    Number.isFinite(btc15mPct) &&
    btc15mPct < 0
  ) {
    addCandidateStamp(
      stamps,
      "candidate_swing_short_high_band_oi_unwind_btc15_down",
      "swing short; high-band entry; anomaly OI negative; BTC15 negative",
      "Swing Short: high-band OI unwind + BTC15 down"
    );
  }


  if (
    mode === "scalp" &&
    bias === "short" &&
    Number.isFinite(btcFunding30mAvg) &&
    btcFunding30mAvg >= 0.00003 &&
    Number.isFinite(btcOi30mPct) &&
    btcOi30mPct >= -0.01
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_short_btc_funding_high_flat_oi",
      "scalp short; BTC 30m average funding >= 0.00003; BTC 30m OI >= -0.01%",
      "Candidate: Scalp Short high BTC funding + flat-to-rising BTC OI"
    );
  }

  if (
    mode === "scalp" &&
    bias === "short" &&
    Number.isFinite(btcOi60mPct) &&
    btcOi60mPct <= -1 &&
    Number.isFinite(btcOi30mPct) &&
    btcOi30mPct <= -0.5
  ) {
    addCandidateStamp(
      stamps,
      "candidate_scalp_short_btc_oi_compression_overlay",
      "scalp short; BTC OI 60m <= -1 and BTC OI 30m <= -0.5",
      "Scalp Short: BTC OI compression overlay"
    );
  }

  return stamps;
}
function buildStoredAlertStateFromEvent(e = {}) {
  return {
    ts: Date.now(),
    symbol: e.symbol || "",
    instId: e.instId || "",
    mode: e.mode || "",
    side: e.side || "",
    execReason: e.exec_reason || "",
    entryPrice: asNum(e.entry_price),
    confidence: e.confidence || "",
    recipeLabel: e.recipe_stamp_label || "",
    recipeReason: e.recipe_stamp_reason || "",
    recipeProfile: e.recipe_stamp_profile || "",
  };
}

function isSameAlertSetup(last = {}, t = {}) {
  return (
    String(last.symbol || "").toUpperCase() === String(t?.symbol || "").toUpperCase() &&
    String(last.instId || "") === String(t?.instId || "") &&
    String(last.mode || "").toLowerCase() === String(t?.mode || "").toLowerCase() &&
    String(last.side || "").toLowerCase() === String(t?.bias || "").toLowerCase() &&
    String(last.execReason || "").toLowerCase() === String(t?.execReason || "").toLowerCase()
  );
}

function entryDistancePct(a, b) {
  const x = asNum(a);
  const y = asNum(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) return null;
  return Math.abs((x - y) / y) * 100;
}

function getRepeatStateAgeMinutes(lastState, now) {
  const ts = asNum(lastState?.ts);
  if (!Number.isFinite(ts)) return null;
  const ageMin = (Number(now) - ts) / 60000;
  return Number.isFinite(ageMin) && ageMin >= 0 ? ageMin : null;
}

function evaluateRepeatAlertPolicy({ t, recipeStamp, tradeRead, lastFiredState, now }) {
  if (!lastFiredState || !isSameAlertSetup(lastFiredState, t)) {
    return { reject: false, isReminder: false, reason: "new_or_changed_setup" };
  }

  const ageMin = getRepeatStateAgeMinutes(lastFiredState, now);
  if (!Number.isFinite(ageMin)) {
    return { reject: false, isReminder: false, reason: "repeat_state_missing_timestamp" };
  }

  if (ageMin < CFG.cooldownMinutes) {
    return {
      reject: true,
      isReminder: false,
      reason: "cooldown",
      ageMinutes: Number(ageMin.toFixed(2)),
    };
  }

  const maxAgeMin = Math.max(CFG.cooldownMinutes * 2, horizonMinForMode(t?.mode));
  if (ageMin > maxAgeMin) {
    return { reject: false, isReminder: false, reason: "repeat_state_expired" };
  }

  if (!isSendableTradeStamp(recipeStamp)) {
    return { reject: true, isReminder: false, reason: "repeat_non_manual_recipe_suppressed" };
  }

  const distPct = entryDistancePct(t?.price, lastFiredState?.entryPrice);
  const tolerancePct = Number(CFG.premiumRealert?.entryTolerancePct || 0.35);
  if (!Number.isFinite(distPct) || distPct > tolerancePct) {
    return { reject: true, isReminder: false, reason: "premium_repeat_not_near_entry" };
  }

  if ((tradeRead?.cautions || []).length > 1) {
    return { reject: true, isReminder: false, reason: "premium_repeat_caution_heavy" };
  }

  return {
    reject: false,
    isReminder: true,
    reason: "premium_still_valid_entry_reminder",
    entryDistancePct: Number(distPct.toFixed(4)),
  };
}

function getEntryAtoms(t = {}) {
  const detail = t?.execDetail || t?.ctx?.execDetail || {};
  const rawItem = t?._rawItem || {};
  const levels = t?.levels || {};
  const mode = String(t?.mode || "").toLowerCase();
  const bias = String(t?.bias || "").toLowerCase();
  const price = asNum(t?.price);

  const l1h = levels?.["1h"];
  const hi1h = asNum(l1h?.hi);
  const lo1h = asNum(l1h?.lo);

  const contTf = continuationTfForMode(mode);
  const contLvl = levels?.[contTf];
  const contHi = asNum(detail?.contHi ?? contLvl?.hi);
  const contLo = asNum(detail?.contLo ?? contLvl?.lo);

  const p5 = asNum(detail?.p5 ?? rawItem?.deltas?.["5m"]?.price_change_pct);
  const wickMeta = t?.ctx?.wickMeta || {};

  let reversalMin = CFG.swingReversalMin5mMovePct;
  const dpsBias = String(t?.ctx?.dps?.bias || "neutral").toLowerCase();
  if (dpsBias === bias) reversalMin *= CFG.dps.favoredReversalMult;

  let inLowBand = "";
  let inHighBand = "";
  if (
    Number.isFinite(price) &&
    Number.isFinite(hi1h) &&
    Number.isFinite(lo1h) &&
    hi1h > lo1h
  ) {
    const edge = CFG.strongEdgePct1h * (hi1h - lo1h);
    inLowBand = price <= lo1h + edge;
    inHighBand = price >= hi1h - edge;
  }

  const numOrBlank = (v) => {
    const n = asNum(v);
    return Number.isFinite(n) ? n : "";
  };

  const boolOrBlank = (v) => (typeof v === "boolean" ? v : "");

  const matchedTfs = Array.isArray(detail?.matchedTfs) ? detail.matchedTfs : [];

  return {
    entry_atom_cont_tf: contTf || "",
    entry_atom_hi_1h: numOrBlank(hi1h),
    entry_atom_lo_1h: numOrBlank(lo1h),
    entry_atom_cont_hi: numOrBlank(contHi),
    entry_atom_cont_lo: numOrBlank(contLo),
    entry_atom_p5: numOrBlank(p5),
    entry_atom_reversal_min_pct: numOrBlank(reversalMin),
    entry_atom_in_low_band: boolOrBlank(inLowBand),
    entry_atom_in_high_band: boolOrBlank(inHighBand),
    entry_atom_matched_tfs: matchedTfs.join(","),
    entry_atom_match_count: numOrBlank(detail?.matchCount),
    entry_atom_recent_low: numOrBlank(detail?.recentLow),
    entry_atom_recent_high: numOrBlank(detail?.recentHigh),
    entry_atom_reclaim_pct: numOrBlank(detail?.reclaimPct),
    entry_atom_body_now_pct: numOrBlank(detail?.bodyNow),
    entry_atom_avg_body_pct: numOrBlank(detail?.avgBody),
    entry_atom_oi_rise_count: numOrBlank(detail?.oiRiseCount),
    entry_atom_price_pct: numOrBlank(detail?.pricePct),
    entry_atom_funding_rate: numOrBlank(detail?.fundingRate ?? detail?.funding),
    entry_atom_wick_pct: numOrBlank(wickMeta?.wickPct),
    entry_atom_wick_quality_score: numOrBlank(wickMeta?.qualityScore),
    entry_atom_wick_strong: boolOrBlank(wickMeta?.strong),
    entry_atom_wick_extreme: boolOrBlank(wickMeta?.extreme),
  };
}

function computeDynamicRiskBudget({ mode, t }) {
  const m = String(mode || "scalp").toLowerCase();
  const baseRiskPct = CFG.leverage?.riskBudgetPctByMode?.[m] ?? 1.0;

  let score = 0;
  const reasons = [];

  const profile = getTradeProfile(t);
  const bias = profile.bias;
  const oneHourAligned = profile.oneHourAligned;
  const counter1hLean = profile.counter1hLean;
  const b1Strong = profile.b1Strong;
  const flowPersists = profile.flowPersists;
  const reversalConfirmed = profile.reversalConfirmed;
  const liquiditySnap = profile.liquiditySnap;
  const breakoutOnly = profile.pureBreakoutOnly;
  const wickStrong = profile.wickStrong;
  const wickExtreme = profile.wickExtreme;
  const strongBottoming = profile.strongBottoming;

  const pureContinuationShort =
    bias === "short" &&
    flowPersists &&
    !b1Strong &&
    !reversalConfirmed;

  const shortIntoBottoming =
    pureContinuationShort &&
    strongBottoming;

  if (b1Strong) { score += 1; reasons.push("b1_strong"); }
  if (oneHourAligned && !pureContinuationShort) { score += 1; reasons.push("aligned_1h"); }
  if (wickExtreme) { score += 0.5; reasons.push("wick_extreme"); }
  else if (wickStrong) { score += 0.25; reasons.push("wick_strong"); }
  
  if (breakoutOnly) { score -= 0.5; reasons.push("breakout_only"); }
  if (counter1hLean) { score -= 1; reasons.push("counter_1h"); }
  if (pureContinuationShort) { reasons.push("continuation_short_base_size"); }
  if (shortIntoBottoming) { score -= 1; reasons.push("bottoming_penalty"); }
  let multiplier = 1.0;
  if (score >= 5) multiplier = 2.0;
  else if (score >= 4) multiplier = 1.75;
  else if (score >= 3) multiplier = 1.5;
  else if (score >= 2) multiplier = 1.25;
  else if (score <= 0) multiplier = 0.75;

  const effectiveRiskPct = Number((baseRiskPct * multiplier).toFixed(4));

  return {
    baseRiskPct,
    effectiveRiskPct,
    multiplier,
    score,
    reasons,
  };
}


/**
 * DETECTION (mode-aware; loosened)
 */
function evaluateCriteria(item, lastState, mode) {
  const m = String(mode || "scalp").toLowerCase();

  const d5 = item?.deltas?.["5m"];
  const d15 = item?.deltas?.["15m"];

  const triggers = [];

  const stateTf = m === "scalp" ? d5 : d15;
  const curState = String(stateTf?.state || "unknown");

  if (lastState && curState !== lastState) triggers.push({ code: "setup_flip" });

  if ((abs(d5?.price_change_pct) ?? 0) >= CFG.momentumAbs5mPricePct) {
    triggers.push({ code: "momentum_confirm" });
  }

  const shock5 =
    (d5?.oi_change_pct ?? -Infinity) >= CFG.shockOi15mPct ||
    (abs(d5?.price_change_pct) ?? 0) >= CFG.shockAbs15mPricePct;

  const shock15 =
    (d15?.oi_change_pct ?? -Infinity) >= CFG.shockOi15mPct ||
    (abs(d15?.price_change_pct) ?? 0) >= CFG.shockAbs15mPricePct;

  if (shock5 || shock15) triggers.push({ code: "positioning_shock" });

  return { triggers, curState };
}

// Macro gate
function computeBtcMacro(results, mode) {
  if (!CFG.macro.enabled) return { ok: false, reason: "macro_disabled", btcBullExpansion: false };

  const btcSym = CFG.macro.btcSymbol;
  const btcItem = (results || []).find((x) => String(x?.symbol || "").toUpperCase() === btcSym);
  if (!btcItem?.ok) return { ok: false, reason: "btc_missing", btcBullExpansion: false };

  const m = String(mode || "swing").toLowerCase();
  const tf = CFG.macro.btcTfByMode?.[m] || "4h";

  const d = btcItem?.deltas?.[tf];
  const pricePct = asNum(d?.price_change_pct);
  const oiPct = asNum(d?.oi_change_pct);
  const lean = String(d?.lean || "").toLowerCase();

  const bull =
    lean === "long" &&
    Number.isFinite(pricePct) &&
    Number.isFinite(oiPct) &&
    pricePct >= CFG.macro.btcPricePctMin &&
    oiPct >= CFG.macro.btcOiPctMin;

  return {
    ok: true,
    reason: "ok",
    btcBullExpansion: bull,
    tf,
    btc: {
      lean: lean || null,
      pricePct: Number.isFinite(pricePct) ? pricePct : null,
      oiPct: Number.isFinite(oiPct) ? oiPct : null,
    },
  };
}

function computeBtcWaterfall(results, mode) {
  if (!CFG.macro.enabled) return { ok: false, reason: "macro_disabled", btcWaterfall: false };

  const btcSym = CFG.macro.btcSymbol;
  const btcItem = (results || []).find((x) => String(x?.symbol || "").toUpperCase() === btcSym);
  if (!btcItem?.ok) return { ok: false, reason: "btc_missing", btcWaterfall: false };

  const m = String(mode || "swing").toLowerCase();
  const tf = CFG.macro.btcTfByMode?.[m] || "4h";

  const d = btcItem?.deltas?.[tf];
  const pricePct = asNum(d?.price_change_pct);
  const oiPct = asNum(d?.oi_change_pct);

  const waterfall =
    Number.isFinite(pricePct) &&
    Number.isFinite(oiPct) &&
    pricePct <= -CFG.macro.btcPricePctMin &&
    oiPct >= CFG.macro.btcOiPctMin;

  return {
    ok: true,
    reason: "ok",
    btcWaterfall: waterfall,
    tf,
    btc: {
      pricePct: Number.isFinite(pricePct) ? pricePct : null,
      oiPct: Number.isFinite(oiPct) ? oiPct : null,
    },
  };
}

/**
 * STRICT ENTRY (SCALP) — unchanged logic, UPDATED COPY (message contract ready)
 */
async function scalpExecutionGate({ instId, item, bias, levels }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "1h_warmup" };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const priceNow = asNum(item?.price);
  if (hi == null || lo == null || priceNow == null)
    return { ok: false, reason: "missing_levels_or_price" };

  const oi15 = asNum(item?.deltas?.["15m"]?.oi_change_pct);
  if (!Number.isFinite(oi15) || oi15 < CFG.shockOi15mPct)
    return { ok: false, reason: "oi15_not_confirming" };

    const recentPts = await getRecentSeriesPoints(instId, CFG.wick.sweepLookbackPoints);
  const minRecent = recentPts.length
    ? Math.min(...recentPts.map((p) => asNum(p?.l ?? p?.p)).filter((x) => x != null))
    : null;
  const maxRecent = recentPts.length
    ? Math.max(...recentPts.map((p) => asNum(p?.h ?? p?.p)).filter((x) => x != null))
    : null;

  const lastPt = recentPts.length ? recentPts[recentPts.length - 1] : null;
  const wickMeta = wickQuality(lastPt, bias);
  const lastWickPct = wickMeta.wickPct;

  if (bias === "long") {
    const breakout = priceNow > hi;
    const sweptDown = minRecent != null && minRecent < lo;
    const sweepReclaim = sweptDown && priceNow > lo;

    if (breakout) {
      return {
        ok: true,
        reason: "long_breakout",
        entryLine: `broke above 1h high (${fmtPrice(hi)}) + OI confirms (15m ≥ ${fmtPct(
          CFG.shockOi15mPct
        )})`,
      };
    }
        if (sweepReclaim) {
      return {
        ok: true,
        reason: "long_sweep_reclaim",
        entryLine: `swept 1h low (${fmtPrice(lo)}) then reclaimed + OI confirms (15m ≥ ${fmtPct(
          CFG.shockOi15mPct
        )})`,
      };
    }

    const wickFlushReclaim =
      Number.isFinite(lastWickPct) &&
      lastWickPct >= CFG.wick.minPct &&
      priceNow > lo;

    if (wickFlushReclaim) {
      return {
        ok: true,
        reason: "long_wick_flush_reclaim",
        entryLine: `5m flush wick reclaimed above 1h low (${fmtPrice(lo)}) + OI confirms`,
        wickMeta,
      };
    }

    return { ok: false, reason: "price_trigger_not_active" };
  }

  if (bias === "short") {
    const breakdown = priceNow < lo;
    const sweptUp = maxRecent != null && maxRecent > hi;
    const sweepReject = sweptUp && priceNow < hi;

    if (breakdown) {
      return {
        ok: true,
        reason: "short_breakdown",
        entryLine: `broke below 1h low (${fmtPrice(lo)}) + OI confirms (15m ≥ ${fmtPct(
          CFG.shockOi15mPct
        )})`,
      };
    }
        if (sweepReject) {
      return {
        ok: true,
        reason: "short_sweep_reject",
        entryLine: `swept 1h high (${fmtPrice(hi)}) then rejected + OI confirms (15m ≥ ${fmtPct(
          CFG.shockOi15mPct
        )})`,
      };
    }

    const wickSpikeReject =
      Number.isFinite(lastWickPct) &&
      lastWickPct >= CFG.wick.minPct &&
      priceNow < hi;

    if (wickSpikeReject) {
      return {
        ok: true,
        reason: "short_wick_spike_reject",
        entryLine: `5m spike wick rejected below 1h high (${fmtPrice(hi)}) + OI confirms`,
        wickMeta,
      };
    }

    return { ok: false, reason: "price_trigger_not_active" };
  }

  return { ok: false, reason: "neutral_bias" };
}

/**
 * SWING/BUILD ENTRY
 * Two ways to be actionable:
 *  A) BREAK: price beyond 1h high/low
 *  B) REVERSAL: tag B1 band + 5m push away from extreme
 *
 * Returns entryLine (for "Entry:" DM line).
 */

function continuationTfForMode(modeLabel) {
  const allowed = new Set(["15m", "30m", "1h", "4h"]);
  const m = String(modeLabel || "").toLowerCase();

  if (m === "swing") {
    const tf = String(process.env.ALERT_CONT_TF_SWING || "30m").toLowerCase();
    return allowed.has(tf) ? tf : "30m";
  }

  if (m === "build") {
    const tf = String(process.env.ALERT_CONT_TF_BUILD || "1h").toLowerCase();
    return allowed.has(tf) ? tf : "1h";
  }

  return "1h";
}

function flowPersistsAcrossTfs(item, bias) {
  const cfg = CFG.flowPersists;
  const funding = asNum(item?.funding_rate);
  const p5 = asNum(item?.deltas?.["5m"]?.price_change_pct);
  const matchedTfs = [];

  if (!cfg?.enabled) {
    return {
      ok: false,
      reason: "flow_persists_disabled",
      matchedTfs,
      matchCount: 0,
      funding,
      p5,
    };
  }

  if (!Number.isFinite(p5) || Math.abs(p5) < cfg.min5mPricePct) {
    return {
      ok: false,
      reason: "flow_persists_5m_too_small",
      matchedTfs,
      matchCount: 0,
      funding,
      p5,
    };
  }

  if (Number.isFinite(funding) && Math.abs(funding) > cfg.maxFundingAbs) {
    return {
      ok: false,
      reason: "flow_persists_funding_too_high",
      matchedTfs,
      matchCount: 0,
      funding,
      p5,
    };
  }

  for (const tf of cfg.tfs) {
    const d = item?.deltas?.[tf];
    if (!d) continue;

    const lean = String(d?.lean || "").toLowerCase();
    const oi = asNum(d?.oi_change_pct);

    if (lean !== bias) continue;
    if (cfg.requireOiPositive && !(Number.isFinite(oi) && oi > 0)) continue;

    matchedTfs.push(tf);
  }

  const matchCount = matchedTfs.length;
  if (matchCount < cfg.minMatches) {
    return {
      ok: false,
      reason: "flow_persists_not_enough_matches",
      matchedTfs,
      matchCount,
      funding,
      p5,
    };
  }

  return {
    ok: true,
    reason: `flow_persists_${bias}`,
    matchedTfs,
    matchCount,
    funding,
    p5,
  };
}

async function swingExecutionGate({ instId, bias, levels, item, modeLabel = "SWING", dps = null }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "1h_warmup" };

  const contTf = continuationTfForMode(modeLabel);
  const contLvl = levels?.[contTf];
  if (!contLvl || contLvl.warmup) return { ok: false, reason: `${contTf}_warmup` };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const p = asNum(item?.price);
  const contHi = asNum(contLvl.hi);
  const contLo = asNum(contLvl.lo);

  if (hi == null || lo == null || contHi == null || contLo == null || p == null) {
    return { ok: false, reason: "missing_levels_or_price" };
  }

  const oi15 = asNum(item?.deltas?.["15m"]?.oi_change_pct);
  if (Number.isFinite(oi15) && oi15 < CFG.swing.minOiPct) {
    return {
      ok: false,
      reason: "oi15_too_negative_for_swing",
      detail: { oi15, min: CFG.swing.minOiPct },
    };
  }

  const d5 = item?.deltas?.["5m"];
  const p5 = asNum(d5?.price_change_pct);
  const maxIdeaLookback = Math.max(
    CFG.entryIdeas.ignitionBreakout.lookbackCandles + 1,
    CFG.entryIdeas.liquiditySnap.lookbackCandles + 1,
    CFG.entryIdeas.slowLeverageSqueeze.breakLookbackCandles + 1,
    CFG.entryIdeas.slowLeverageSqueeze.oiCandles + 1,
    CFG.entryIdeas.slowShortBreak.breakLookbackCandles + 1,
    CFG.entryIdeas.slowShortBreak.oiRiseCandles + 1,
    CFG.bottoming.lookbackCandles,
    10
  );
  const recentPts = await getIdeaWindow(instId, maxIdeaLookback);
  const lastPt = recentPts.length ? recentPts[recentPts.length - 1] : null;
  const wickMeta = wickQuality(lastPt, bias);
  const lastWickPct = wickMeta.wickPct;
    const bottoming = computeBottomingSignal({ item, points: recentPts });

  const range = hi - lo;
  if (!(range > 0)) return { ok: false, reason: "bad_range" };

  const edge = CFG.strongEdgePct1h * range;
  const lowBandLo = lo;
  const lowBandHi = lo + edge;
  const highBandLo = hi - edge;
  const highBandHi = hi;
  const inLowBand = p <= lowBandHi;
  const inHighBand = p >= highBandLo;
  const lowBandTxt = `${fmtPrice(lowBandLo)}–${fmtPrice(lowBandHi)}`;
  const highBandTxt = `${fmtPrice(highBandLo)}–${fmtPrice(highBandHi)}`;
  let reversalMin = CFG.swingReversalMin5mMovePct;
  const dpsBias = String(dps?.bias || "neutral").toLowerCase();
  if (dpsBias === bias) reversalMin *= CFG.dps.favoredReversalMult;

  if (bias === "long") {
    const ignition = ignitionBreakoutLongCheck(recentPts, p, asNum(item?.funding_rate));
    if (ignition.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_${ignition.reason}`,
        entryLine: ignition.entryLine,
        detail: ignition.detail,
        bottoming,
      };
    }

    const liqSnap = liquiditySnapReversalLongCheck(recentPts, p, p5);
    if (liqSnap.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_${liqSnap.reason}`,
        entryLine: liqSnap.entryLine,
        wickMeta: liqSnap.wickMeta,
        detail: liqSnap.detail,
        bottoming,
      };
    }

    const slowSqueeze = slowLeverageSqueezeLongCheck(recentPts, p);
    if (slowSqueeze.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_${slowSqueeze.reason}`,
        entryLine: slowSqueeze.entryLine,
        detail: slowSqueeze.detail,
        bottoming,
      };
    }

    if (p > contHi) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_break_above_${contTf}_high`,
        entryLine: `break above ${contTf} high (${fmtPrice(contHi)}) → continuation`,
        bottoming,
      };
    }

    const reversalOk = inLowBand && Number.isFinite(p5) && p5 >= reversalMin;
    if (reversalOk) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_b1_reversal_long`,
        entryLine: `bounce in B1 low band (${lowBandTxt}) + 5m turned up (≥ ${fmtPct(reversalMin)})`,
        bottoming,
      };
    }

    const wickReclaim =
      modeLabel === "SWING" &&
      inLowBand &&
      Number.isFinite(lastWickPct) &&
      lastWickPct >= CFG.wick.minPct &&
      Number.isFinite(p5) &&
      p5 > 0;

    if (wickReclaim) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_wick_reclaim_long`,
        entryLine: `wick reclaim in B1 low band (${lowBandTxt}) + 5m turned up`,
        wickMeta,
        bottoming,
      };
    }

    const flowPersist = flowPersistsAcrossTfs(item, "long");
    if (flowPersist.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_flow_persists_long`,
        entryLine: `flow persists across TFs (${flowPersist.matchedTfs.join("/")}) + OI aligned`,
        detail: flowPersist,
        bottoming,
      };
    }

    return {
      ok: false,
      reason: "no_entry_trigger",
      detail: { p, hi, lo, inLowBand, p5, lastWickPct, flowPersists: flowPersist, bottoming },
    };
  }

    if (bias === "short") {
    const slowShort = slowShortBreakdownCheck(recentPts, p, asNum(item?.funding_rate));
    if (slowShort.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_${slowShort.reason}`,
        entryLine: slowShort.entryLine,
        detail: slowShort.detail,
        bottoming,
      };
    }

    if (modeLabel === "SWING" && p < contLo) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_break_below_${contTf}_low`,
        entryLine: `break below ${contTf} low (${fmtPrice(contLo)}) → continuation`,
        bottoming,
      };
    }

    const flowPersist = flowPersistsAcrossTfs(item, "short");
    if (modeLabel === "SWING" && flowPersist.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_flow_persists_short`,
        entryLine: `flow persists across TFs (${flowPersist.matchedTfs.join("/")}) + OI aligned`,
        detail: flowPersist,
        bottoming,
      };
    }

    const reversalOk = inHighBand && Number.isFinite(p5) && p5 <= -reversalMin;
    if (reversalOk) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_b1_reversal_short`,
        entryLine: `reject in B1 high band (${highBandTxt}) + 5m turned down (≤ -${fmtPct(reversalMin)})`,
        bottoming,
      };
    }

    const wickReject =
      modeLabel === "SWING" &&
      inHighBand &&
      Number.isFinite(lastWickPct) &&
      lastWickPct >= CFG.wick.minPct &&
      Number.isFinite(p5) &&
      p5 < 0;

    if (wickReject) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_wick_reject_short`,
        entryLine: `wick reject in B1 high band (${highBandTxt}) + 5m turned down`,
        wickMeta,
        bottoming,
      };
    }

    if (modeLabel !== "SWING" && p < contLo) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_break_below_${contTf}_low`,
        entryLine: `break below ${contTf} low (${fmtPrice(contLo)}) → continuation`,
        bottoming,
      };
    }

    if (modeLabel !== "SWING" && flowPersist.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_flow_persists_short`,
        entryLine: `flow persists across TFs (${flowPersist.matchedTfs.join("/")}) + OI aligned`,
        detail: flowPersist,
        bottoming,
      };
    }

        return {
      ok: false,
      reason: "no_entry_trigger",
      detail: { p, hi, lo, inHighBand, p5, lastWickPct, flowPersists: flowPersist, bottoming },
    };
  }

  return { ok: false, reason: "neutral_bias" };
}


function structuralTpCandidatesForTf({ bias, price, levels, tf }) {
  const entry = asNum(price);
  const dir = String(bias || "").toLowerCase();
  const lvl = levels?.[tf];
  if (entry == null || entry <= 0 || (dir !== "long" && dir !== "short")) return [];
  if (!lvl || lvl.warmup) return [];

  const mid = asNum(lvl.mid);
  const hi = asNum(lvl.hi);
  const lo = asNum(lvl.lo);
  const rawTargets = dir === "long"
    ? [{ level: "mid", tp: mid }, { level: "high", tp: hi }]
    : [{ level: "mid", tp: mid }, { level: "low", tp: lo }];

  return rawTargets
    .map((target) => {
      const tp = asNum(target.tp);
      if (tp == null) return null;
      if (dir === "long" && tp <= entry) return null;
      if (dir === "short" && tp >= entry) return null;
      return {
        tf,
        level: target.level,
        tp,
        tpPct: (Math.abs(tp - entry) / entry) * 100,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.tpPct - b.tpPct);
}

function tpCandidatePasses({ candidate, entryPrice, stopLossPx, minTpPct = 0 }) {
  if (!candidate) return false;
  if (Number.isFinite(Number(minTpPct)) && candidate.tpPct < Number(minTpPct)) return false;

  const sl = asNum(stopLossPx);
  if (sl == null) return true;

  const rrInfo = computeRiskReward({
    entryPrice,
    stopLossPx: sl,
    tp: candidate.tp,
  });

  return !!rrInfo && rrInfo.rr >= CFG.minRR;
}

function firstPassingCandidate(candidates, args) {
  for (const candidate of candidates || []) {
    if (tpCandidatePasses({ candidate, ...args })) return { ...candidate, forced: false };
  }
  return null;
}

function firstFallbackCandidate(candidates = []) {
  return candidates.length ? { ...candidates[0], forced: true } : null;
}

function chooseDynamicTp({ mode, bias, price, levels, minTpPct = 0, stopLossPx = null }) {
  const m = String(mode || "").toLowerCase();
  const args = { entryPrice: price, stopLossPx, minTpPct };

  if (m === "scalp") {
    const ordered = ["15m", "1h", "4h"];
    const all = [];
    for (const tf of ordered) {
      const candidates = structuralTpCandidatesForTf({ bias, price, levels, tf });
      all.push(...candidates);
      const picked = firstPassingCandidate(candidates, args);
      if (picked) return picked;
    }
    return firstFallbackCandidate(all);
  }

  if (m === "swing") {
    const oneHour = structuralTpCandidatesForTf({ bias, price, levels, tf: "1h" });
    const oneHourPick = firstPassingCandidate(oneHour, args);
    if (oneHourPick) return oneHourPick;

    const fourHour = structuralTpCandidatesForTf({ bias, price, levels, tf: "4h" });
    const fourHourPick = firstPassingCandidate(fourHour, args);
    if (fourHourPick) return fourHourPick;

    return firstFallbackCandidate([...oneHour, ...fourHour]);
  }

  if (m === "build") {
    const ladder = buildTpLadder({ bias, entryPrice: price, levels });
    const picked = firstPassingCandidate(
      ladder.map((target) => ({ ...target, tf: "4h", level: target.label })),
      args
    );
    if (picked) return picked;
    return firstFallbackCandidate(ladder.map((target) => ({ ...target, tf: "4h", level: target.label })));
  }

  const fallback = structuralTpCandidatesForTf({ bias, price, levels, tf: "1h" });
  return firstPassingCandidate(fallback, args) || firstFallbackCandidate(fallback);
}
function summarizeMacroBias(macroByMode, modes) {
  const ordered = (modes || MODE_PRIORITY).filter(Boolean);
  const leans = ordered
    .map((mode) => ({ mode, lean: String(macroByMode?.[mode]?.btc?.lean || "neutral").toLowerCase() }))
    .filter((x) => x.lean && x.lean !== "neutral");

  if (!leans.length) return "mixed / neutral";
  const uniqueLeans = [...new Set(leans.map((x) => x.lean))];
  if (uniqueLeans.length === 1) {
    return `${uniqueLeans[0]} across ${leans.map((x) => x.mode).join("/")}`;
  }
  return leans.map((x) => `${x.mode}:${x.lean}`).join(", ");
}

function summarizeBuildRegime(regimeRow) {
  if (!regimeRow) return "no build regime read";
  const regime = String(regimeRow.regime || "neutral").toLowerCase();
  const score = Number(regimeRow.score ?? 0);
  if (regime === "bullish" && score >= 40) return "strong bullish build tailwind";
  if (regime === "bearish" && score <= -40) return "strong bearish build tailwind";
  return "no strong build regime tailwind";
}

function summarizeSkipReason(skip, mode, focusSymbol) {
  const reason = String(skip?.reason || "").toLowerCase();
  if (!reason) return null;

  if (reason === "range_floor") {
    if (mode === "scalp") return "market too quiet / compressed";
    if (mode === "swing" || mode === "build") return "some movement, but not enough for slower-mode range requirements";
    return "range too small";
  }

  if (reason === "macro_block_btc_bull_expansion") return "BTC macro blocked the short";
  if (reason === "btc_waterfall_override") return "BTC waterfall blocked the long";
  if (reason === "leverage_floor") return "setup passed, but leverage recommendation was below floor";

  if (reason.startsWith("weak_reco:")) {
    const detail = reason.slice("weak_reco:".length);
    if (detail === "short_not_near_high") return "short idea existed, but not stretched enough toward local high";
    if (detail === "long_not_near_low") return "long idea existed, but not stretched enough toward local low";
    return "direction was possible, but entry location was weak";
  }

  if (reason.startsWith("scalp_exec:")) {
    return `scalp execution gate failed (${reason.slice("scalp_exec:".length)})`;
  }

  if (reason === "rr_too_small") return "reward-to-risk was too small";
  if (reason === "build_tp_too_small") return "build target was too small";
  if (reason === "no_dynamic_tp") return "no valid take-profit target found";
  if (reason === "cooldown") return "cooldown blocked repeat alert";
  if (reason === "warmup_gate_1h") return "not enough 1h data yet";

  if (focusSymbol && String(skip?.symbol || "").toUpperCase() !== String(focusSymbol).toUpperCase()) {
    return null;
  }

  return reason;
}

function buildDebugSummary({
  symbols = [],
  modes = [],
  macroByMode = {},
  skipped = [],
  triggered = [],
  debug_build_regimes = [],
  btcSymbol = "BTCUSDT",
}) {
  const requested = (symbols || []).map((s) => String(s || "").toUpperCase()).filter(Boolean);
  const focusSymbol = requested.find((s) => s !== String(btcSymbol || "BTCUSDT").toUpperCase()) || requested[0] || null;
  const orderedModes = (modes || MODE_PRIORITY).filter(Boolean);
  const focusSkips = (skipped || []).filter((x) => String(x?.symbol || "").toUpperCase() === String(focusSymbol || "").toUpperCase());
  const btcSkips = (skipped || []).filter((x) => String(x?.symbol || "").toUpperCase() === String(btcSymbol || "BTCUSDT").toUpperCase());
  const effectiveTriggered = (triggered || []).filter(
  (x) => String(x?.observationType || "") === "fired" && !String(x?.rejectionReason || "")
);
  const focusTriggered = effectiveTriggered.filter((x) => String(x?.symbol || "").toUpperCase() === String(focusSymbol || "").toUpperCase());
  const buildRow = (debug_build_regimes || []).find((x) => String(x?.symbol || "").toUpperCase() === String(focusSymbol || "").toUpperCase());

  const rangeFloorCount = (skipped || []).filter((x) => String(x?.reason || "") === "range_floor").length;
  const marketState = rangeFloorCount >= Math.max(1, Math.ceil((skipped || []).length / 2))
    ? "too quiet / compressed"
    : (effectiveTriggered.length ? "tradeable" : "mixed");

  const symbol_read = {};
  for (const mode of orderedModes) {
    const trig = focusTriggered.find((x) => String(x?.mode || "").toLowerCase() === String(mode).toLowerCase());
    if (trig) {
      symbol_read[mode] = `triggered ${String(trig?.bias || "").toLowerCase()} setup`;
      continue;
    }
    const skip = focusSkips.find((x) => String(x?.mode || "").toLowerCase() === String(mode).toLowerCase());
    symbol_read[mode] = skip ? summarizeSkipReason(skip, mode, focusSymbol) : "no clear read";
  }

  const whyNoAlert = [];
  if (!effectiveTriggered.length) {
    if (marketState === "too quiet / compressed") whyNoAlert.push("overall volatility too low");
    for (const mode of orderedModes) {
      const msg = symbol_read[mode];
      if (!msg || msg === "no clear read") continue;
      if (!whyNoAlert.includes(msg)) whyNoAlert.push(msg);
    }
    const buildTailwind = summarizeBuildRegime(buildRow);
    if (buildTailwind === "no strong build regime tailwind" && !whyNoAlert.includes(buildTailwind)) {
      whyNoAlert.push(buildTailwind);
    }
  }

  const summary = {
    focus_symbol: focusSymbol,
    btc_macro_bias: summarizeMacroBias(macroByMode, orderedModes),
    market_state: marketState,
    symbol_read,
    build_regime: buildRow
      ? {
          regime: buildRow.regime ?? null,
          score: buildRow.score ?? null,
          read: summarizeBuildRegime(buildRow),
        }
      : undefined,
    why_no_alert: whyNoAlert,
  };

  const lines = [];
  if (focusSymbol) lines.push(`${focusSymbol}`);
  lines.push(`BTC macro bias: ${summary.btc_macro_bias}`);
  lines.push(`Market state: ${summary.market_state}`);
  for (const mode of orderedModes) {
    if (summary.symbol_read?.[mode]) {
      lines.push(`${mode[0].toUpperCase()}${mode.slice(1)}: ${summary.symbol_read[mode]}`);
    }
  }
  if (summary.build_regime?.read) lines.push(`Build regime: ${summary.build_regime.read}`);
  if (summary.why_no_alert?.length) lines.push(`Why no alert: ${summary.why_no_alert.join("; ")}`);
  summary.text = lines.join("\n");

  const btcRangeFloor = btcSkips.find((x) => String(x?.reason || "") === "range_floor");
  if (btcRangeFloor?.detail) summary.btc_range_context = btcRangeFloor.detail;

  return summary;
}
module.exports = async function handler(req, res) {
  let dry = false;
  let debug = false;
  let risk_profile = CFG.defaultRisk;

  // evaluate potentially multiple modes in priority order
  let modes = ["scalp"];
  let analyticsPost = makeAnalyticsPostResult({ status: "not_attempted" });

  try {
    const secret = process.env.ALERT_SECRET || "";

    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";

    const key = String(req.query.key || "");
    const provided = bearer || key;

    if (!secret || provided !== secret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    debug = String(req.query.debug || "") === "1";
    const force = String(req.query.force || "") === "1";
    if (force) {
  console.log("⚠️ FORCE MODE ACTIVE");
}
     dry = String(req.query.dry || "") === "1";
    const driver_tf = normalizeDriverTf(req.query.driver_tf);

    // Modes: query overrides env, env overrides legacy defaultMode
    const queryModes = normalizeModes(req.query.mode);
    const envModes = normalizeModes(CFG.defaultModesRaw);

    // legacy fallback (single value) -> normalize into array if valid
    const legacyAsList = normalizeModes(CFG.defaultMode);
    const legacyMode = legacyAsList.length ? legacyAsList : ["scalp"];

    const baseModes = queryModes.length
      ? queryModes
      : envModes.length
      ? envModes
      : legacyMode.length
      ? legacyMode
      : ["scalp"];

    modes = prioritizeModes(baseModes);

    risk_profile = normalizeRisk(req.query.risk_profile) || CFG.defaultRisk;

    const querySyms = normalizeSymbols(req.query.symbols);
    const envSyms = normalizeSymbols(process.env.DEFAULT_SYMBOLS);
    const symbols = querySyms.length ? querySyms : envSyms.length ? envSyms : ["BTCUSDT"];

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();

    const wantRegime = modes.includes("build");
    const multiUrl = `${proto}://${host}/api/multi?symbols=${encodeURIComponent(
     symbols.join(",")
    )}&driver_tf=${encodeURIComponent(driver_tf)}&source=snapshot${wantRegime ? "&regime=1" : ""}`;

    const r = await fetch(multiUrl, { headers: { "Cache-Control": "no-store" } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) {
      const nowFail = Date.now();
      await writeHeartbeat(
        {
          ts: nowFail,
          iso: new Date(nowFail).toISOString(),
          ok: false,
          stage: "multi_fetch_failed",
          modes,
          risk_profile,
          sent: false,
          triggered_count: 0,
          ...analyticsHeartbeatFields(analyticsPost),
          error: "multi fetch failed",
        },
        { dry }
      );
      return res
        .status(500)
        .json({ ok: false, error: "multi fetch failed", multiUrl, detail: j || null });
    }

    
    // Macro snapshot for debug/response (use highest-priority mode as representative)
    const macroByMode = Object.fromEntries(
  (modes || ["scalp"]).map((m) => [m, computeBtcMacro(j.results || [], m)])
);
    
    const now = Date.now();
const deployInfo = getDeployInfo();
const cooldownMs = CFG.cooldownMinutes * 60000;
const externalTelemetryPromise = loadExternalTelemetry();
const btcTapeInstId =
  (j.results || []).find(
    (it) => String(it?.symbol || "").toUpperCase() === String(CFG.macro.btcSymbol || "BTCUSDT").toUpperCase()
  )?.instId || btcInstIdFromSymbol(CFG.macro.btcSymbol);
const btcTapePromise = loadBtcTapeContext(btcTapeInstId);
const [externalTelemetry, btcTapeContext] = await Promise.all([
  externalTelemetryPromise,
  btcTapePromise,
]);
const anomalyRanking = buildCrossAssetAnomaly({
  items: j.results || [],
});

const triggered = [];
    const skipped = [];
    const analyticsEvents = [];
    function getAnomalyEventFields(symbol = "") {
  const sym = String(symbol || "").toUpperCase();
  const ranking = Array.isArray(anomalyRanking?.ranking) ? anomalyRanking.ranking : [];
  const idx = ranking.findIndex((r) => String(r?.symbol || "").toUpperCase() === sym);
  const row = idx >= 0 ? ranking[idx] : null;

  return {
    anomaly_tf: anomalyRanking?.ok ? anomalyRanking?.tf ?? "" : "",
    anomaly_score: row?.score ?? "",
    anomaly_rank: idx >= 0 ? idx + 1 : "",
    anomaly_pattern: row?.pattern ?? "",
    anomaly_price_pct: row?.price_pct ?? "",
    anomaly_oi_pct: row?.oi_pct ?? "",
    anomaly_funding_rate: row?.funding_rate ?? "",
    anomaly_basket_price_pct: row?.basket_price_pct ?? "",
    anomaly_basket_oi_pct: row?.basket_oi_pct ?? "",
    anomaly_basket_funding_rate: row?.basket_funding_rate ?? "",
    anomaly_price_oi_gap: row?.components?.price_oi_gap ?? "",
    anomaly_funding_deviation_bps: row?.components?.funding_deviation_bps ?? "",
    anomaly_oi_trend_deviation: row?.components?.oi_trend_deviation ?? "",
    anomaly_price_deviation: row?.components?.price_deviation ?? "",
  };
}

async function buildDirectManualRecipeCandidates(item) {
  const instId = String(item?.instId || "").trim();
  const symbol = String(item?.symbol || "?").trim();
  const price = asNum(item?.price);

  if (!instId || !Number.isFinite(price)) return [];

  const probeCtx = {
    btc5mOi15mPct: btcTapeContext?.oi15mPct ?? null,
    btc5mOi60mPct: btcTapeContext?.oi60mPct ?? null,
    btc5mFunding15mAvg: btcTapeContext?.funding15mAvg ?? null,
    symbolVsBtc15mPct: item?.market_context?.symbol_vs_btc_15m_pct ?? null,
    symbolVsEth1hPct: item?.market_context?.symbol_vs_eth_1h_pct ?? null,
    cryptoBreadth1hPct: item?.market_context?.crypto_breadth_1h_pct ?? null,
    spotVsPerp1hPct: item?.market_structure?.spot_vs_perp_1h_pct ?? null,
  };

  const matchingRecipes = LIVE_MANUAL_RECIPES.filter((recipe) => {
    if (!modes.includes(recipe.mode)) return false;
    return recipe.matches({ mode: recipe.mode, bias: recipe.side, execReason: recipe.id, ctx: probeCtx });
  });

  if (matchingRecipes.length === 0) return [];

  const levels = await computeLevelsFromSeries(instId);
  if (!force && levels?.["1h"]?.warmup) {
    if (debug) {
      for (const recipe of matchingRecipes) {
        skipped.push({ symbol, mode: recipe.mode, reason: "direct_recipe_warmup_gate_1h", detail: { recipe: recipe.id } });
      }
    }
    return [];
  }

  const anomalyCtx = getAnomalyEventFields(symbol);
  const stateByMode = new Map();
  const candidates = [];

  for (const recipe of matchingRecipes) {
    let stateInfo = stateByMode.get(recipe.mode);
    if (!stateInfo) {
      const lastStateRaw = await redis.get(CFG.keys.lastState(recipe.mode, instId)).catch(() => null);
      const lastState = lastStateRaw ? String(lastStateRaw) : null;
      stateInfo = evaluateCriteria(item, lastState, recipe.mode);
      stateByMode.set(recipe.mode, stateInfo);
    }

    const baseBias = biasFromItem(item, recipe.mode);
    const b1 = strongRecoB1({ bias: recipe.side, levels, price });
    const macroMode = computeBtcMacro(j.results || [], recipe.mode);

    const t = {
      mode: recipe.mode,
      instId,
      _rawItem: item,
      symbol,
      price,
      bias: recipe.side,
      baseBias,
      triggers: stateInfo?.triggers || [],
      levels,
      b1,
      entryLine: null,
      execReason: recipe.id,
      execDetail: {
        directRecipe: recipe.id,
        rankValue: recipe.rankValue({ ctx: probeCtx }),
      },
      curState: stateInfo?.curState || null,
      observationType: "fired",
      randomGroupId: "",
      randomSource: "",
      analyticsOnly: false,
      rejectionReason: "",
      manualRecipeId: recipe.id,
      ctx: {
        anomalyTf: anomalyCtx.anomaly_tf || "",
        anomalyScore: asNum(anomalyCtx.anomaly_score),
        anomalyRank: asNum(anomalyCtx.anomaly_rank),
        anomalyPricePct: asNum(anomalyCtx.anomaly_price_pct),
        anomalyOiPct: asNum(anomalyCtx.anomaly_oi_pct),
        anomalyFundingRate: asNum(anomalyCtx.anomaly_funding_rate),
        anomalyPattern: anomalyCtx.anomaly_pattern || "",
        anomalyBasketPricePct: asNum(anomalyCtx.anomaly_basket_price_pct),
        anomalyBasketOiPct: asNum(anomalyCtx.anomaly_basket_oi_pct),
        anomalyBasketFundingRate: asNum(anomalyCtx.anomaly_basket_funding_rate),
        anomalyPriceOiGap: asNum(anomalyCtx.anomaly_price_oi_gap),
        anomalyOiTrendDeviation: asNum(anomalyCtx.anomaly_oi_trend_deviation),
        oi15: asNum(item?.deltas?.["15m"]?.oi_change_pct),
        lean15m: String(item?.deltas?.["15m"]?.lean || "").toLowerCase(),
        lean1h: String(item?.deltas?.["1h"]?.lean || "").toLowerCase(),
        wickMeta: null,
        dps: null,
        bottoming: null,
        externalBias: "neutral",
        externalContextAdj: 0,
        externalContextOk: !!externalTelemetry?.ok,
        externalContextReason: String(externalTelemetry?.reason || "telemetry_only|missing"),
        externalContextComponentSummary: buildExternalTelemetrySummary(externalTelemetry),
        coinDayPct: externalTelemetry?.coinDayPct ?? null,
        vixDayPct: externalTelemetry?.vixDayPct ?? null,
        dxyDayPct: externalTelemetry?.dxyDayPct ?? null,
        qqqDayPct: externalTelemetry?.qqqDayPct ?? null,
        spxDayPct: externalTelemetry?.spxDayPct ?? null,
        us2yDelta: externalTelemetry?.us2yDelta ?? null,
        btc5mPrice5mPct: btcTapeContext?.price5mPct ?? null,
        btc5mPrice15mPct: btcTapeContext?.price15mPct ?? null,
        btc5mPrice30mPct: btcTapeContext?.price30mPct ?? null,
        btc5mPrice60mPct: btcTapeContext?.price60mPct ?? null,
        btc5mOi5mPct: btcTapeContext?.oi5mPct ?? null,
        btc5mOi15mPct: btcTapeContext?.oi15mPct ?? null,
        btc5mOi30mPct: btcTapeContext?.oi30mPct ?? null,
        btc5mOi60mPct: btcTapeContext?.oi60mPct ?? null,
        btc5mFunding: btcTapeContext?.funding ?? null,
        btc5mFunding5mAvg: btcTapeContext?.funding5mAvg ?? null,
        btc5mFunding15mAvg: btcTapeContext?.funding15mAvg ?? null,
        btc5mFunding30mAvg: btcTapeContext?.funding30mAvg ?? null,
        btcTapeState: String(btcTapeContext?.tapeState || "neutral"),
        isUsEquityRth: getEtSessionTelemetry(Date.now()).is_us_equity_rth,
        symbolVsBtc15mPct: item?.market_context?.symbol_vs_btc_15m_pct ?? null,
        symbolVsBtc1hPct: item?.market_context?.symbol_vs_btc_1h_pct ?? null,
        symbolVsEth15mPct: item?.market_context?.symbol_vs_eth_15m_pct ?? null,
        symbolVsEth1hPct: item?.market_context?.symbol_vs_eth_1h_pct ?? null,
        cryptoBreadth15mPct: item?.market_context?.crypto_breadth_15m_pct ?? null,
        cryptoBreadth1hPct: item?.market_context?.crypto_breadth_1h_pct ?? null,
        cryptoBreadthTilt15m: item?.market_context?.crypto_breadth_tilt_15m ?? "",
        cryptoBreadthTilt1h: item?.market_context?.crypto_breadth_tilt_1h ?? "",
        spotVsPerp15mPct: item?.market_structure?.spot_vs_perp_15m_pct ?? null,
        spotVsPerp1hPct: item?.market_structure?.spot_vs_perp_1h_pct ?? null,
        spreadBps: item?.market_structure?.spread_bps ?? null,
        bookBidDepth20Usd: item?.market_structure?.book_bid_depth_20_usd ?? null,
        bookAskDepth20Usd: item?.market_structure?.book_ask_depth_20_usd ?? null,
        bookImbalance20: item?.market_structure?.book_imbalance_20 ?? null,
        thinBookFlag: item?.market_structure?.thin_book_flag ?? null,
        marketStructureOk: item?.market_structure?.market_structure_ok ?? false,
        marketStructureReason: item?.market_structure?.market_structure_reason || "missing_from_multi_item",
        btcMacro: {
          ok: !!macroMode?.ok,
          reason: String(macroMode?.reason || ""),
          tf: String(macroMode?.tf || ""),
          lean: String(macroMode?.btc?.lean || ""),
          pricePct: macroMode?.btc?.pricePct ?? null,
          oiPct: macroMode?.btc?.oiPct ?? null,
          bullExpansion: !!macroMode?.btcBullExpansion,
        },
        selectorFamily: `pooled_recipe_${recipe.mode}_${recipe.side}`,
        selectorAllowed: true,
        selectorRejectionReason: "",
      },
    };

    if (recipe.matches(t)) candidates.push(t);
  }

  return candidates;
}
  

    // Debug-only: show build regime per symbol (so you can confirm gate inputs)
const debug_build_regimes =
  debug && modes.includes("build")
    ? (j.results || []).map((it) => ({
        symbol: it?.symbol,
        ok: it?.ok,
        regime: it?.build_regime?.regime ?? null,
        score: it?.build_regime?.score ?? null,
        warmup: it?.build_regime?.warmup ?? null,
        points: it?.build_regime?.inputs?.points72 ?? null,
      }))
    : undefined;

async function evaluateCandidate({
  item,
  modeList = modes,
  forcedBias = null,
  observationType = "fired",
  randomGroupId = "",
  randomSource = "",
  analyticsOnly = false,
  rawObservation = false,
}) {
  const instId = String(item?.instId || "");
  const symbol = String(item?.symbol || "?");
  const levels = await computeLevelsFromSeries(instId);

  function buildCandidate({
    mode,
    bias,
    baseBias,
    triggers = [],
    b1 = null,
    entryLine = null,
    execReason = null,
    execDetail = null,
    curState = null,
    dps = null,
    wickMeta = null,
    bottoming = null,
    rejectionReason = "",
  }) {
    // Legacy aggregate is retired. Raw external-market values below are capture-only.
    const externalContextAdj = 0;

        const anomalyCtx = getAnomalyEventFields(symbol);

    return {
      mode,
      instId,
      _rawItem: item,
      symbol,
      price: item.price,
      bias,
      baseBias,
      triggers,
      levels,
      b1,
      entryLine,
      execReason,
      execDetail,
      curState,
      observationType,
      randomGroupId,
      randomSource,
      analyticsOnly,
      rejectionReason,
      ctx: {
        anomalyTf: anomalyCtx.anomaly_tf || "",
        anomalyScore: asNum(anomalyCtx.anomaly_score),
        anomalyRank: asNum(anomalyCtx.anomaly_rank),
        anomalyPricePct: asNum(anomalyCtx.anomaly_price_pct),
        anomalyOiPct: asNum(anomalyCtx.anomaly_oi_pct),
        anomalyFundingRate: asNum(anomalyCtx.anomaly_funding_rate),
        anomalyPattern: anomalyCtx.anomaly_pattern || "",
        anomalyBasketPricePct: asNum(anomalyCtx.anomaly_basket_price_pct),
        anomalyBasketOiPct: asNum(anomalyCtx.anomaly_basket_oi_pct),
        anomalyBasketFundingRate: asNum(anomalyCtx.anomaly_basket_funding_rate),
        anomalyPriceOiGap: asNum(anomalyCtx.anomaly_price_oi_gap),
        anomalyOiTrendDeviation: asNum(anomalyCtx.anomaly_oi_trend_deviation),
        oi15: asNum(item?.deltas?.["15m"]?.oi_change_pct),
        lean15m: String(item?.deltas?.["15m"]?.lean || "").toLowerCase(),
        lean1h: String(item?.deltas?.["1h"]?.lean || "").toLowerCase(),
        wickMeta: wickMeta || null,
        dps: dps || null,
        bottoming: bottoming || null,
        externalBias: "neutral",
        externalContextAdj,
        externalContextOk: !!externalTelemetry?.ok,
        externalContextReason: String(externalTelemetry?.reason || "telemetry_only|missing"),
        externalContextComponentSummary: buildExternalTelemetrySummary(externalTelemetry),
        coinDayPct: externalTelemetry?.coinDayPct ?? null,
        vixDayPct: externalTelemetry?.vixDayPct ?? null,
        dxyDayPct: externalTelemetry?.dxyDayPct ?? null,
        qqqDayPct: externalTelemetry?.qqqDayPct ?? null,
        spxDayPct: externalTelemetry?.spxDayPct ?? null,
        us2yDelta: externalTelemetry?.us2yDelta ?? null,
        btc5mPrice5mPct: btcTapeContext?.price5mPct ?? null,
        btc5mPrice15mPct: btcTapeContext?.price15mPct ?? null,
        btc5mPrice30mPct: btcTapeContext?.price30mPct ?? null,
        btc5mPrice60mPct: btcTapeContext?.price60mPct ?? null,
        btc5mOi5mPct: btcTapeContext?.oi5mPct ?? null,
        btc5mOi15mPct: btcTapeContext?.oi15mPct ?? null,
        btc5mOi30mPct: btcTapeContext?.oi30mPct ?? null,
        btc5mOi60mPct: btcTapeContext?.oi60mPct ?? null,
        btc5mFunding: btcTapeContext?.funding ?? null,
        btc5mFunding5mAvg: btcTapeContext?.funding5mAvg ?? null,
        btc5mFunding15mAvg: btcTapeContext?.funding15mAvg ?? null,
        btc5mFunding30mAvg: btcTapeContext?.funding30mAvg ?? null,
        btcTapeState: String(btcTapeContext?.tapeState || "neutral"),
        isUsEquityRth: getEtSessionTelemetry(Date.now()).is_us_equity_rth,
        symbolVsBtc15mPct: item?.market_context?.symbol_vs_btc_15m_pct ?? null,
        symbolVsBtc1hPct: item?.market_context?.symbol_vs_btc_1h_pct ?? null,
        symbolVsEth15mPct: item?.market_context?.symbol_vs_eth_15m_pct ?? null,
        symbolVsEth1hPct: item?.market_context?.symbol_vs_eth_1h_pct ?? null,
        cryptoBreadth15mPct: item?.market_context?.crypto_breadth_15m_pct ?? null,
        cryptoBreadth1hPct: item?.market_context?.crypto_breadth_1h_pct ?? null,
        cryptoBreadthTilt15m: item?.market_context?.crypto_breadth_tilt_15m ?? "",
        cryptoBreadthTilt1h: item?.market_context?.crypto_breadth_tilt_1h ?? "",
        spotVsPerp15mPct: item?.market_structure?.spot_vs_perp_15m_pct ?? null,
        spotVsPerp1hPct: item?.market_structure?.spot_vs_perp_1h_pct ?? null,
        spreadBps: item?.market_structure?.spread_bps ?? null,
        bookBidDepth20Usd: item?.market_structure?.book_bid_depth_20_usd ?? null,
        bookAskDepth20Usd: item?.market_structure?.book_ask_depth_20_usd ?? null,
        bookImbalance20: item?.market_structure?.book_imbalance_20 ?? null,
        thinBookFlag: item?.market_structure?.thin_book_flag ?? null,
        marketStructureOk: item?.market_structure?.market_structure_ok ?? false,
        marketStructureReason: item?.market_structure?.market_structure_reason || "missing_from_multi_item",
      },
    };
  }

  const defaultMode = String(modeList?.[0] || "scalp").toLowerCase();
  const defaultBaseBias = biasFromItem(item, defaultMode);
  const defaultBias = forcedBias || defaultBaseBias;

  // Random is intentionally sampled before every live candidate, selector, and
  // manual-trade gate. We may calculate the same pre-entry features for analysis,
  // but no gate can reject or redefine the sampled observation.
  if (rawObservation) {
    const { triggers, curState } = evaluateCriteria(item, null, defaultMode);
    const b1 = strongRecoB1({ bias: defaultBias, levels, price: item.price });
    const candidate = buildCandidate({
      mode: defaultMode,
      bias: defaultBias,
      baseBias: defaultBaseBias,
      triggers,
      b1,
      curState,
    });

    const macroMode = computeBtcMacro(j.results || [], defaultMode);
    const selectorPolicy = evaluateSelectorPolicy(candidate);
    candidate.ctx = {
      ...(candidate.ctx || {}),
      btcMacro: {
        ok: !!macroMode?.ok,
        reason: String(macroMode?.reason || ""),
        tf: String(macroMode?.tf || ""),
        lean: String(macroMode?.btc?.lean || ""),
        pricePct: macroMode?.btc?.pricePct ?? null,
        oiPct: macroMode?.btc?.oiPct ?? null,
        bullExpansion: !!macroMode?.btcBullExpansion,
      },
      selectorFamily: selectorPolicy.family,
      selectorAllowed: selectorPolicy.allowed,
      selectorRejectionReason: selectorPolicy.reason,
    };

    return {
      winner: candidate,
      winners: [candidate],
      candidate,
      rejectionReason: "",
      rejectionMode: "",
      rejectionBias: "",
      rejectionDetail: null,
    };
  }

  if (!force && levels?.["1h"]?.warmup) {
    if (debug) skipped.push({ symbol, reason: "warmup_gate_1h" });
    return {
      winner: null,
      candidate: buildCandidate({
        mode: defaultMode,
        bias: defaultBias,
        baseBias: defaultBaseBias,
        rejectionReason: "warmup_gate_1h",
      }),
      rejectionReason: "warmup_gate_1h",
      rejectionMode: defaultMode,
      rejectionBias: defaultBias,
      rejectionDetail: null,
    };
  }

  let winner = null;
  const winners = [];
  let candidate = null;
  let lastReject = {
    reason: "",
    mode: "",
    bias: defaultBias || "",
    detail: null,
  };

  for (const mode of modeList) {
    const lastStateModeRaw = await redis.get(CFG.keys.lastState(mode, instId));
    const lastState = lastStateModeRaw ? String(lastStateModeRaw) : null;

    const { triggers, curState } = evaluateCriteria(item, lastState, mode);

    const baseBias = biasFromItem(item, mode);
    let dps = null;
    let bias = forcedBias || baseBias;

    if (!forcedBias && (mode === "swing" || mode === "build") && baseBias === "neutral" && CFG.dps?.enabled) {
      const recentPtsForDps = await getRecentSeriesPoints(
        instId,
        Math.max(2, CFG.wick.sweepLookbackPoints)
      );
      const lastPtForDps = recentPtsForDps.length
        ? recentPtsForDps[recentPtsForDps.length - 1]
        : null;

      dps = computeDps({
        levels,
        price: item.price,
        lastPoint: lastPtForDps,
      });

      if (dps?.bias && dps.bias !== "neutral") bias = dps.bias;
    }

    const b1 = strongRecoB1({ bias, levels, price: item.price });

    candidate = buildCandidate({
      mode,
      bias,
      baseBias,
      triggers,
      b1,
      curState,
      dps,
    });

    // Do not apply pre-Premium cooldown here. Premium repeat control happens
    // after recipe stamping, so non-Premium candidates cannot suppress Premium.

    const { minRangePct } = getModeCfg(mode);
    const rPct = rangePct1h({ levels, price: item.price });
    const deferRangeFloorForSwingShort = mode === "swing" && bias === "short";

    if (!force && Number.isFinite(minRangePct) && minRangePct > 0) {
      if (!Number.isFinite(rPct) || rPct < minRangePct) {
        if (deferRangeFloorForSwingShort) {
          if (debug) skipped.push({
            symbol,
            mode,
            reason: "range_floor_deferred",
            detail: { rangePct1h: rPct, minRangePct },
          });
          candidate = {
            ...candidate,
            ctx: {
              ...(candidate.ctx || {}),
              deferredRangeFloor: {
                hit: true,
                rangePct1h: rPct,
                minRangePct,
              },
            },
          };
        } else {
          if (debug) skipped.push({
            symbol,
            mode,
            reason: "range_floor",
            detail: { rangePct1h: rPct, minRangePct },
          });
          lastReject = { reason: "range_floor", mode, bias, detail: { rangePct1h: rPct, minRangePct } };
          candidate = { ...candidate, rejectionReason: "range_floor" };
          continue;
        }
      }
    }

    const macroMode = computeBtcMacro(j.results || [], mode);

    // Preserve the exact mode-specific BTC macro state used by the live gate.
    // This is analytics-only telemetry; it does not alter routing.
    candidate = {
      ...candidate,
      ctx: {
        ...(candidate?.ctx || {}),
        btcMacro: {
          ok: !!macroMode?.ok,
          reason: String(macroMode?.reason || ""),
          tf: String(macroMode?.tf || ""),
          lean: String(macroMode?.btc?.lean || ""),
          pricePct: macroMode?.btc?.pricePct ?? null,
          oiPct: macroMode?.btc?.oiPct ?? null,
          bullExpansion: !!macroMode?.btcBullExpansion,
        },
      },
    };

    if (
      !force &&
      CFG.macro.enabled &&
      CFG.macro.blockShortsOnAltsWhenBtcBull &&
      macroMode?.ok &&
      macroMode?.btcBullExpansion &&
      symbol.toUpperCase() !== CFG.macro.btcSymbol &&
      bias === "short"
    ) {
      if (debug) skipped.push({
        symbol,
        mode,
        reason: "macro_block_btc_bull_expansion",
        btc: macroMode?.btc || null,
        tf: macroMode?.tf || null,
      });
      lastReject = { reason: "macro_block_btc_bull_expansion", mode, bias, detail: null };
      candidate = { ...candidate, rejectionReason: "macro_block_btc_bull_expansion" };
      continue;
    }

    const waterfallMode = computeBtcWaterfall(j.results || [], mode);

    if (
      !force &&
      waterfallMode?.ok &&
      waterfallMode?.btcWaterfall &&
      bias === "long"
    ) {
      if (debug) skipped.push({
        symbol,
        mode,
        reason: "btc_waterfall_override",
        btc: waterfallMode?.btc || null,
        tf: waterfallMode?.tf || null,
      });
      lastReject = { reason: "btc_waterfall_override", mode, bias, detail: null };
      candidate = { ...candidate, rejectionReason: "btc_waterfall_override" };
      continue;
    }

      let entryLine = null;
    let execReason = null;
    let execDetail = null;
    let execWickMeta = null;
    let execBottoming = null;

    if (!force) {
      if (mode === "scalp") {
        if (!b1.strong) {
          if (debug) skipped.push({ symbol, mode, reason: `weak_reco:${b1.reason}` });
          lastReject = { reason: `weak_reco:${b1.reason}`, mode, bias, detail: null };
          candidate = { ...candidate, rejectionReason: `weak_reco:${b1.reason}` };
          continue;
        }

        const g = await scalpExecutionGate({ instId, item, bias, levels });
        if (!g.ok) {
          if (debug) skipped.push({
            symbol,
            mode,
            reason: `scalp_exec:${g.reason}`,
            bias,
            oi15: item?.deltas?.["15m"]?.oi_change_pct ?? null,
          });
          lastReject = { reason: `scalp_exec:${g.reason}`, mode, bias, detail: g.detail || null };
          candidate = { ...candidate, rejectionReason: `scalp_exec:${g.reason}` };
          continue;
        }

        entryLine = g.entryLine || null;
        execReason = g.reason || null;
        execDetail = g.detail || null;
        execWickMeta = g.wickMeta || null;
        execBottoming = g.bottoming || null;
      } else {
        if (mode === "build") {
          const br = item?.build_regime;
          if (br?.regime === "avoid") {
            if (debug) skipped.push({ symbol, mode, reason: "build_regime_avoid", detail: br });
            lastReject = { reason: "build_regime_avoid", mode, bias, detail: br };
            candidate = { ...candidate, rejectionReason: "build_regime_avoid" };
            continue;
          }
        }

        const modeLabel = mode === "build" ? "BUILD" : "SWING";
        const g = await swingExecutionGate({ instId, bias, levels, item, modeLabel, dps });

        if (!g.ok) {
          if (debug) skipped.push({
            symbol,
            mode,
            reason: `${mode}_exec:${g.reason}`,
            bias,
            detail: g.detail || null,
          });
          lastReject = { reason: `${mode}_exec:${g.reason}`, mode, bias, detail: g.detail || null };
          candidate = { ...candidate, rejectionReason: `${mode}_exec:${g.reason}` };
          continue;
        }

        entryLine = g.entryLine || null;
        execReason = g.reason || null;
        execDetail = g.detail || null;
        execWickMeta = g.wickMeta || null;
        execBottoming = g.bottoming || null;
      }
    }
    winner = buildCandidate({
      mode,
      bias,
      baseBias,
      triggers,
      b1,
      entryLine,
      execReason,
      execDetail,
      curState,
      dps,
      wickMeta: execWickMeta,
      bottoming: execBottoming,
    });

    if (candidate?.ctx) {
      // Preserve execution-specific ctx fields from winner. The earlier candidate
      // ctx can contain null wickMeta/bottoming values, so it must not overwrite
      // the execution gate metadata used by entry_atom_wick_* analytics fields.
      const executionCtx = winner.ctx || {};
      winner.ctx = {
        ...candidate.ctx,
        ...executionCtx,
        wickMeta: executionCtx.wickMeta ?? candidate.ctx?.wickMeta ?? null,
        bottoming: executionCtx.bottoming ?? candidate.ctx?.bottoming ?? null,
        dps: executionCtx.dps ?? candidate.ctx?.dps ?? null,
      };
    }

    const selectorPolicy = evaluateSelectorPolicy(winner);
    winner.ctx = {
      ...(winner.ctx || {}),
      selectorFamily: selectorPolicy.family,
      selectorAllowed: selectorPolicy.allowed,
      selectorRejectionReason: selectorPolicy.reason,
    };

    if (!force && !selectorPolicy.allowed) {
      if (debug) skipped.push({
        symbol,
        mode,
        reason: `selector_policy:${selectorPolicy.reason}`,
        bias,
        detail: { family: selectorPolicy.family, reasons: selectorPolicy.reasons },
      });
      lastReject = {
        reason: `selector_policy:${selectorPolicy.reason}`,
        mode,
        bias,
        detail: { family: selectorPolicy.family, reasons: selectorPolicy.reasons },
      };
      candidate = {
        ...winner,
        rejectionReason: `selector_policy:${selectorPolicy.reason}`,
      };
      winner = null;
      continue;
    }

    winners.push(winner);
    continue;
  }

  return {
    winner: winners[0] || null,
    winners,
    candidate,
    rejectionReason: winners.length ? "" : lastReject.reason,
    rejectionMode: winners.length ? "" : lastReject.mode,
    rejectionBias: winners.length ? "" : lastReject.bias,
    rejectionDetail: winners.length ? null : lastReject.detail,
  };
}

let randomEval = null;
const randomGroupId = `${now}_random`;

if (CFG.randomBaselineEnabled && Array.isArray(j.results) && j.results.length > 0) {
  const roll = Math.floor(Math.random() * 100) + 1;

  if (roll <= CFG.randomBaselinePct) {
    // Full /alert input universe: a valid multi row × active mode × side.
    // Do not call candidate, selector, execution, target, RR, cooldown, or
    // recipe logic before admitting this sample to the Random cohort.
    const eligible = j.results.filter((x) =>
      x?.ok &&
      Number.isFinite(asNum(x?.price)) &&
      String(x?.instId || "").trim()
    );

    if (eligible.length > 0 && modes.length > 0) {
      const pick = eligible[Math.floor(Math.random() * eligible.length)];
      const side = Math.random() < 0.5 ? "long" : "short";
      const modePick = modes[Math.floor(Math.random() * modes.length)];

      randomEval = await evaluateCandidate({
        item: pick,
        modeList: [modePick],
        forcedBias: side,
        observationType: "random",
        randomGroupId,
        randomSource: "pre_gate_full_multi_universe_v1",
        analyticsOnly: true,
        rawObservation: true,
      });
    }
  }
}

for (const item of j.results || []) {
  if (!item?.ok) {
    const detail = String(item?.error || "item_not_ok");
    if (debug) skipped.push({ symbol: item?.symbol || "?", reason: detail });
    continue;
  }

  const directCandidates = await buildDirectManualRecipeCandidates(item);
  if (directCandidates.length) triggered.push(...directCandidates);
}

if (randomEval?.winner) {
  triggered.push(randomEval.winner);
} else if (randomEval?.candidate) {
  triggered.push(randomEval.candidate);
}

const directGroups = new Map(LIVE_MANUAL_RECIPES.map((recipe) => [recipe.id, []]));
const otherTriggered = [];
const randomTriggered = [];

for (const t of triggered) {
  if (String(t?.observationType || "") === "random") {
    randomTriggered.push(t);
    continue;
  }
  const recipe = getLiveManualRecipe(t?.execReason);
  if (recipe) directGroups.get(recipe.id).push(t);
  else otherTriggered.push(t);
}

const orderedTriggered = [];
for (const recipe of LIVE_MANUAL_RECIPES) {
  orderedTriggered.push(...sortManualRecipeCandidates(recipe, directGroups.get(recipe.id)));
}
orderedTriggered.push(...otherTriggered, ...randomTriggered);

const recipeCooldownState = new Map();
for (const recipe of LIVE_MANUAL_RECIPES) {
  const candidates = directGroups.get(recipe.id) || [];
  if (candidates.length === 0 || force) {
    recipeCooldownState.set(recipe.id, { active: false, ageMinutes: null });
    continue;
  }

  const raw = await redis.get(CFG.keys.lastRecipeSentAt(recipe.id)).catch(() => null);
  const sentAt = asNum(raw);
  const ageMinutes = Number.isFinite(sentAt) ? (now - sentAt) / 60000 : null;
  const cooldownMinutes = getRecipeCooldownMinutes(recipe);
  recipeCooldownState.set(recipe.id, {
    active: Number.isFinite(ageMinutes) && ageMinutes >= 0 && ageMinutes < cooldownMinutes,
    ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
    cooldownMinutes,
  });
}

// ---- Build ranked Telegram recipe messages and analytics rows ----

const recipeSelections = new Map(LIVE_MANUAL_RECIPES.map((recipe) => [recipe.id, []]));
const shortlistSize = getRecipeShortlistSize();
for (const t of orderedTriggered) {
  const mode = String(t.mode || "swing").toLowerCase();
  const modeUp = mode.toUpperCase();
  let observationType = t.observationType || "fired";
  const isRandom = observationType === "random";
  let rejectionReason = String(t.rejectionReason || "");
  let isRejected = !!rejectionReason;
  const lateRejectionReasons = [];
  const randomGroupIdForEvent = t.randomGroupId || "";
  const randomSourceForEvent = t.randomSource || "";

  // ENTRY ZONE stays 1h B1 band (per your current spec)
  const levels = t.levels;
  const l1h = t.levels?.["1h"];
  const hi1h = l1h && !l1h.warmup ? asNum(l1h.hi) : null;
  const lo1h = l1h && !l1h.warmup ? asNum(l1h.lo) : null;
  const mid1h = hi1h != null && lo1h != null ? (hi1h + lo1h) / 2 : null;

    const price = asNum(t.price);
  const bias = String(t.bias || "neutral").toLowerCase();
  const biasUp = bias.toUpperCase();

  const anomalyCtx = getAnomalyEventFields(t.symbol);
  t.ctx = {
    ...(t.ctx || {}),
    anomalyTf: anomalyCtx.anomaly_tf || "",
    anomalyScore: asNum(anomalyCtx.anomaly_score),
    anomalyRank: asNum(anomalyCtx.anomaly_rank),
    anomalyOiPct: asNum(anomalyCtx.anomaly_oi_pct),
    anomalyPattern: anomalyCtx.anomaly_pattern || "",
    anomalyBasketFundingRate: asNum(anomalyCtx.anomaly_basket_funding_rate),
    anomalyPriceOiGap: asNum(anomalyCtx.anomaly_price_oi_gap),
  };

  const confidenceMeta = computeConfidence(t);
  const confidence = confidenceMeta.finalConfidence;
  const entryAtoms = getEntryAtoms(t);
  const recipeStamp = computeRecipeStamp({ t, confidenceMeta, entryAtoms });
  const candidateStamps = computeCandidateStamps({ t, confidenceMeta, entryAtoms });
  const hasAnalyticsCandidateStamp = candidateStamps.length > 0;
  const isPremium = recipeStamp.label === "PREMIUM";
  const isSendableManualTrade = isSendableTradeStamp(recipeStamp);
  const liveRecipe = getLiveManualRecipe(t?.execReason);

  if (!isRandom && liveRecipe) {
    const cooldownState = recipeCooldownState.get(liveRecipe.id) || { active: false };
    if (!force && cooldownState.active) {
      if (debug) skipped.push({
        symbol: t.symbol,
        mode,
        reason: "recipe_cooldown",
        detail: {
          recipe: liveRecipe.id,
          ageMinutes: cooldownState.ageMinutes,
          cooldownMinutes: cooldownState.cooldownMinutes,
        },
      });
      continue;
    }

    if ((recipeSelections.get(liveRecipe.id) || []).length >= shortlistSize) {
      if (debug) skipped.push({
        symbol: t.symbol,
        mode,
        reason: "recipe_shortlist_rank",
        detail: { recipe: liveRecipe.id, shortlistSize },
      });
      continue;
    }
  }

  // Exactly two persisted analytics cohorts:
  // - Random: one pre-gate baseline observation per eligible run.
  // - Fired: only a Premium alert that is rendered and successfully delivered to Telegram.
  // Analytics-only candidate stamps remain metadata on Random rows. Non-Premium
  // candidates are deliberately not appended as a third cohort or relabeled Fired.
  if (!isRandom && !isSendableManualTrade) {
    if (debug) skipped.push({
      symbol: t.symbol,
      mode,
      reason: "non_manual_recipe_not_sendable",
      detail: { execReason: t?.execReason || "", side: bias },
    });
    continue;
  }
  const profile = getTradeProfile(t);
  const wickMeta = t?.ctx?.wickMeta || {};
  const flowPersists = profile.flowPersists;
  const reversalConfirmed = profile.reversalConfirmed;
  const breakoutOnly = profile.pureBreakoutOnly;
  const dynamicRisk =
  mode === "swing"
    ? computeDynamicRiskBudget({ mode, t })
    : null;


  // MODE-AWARE INVALIDATION TF (fallback-safe)
  const invTfRaw = invalidationTfForMode(mode); // you added this helper
  const invTf = t.levels?.[invTfRaw] && !t.levels?.[invTfRaw]?.warmup ? invTfRaw : "1h";
  const invLvl = t.levels?.[invTf];
  const invHi = invLvl && !invLvl.warmup ? asNum(invLvl.hi) : null;
  const invLo = invLvl && !invLvl.warmup ? asNum(invLvl.lo) : null;

  // Padding knobs (defaults 0 until you decide)
  const invPadPct = Number(process.env.ALERT_INVALIDATION_PAD_PCT || 0); // ex: 0.05 = 0.05% (NOT 5%)

  // Compute invalidation (PRE-trade structure bail line)
  let invalidationPx = null;
  if (bias === "long" && invLo != null) invalidationPx = invLo * (1 - invPadPct / 100);
  if (bias === "short" && invHi != null) invalidationPx = invHi * (1 + invPadPct / 100);

  // Compute stop loss (POST-trade risk line) — currently anchored to 1h extremes w/ padding
  const stopLossPx = await computeStopLossPx({
  instId: t.instId,
  mode,
  bias,
  price,
  levels: t.levels,
  execReason: t.execReason,
});

const lev = computeLeverageFromStop({
  mode,
  entryPrice: price,
  stopLossPx,
  item: t._rawItem,
  dynamicRisk,
});
const minLev = Number(process.env.ALERT_MIN_LEVERAGE || 0);

if (!force) {
  const effectiveLev = Number(lev?.suggestedHigh || 0);

 if (effectiveLev < minLev) {
    if (!isRandom) skipped.push({
      symbol: t.symbol,
      mode,
      reason: hasAnalyticsCandidateStamp ? "candidate_leverage_floor_advisory" : "leverage_floor",
      bias,
      detail: {
        riskBudgetPct: lev?.riskBudgetPct ?? null,
        baseRiskBudgetPct: lev?.baseRiskBudgetPct ?? null,
        dynamicRisk: lev?.dynamicRisk ?? null,
        suggestedLow: lev?.suggestedLow ?? null,
        suggestedHigh: lev?.suggestedHigh ?? null,
        minLev,
      },
    });
    if (!hasAnalyticsCandidateStamp) {
      lateRejectionReasons.push("leverage_floor");
      if (!isRejected) {
        if (!isRandom) {
          continue;
        }
      }
    }
  }
}



  // ---- Block ----
  // If you want the mode header per-trade instead of once at top, uncomment:
  // lines.push(`⚡️ ${modeUp} TRADE ENTRY`);
  // lines.push("");

  // Take Profit (DYNAMIC TF)
// dynamic TP
const { minTpPct } = getModeCfg(mode);

const tpPick = chooseDynamicTp({
  mode,
  bias,
  price,
  levels,
  minTpPct,
  stopLossPx,
});

if (!tpPick) {
  if (!isRandom) skipped.push({ symbol: t.symbol, mode, reason: isPremium ? "premium_no_dynamic_tp_advisory" : "no_dynamic_tp" });
  if (!isPremium && !hasAnalyticsCandidateStamp) {
    lateRejectionReasons.push("no_dynamic_tp");
    if (!isRejected) {
      if (!isRandom) {
        continue;
      }
    }
  }
}

const tp = tpPick?.tp ?? null;
const tpTf = tpPick?.tf || "";
const tpPct = tpPick?.tpPct ?? null;
if (mode === "build" && Number.isFinite(tpPct) && tpPct < CFG.minTpPctByMode.build) {
  skipped.push({
    symbol: t.symbol,
    mode,
    reason: "build_tp_too_small",
    detail: {
      tpPct,
      minTpPct: CFG.minTpPctByMode.build,
      forced: !!tpPick?.forced,
      entryPrice: price,
      tp,
      tpTf,
    },
  });

  if (!isPremium && !hasAnalyticsCandidateStamp) {
    lateRejectionReasons.push("build_tp_too_small");
    if (!isRejected) {
      if (!isRandom) {
        continue;
      }
    }
  }
}
const buildTargets = mode === "build"
  ? buildTpLadder({ bias, entryPrice: price, levels })
  : [];
const rrAnchorTp = tp;

const rrInfo = computeRiskReward({
  entryPrice: price,
  stopLossPx,
  tp: rrAnchorTp,
});

if (tpPick && (!rrInfo || rrInfo.rr < CFG.minRR)) {
  skipped.push({
    symbol: t.symbol,
    mode,
    reason: "rr_too_small",
    detail: {
      rr: rrInfo?.rr ?? null,
      minRR: CFG.minRR,
      rewardPct: rrInfo?.rewardPct ?? null,
      riskPct: rrInfo?.riskPct ?? null,
      entryPrice: price,
      stopLossPx,
      tp,
    }
  });

  if (!isPremium && !hasAnalyticsCandidateStamp) {
    lateRejectionReasons.push("rr_too_small");
    if (!isRejected) {
      if (!isRandom) {
        continue;
      }
    }
  }
}
  const deferredRangeFloor = t?.ctx?.deferredRangeFloor;
const shouldApplyDeferredRangeFloor =
  !force &&
  mode === "swing" &&
  bias === "short" &&
  !!deferredRangeFloor?.hit;

if (shouldApplyDeferredRangeFloor) {
  const onlyHadLocal1hTarget = tpTf === "1h";
  const stillFailsCompletedTrade =
    !tpPick ||
    !rrInfo ||
    rrInfo.rr < CFG.minRR ||
    onlyHadLocal1hTarget;

  if (stillFailsCompletedTrade) {
    skipped.push({
      symbol: t.symbol,
      mode,
      reason: isPremium ? "premium_range_floor_advisory" : "range_floor",
      detail: {
        rangePct1h: deferredRangeFloor?.rangePct1h ?? null,
        minRangePct: deferredRangeFloor?.minRangePct ?? null,
        tpTf: tpTf || "",
        rr: rrInfo?.rr ?? null,
        rewardPct: rrInfo?.rewardPct ?? null,
        riskPct: rrInfo?.riskPct ?? null,
        entryPrice: price,
        stopLossPx,
        tp: tp ?? null,
      },
    });

    if (!isPremium && !hasAnalyticsCandidateStamp) {
      lateRejectionReasons.push("range_floor");
      if (!isRejected) {
        if (!isRandom) {
          continue;
        }
      }
    }
  }
}
      console.log("DYNAMIC_RISK", JSON.stringify({
    symbol: t.symbol,
    mode,
    side: bias,
    confidence,
    dynamicRisk,
    leverage: lev ? {
      suggestedLow: lev.suggestedLow,
      suggestedHigh: lev.suggestedHigh,
      stopDistPct: lev.stopDistPct,
      riskBudgetPct: lev.riskBudgetPct,
      baseRiskBudgetPct: lev.baseRiskBudgetPct,
    } : null,
  }));
const tradeRead = computeTradeRead({ t, confidenceMeta, rrInfo });
const btcShortTfSignal = confidenceMeta?.btcShortTfSignal || getBtcShortTfSignal(profile);
const analyticsVersionTags = getAnalyticsVersionTags();
let repeatDecision = { reject: false, isReminder: false, reason: "" };

if (!isRandom && !force) {
  const lastFiredRaw = await redis.get(CFG.keys.lastFiredAlert(t.instId, mode)).catch(() => null);
  const lastFiredState = safeJsonParse(lastFiredRaw);
  repeatDecision = evaluateRepeatAlertPolicy({
    t,
    recipeStamp,
    tradeRead,
    lastFiredState,
    now,
  });

  if (repeatDecision.reject) {
    if (debug) skipped.push({
      symbol: t.symbol,
      mode,
      reason: repeatDecision.reason,
      detail: { execReason: t?.execReason || "", recipe: recipeStamp.reason || "" },
    });
    continue;
  }
}

const horizonMin = horizonMinForMode(mode);
const evalTiming = buildEvaluationTiming(now, horizonMin);
const sessionTelemetry = getEtSessionTelemetry(now);
const anomaly = getAnomalyEventFields(t.symbol);


const finalRejectionReason = isRandom
  ? ""
  : [
      rejectionReason,
      ...lateRejectionReasons.filter((x) => x && x !== rejectionReason),
    ].filter(Boolean).join("|");
const analyticsEvent = {
  alert_id: isRandom
  ? `${now}_random_${t.symbol}_${mode}_${bias}`
  : `${now}_${t.symbol}_${mode}_${bias}`,
  source: "gateway",
  ts: now,
  ...sessionTelemetry,
  due_ts: evalTiming.dueTs,
  eval_bucket: evalTiming.evalBucket,
  eval_ts_effective: evalTiming.evalTsEffective,
  symbol: t.symbol,
  instId: t.instId,
  driver_tf,
  mode,
  side: bias,
  entry_price: price,
  tp_price: tp ?? "",
  stop_loss: stopLossPx ?? "",
  invalidation_price: invalidationPx ?? "",
  rr: rrInfo?.rr ?? "",
  confidence,
  confidence_base: confidenceMeta.baseConfidence,
  confidence_score: confidenceMeta.finalScore,  
  ...analyticsVersionTags,
  trade_read_label: tradeRead.label,
  trade_read_score: tradeRead.score,
  trade_read_summary: tradeRead.summary,
  trade_read_cautions: tradeRead.cautions.join(","),
  btc_short_tf_state: btcShortTfSignal.state,
  btc_short_tf_confidence_adj: btcShortTfSignal.confidenceAdj,
  btc_short_tf_reasons: btcShortTfSignal.reasons.join(","),
  btc_short_tf_cautions: btcShortTfSignal.cautions.join(","),
  selector_family: confidenceMeta.selectorFamily || t?.ctx?.selectorFamily || "",
  selector_allowed: confidenceMeta.selectorAllowed,
  selector_rejection_reason: confidenceMeta.selectorReason || t?.ctx?.selectorRejectionReason || "",
  anomaly_pattern_adj: confidenceMeta.anomalyPatternAdj ?? "",
  ext_context_adj: confidenceMeta.extAdj,
  ext_context_bias: confidenceMeta.externalBias,
  exec_reason: t?.execReason || "",
  recipe_stamp_label: recipeStamp.label || "",
  recipe_stamp_reason: recipeStamp.reason || "",
  recipe_stamp_profile: recipeStamp.profile || "",
  candidate_stamp_labels: candidateStamps.map((x) => x.label).join(","),
  candidate_stamp_reasons: candidateStamps.map((x) => x.reason).join(" | "),
  candidate_stamp_profiles: candidateStamps.map((x) => x.profile).join(" | "),
  premium_realert: !!repeatDecision.isReminder,
  premium_realert_reason: repeatDecision.reason || "",
  premium_realert_entry_distance_pct: repeatDecision.entryDistancePct ?? "",
  ...entryAtoms,
b1_strong: !!t?.b1?.strong,
lean_15m: t?.ctx?.lean15m || "",
lean_1h: t?.ctx?.lean1h || "",
oi_15m_pct: t?.ctx?.oi15 ?? "",
wick_strong: !!wickMeta?.strong,
wick_extreme: !!wickMeta?.extreme,
flow_persists: flowPersists,
reversal_confirmed: reversalConfirmed,
breakout_only: breakoutOnly,
    leverage_suggested_low: lev?.suggestedLow ?? "",
  leverage_suggested_high: lev?.suggestedHigh ?? "",
  leverage_stop_dist_pct: lev?.stopDistPct ?? "",
  min_lev: minLev ?? "",
  risk_budget_pct: lev?.riskBudgetPct ?? dynamicRisk?.effectiveRiskPct ?? "",
  risk_budget_base_pct: lev?.baseRiskBudgetPct ?? dynamicRisk?.baseRiskPct ?? "",
  risk_budget_multiplier: dynamicRisk?.multiplier ?? "",
  risk_budget_score: dynamicRisk?.score ?? "",
  risk_budget_reasons: (dynamicRisk?.reasons || []).join(","),
   horizon_min: horizonMin,
status: isRandom ? "PENDING" : (finalRejectionReason ? "DONE" : "PENDING"),
exit_price: "",
return_pct: "",
abs_return_pct: "",
mfe_pct: "",
mae_pct: "",
mfe_before_due_pct: "",
mae_before_due_pct: "",
hit_1r: "",
hit_1_5r: "",
hit_2r: "",
time_to_mfe_min: "",
return_at_due_pct: "",
return_at_2x_due_pct: "",
time_to_1r_min: "",
time_to_1_5r_min: "",
time_to_2r_min: "",
first_hit_level: "",
first_hit_min: "",
mfe_giveback_pct: "",
return_10m_pct: "",
return_20m_pct: "",
return_30m_pct: "",
return_60m_pct: "",
best_return_before_due_pct: "",
worst_return_before_due_pct: "",
result: isRandom ? "" : (finalRejectionReason ? "SKIPPED" : ""),
gateway_version: deployInfo.sha || "",
observation_type: observationType,
    ext_context_ok: !!t?.ctx?.externalContextOk,
ext_context_reason: t?.ctx?.externalContextReason || "",
ext_context_component_summary: t?.ctx?.externalContextComponentSummary || "",
coin_day_pct: t?.ctx?.coinDayPct ?? "",
vix_day_pct: t?.ctx?.vixDayPct ?? "",
dxy_day_pct: t?.ctx?.dxyDayPct ?? "",
qqq_day_pct: t?.ctx?.qqqDayPct ?? "",
spx_day_pct: t?.ctx?.spxDayPct ?? "",
us2y_delta: t?.ctx?.us2yDelta ?? "",
btc_5m_price_5m_pct: t?.ctx?.btc5mPrice5mPct ?? "",
btc_5m_price_15m_pct: t?.ctx?.btc5mPrice15mPct ?? "",
btc_5m_price_30m_pct: t?.ctx?.btc5mPrice30mPct ?? "",
btc_5m_price_60m_pct: t?.ctx?.btc5mPrice60mPct ?? "",
btc_5m_oi_5m_pct: t?.ctx?.btc5mOi5mPct ?? "",
btc_5m_oi_15m_pct: t?.ctx?.btc5mOi15mPct ?? "",
btc_5m_oi_30m_pct: t?.ctx?.btc5mOi30mPct ?? "",
btc_5m_oi_60m_pct: t?.ctx?.btc5mOi60mPct ?? "",
btc_5m_funding: t?.ctx?.btc5mFunding ?? "",
btc_5m_funding_5m_avg: t?.ctx?.btc5mFunding5mAvg ?? "",
btc_5m_funding_15m_avg: t?.ctx?.btc5mFunding15mAvg ?? "",
btc_5m_funding_30m_avg: t?.ctx?.btc5mFunding30mAvg ?? "",
btc_tape_state: t?.ctx?.btcTapeState || "",
btc_macro_ok: !!t?.ctx?.btcMacro?.ok,
btc_macro_reason: t?.ctx?.btcMacro?.reason || "",
btc_macro_tf: t?.ctx?.btcMacro?.tf || "",
btc_macro_lean: t?.ctx?.btcMacro?.lean || "",
btc_macro_price_pct: t?.ctx?.btcMacro?.pricePct ?? "",
btc_macro_oi_pct: t?.ctx?.btcMacro?.oiPct ?? "",
btc_macro_bull_expansion: !!t?.ctx?.btcMacro?.bullExpansion,
btc_macro_price_threshold_pct: CFG.macro.btcPricePctMin,
btc_macro_oi_threshold_pct: CFG.macro.btcOiPctMin,
btc_macro_block_shorts_enabled: CFG.macro.blockShortsOnAltsWhenBtcBull,
symbol_vs_btc_15m_pct: t?.ctx?.symbolVsBtc15mPct ?? "",
symbol_vs_btc_1h_pct: t?.ctx?.symbolVsBtc1hPct ?? "",
symbol_vs_eth_15m_pct: t?.ctx?.symbolVsEth15mPct ?? "",
symbol_vs_eth_1h_pct: t?.ctx?.symbolVsEth1hPct ?? "",
crypto_breadth_15m_pct: t?.ctx?.cryptoBreadth15mPct ?? "",
crypto_breadth_1h_pct: t?.ctx?.cryptoBreadth1hPct ?? "",
crypto_breadth_tilt_15m: t?.ctx?.cryptoBreadthTilt15m ?? "",
crypto_breadth_tilt_1h: t?.ctx?.cryptoBreadthTilt1h ?? "",
spot_vs_perp_15m_pct: t?.ctx?.spotVsPerp15mPct ?? "",
spot_vs_perp_1h_pct: t?.ctx?.spotVsPerp1hPct ?? "",
spread_bps: t?.ctx?.spreadBps ?? "",
book_bid_depth_20_usd: t?.ctx?.bookBidDepth20Usd ?? "",
book_ask_depth_20_usd: t?.ctx?.bookAskDepth20Usd ?? "",
book_imbalance_20: t?.ctx?.bookImbalance20 ?? "",
thin_book_flag: t?.ctx?.thinBookFlag ?? "",
market_structure_ok: t?.ctx?.marketStructureOk ?? "",
market_structure_reason: t?.ctx?.marketStructureReason || "",
bottoming_triggered: !!t?.ctx?.bottoming?.triggered,
bottoming_score: t?.ctx?.bottoming?.score ?? "",
bottoming_reasons: Array.isArray(t?.ctx?.bottoming?.reasons) ? t.ctx.bottoming.reasons.join(",") : "",
bottoming_downside_stress: !!t?.ctx?.bottoming?.downsideStress,
bottoming_oi_stress: !!t?.ctx?.bottoming?.oiStress,
bottoming_lower_wick_count: t?.ctx?.bottoming?.lowerWickCount ?? "",
bottoming_downside_decelerating: !!t?.ctx?.bottoming?.downsideDecel,
bottoming_positioning_non_confirm: !!t?.ctx?.bottoming?.positioningNonConfirm,
  rejection_reason: finalRejectionReason,
random_group_id: isRandom ? randomGroupIdForEvent : "",
random_source: isRandom ? randomSourceForEvent : "",
  anomaly_tf: anomaly.anomaly_tf,
  anomaly_score: anomaly.anomaly_score,
  anomaly_rank: anomaly.anomaly_rank,
  anomaly_pattern: anomaly.anomaly_pattern,
  anomaly_price_pct: anomaly.anomaly_price_pct,
  anomaly_oi_pct: anomaly.anomaly_oi_pct,
  anomaly_funding_rate: anomaly.anomaly_funding_rate,
  anomaly_basket_price_pct: anomaly.anomaly_basket_price_pct,
  anomaly_basket_oi_pct: anomaly.anomaly_basket_oi_pct,
  anomaly_basket_funding_rate: anomaly.anomaly_basket_funding_rate,
  anomaly_price_oi_gap: anomaly.anomaly_price_oi_gap,
  anomaly_funding_deviation_bps: anomaly.anomaly_funding_deviation_bps,
  anomaly_oi_trend_deviation: anomaly.anomaly_oi_trend_deviation,
  anomaly_price_deviation: anomaly.anomaly_price_deviation
};
analyticsEvents.push(analyticsEvent);

if (!isRandom && isSendableManualTrade && liveRecipe) {
  recipeSelections.get(liveRecipe.id).push({
    t,
    event: analyticsEvent,
    repeatDecision,
    recipeStamp,
  });
}

// TG intentionally omits TP/SL/invalidation/leverage price lines.
// Those values remain captured in analytics and can still gate/reject internally,
// but they are structure heuristics, not sufficiently validated manual instructions.
}

const telegramRowFields = [
  "alert_id",
  "source",
  "ts",
  "day_of_week_et",
  "day_num_et",
  "is_weekend_et",
  "is_us_equity_rth",
  "us_equity_session",
  "due_ts",
  "eval_bucket",
  "eval_ts_effective",
  "symbol",
  "instId",
  "driver_tf",
  "mode",
  "side",
  "entry_price",
  "tp_price",
  "stop_loss",
  "invalidation_price",
  "rr",
  "confidence",
  "confidence_base",
  "confidence_score",
  "selector_version",
  "confidence_version",
  "trade_read_version",
  "ext_context_version",
  "btc_short_tf_version",
  "entry_idea_version",
  "premium_recipe_version",
  "random_baseline_version",
  "trade_read_label",
  "trade_read_score",
  "trade_read_summary",
  "trade_read_cautions",
  "btc_short_tf_state",
  "btc_short_tf_confidence_adj",
  "btc_short_tf_reasons",
  "btc_short_tf_cautions",
  "selector_family",
  "selector_allowed",
  "selector_rejection_reason",
  "anomaly_pattern_adj",
  "exec_reason",
  "recipe_stamp_label",
  "recipe_stamp_reason",
  "recipe_stamp_profile",
  "candidate_stamp_version",
  "candidate_stamp_labels",
  "candidate_stamp_reasons",
  "candidate_stamp_profiles",
  "premium_realert",
  "premium_realert_reason",
  "premium_realert_entry_distance_pct",
  "entry_atom_cont_tf",
  "entry_atom_hi_1h",
  "entry_atom_lo_1h",
  "entry_atom_cont_hi",
  "entry_atom_cont_lo",
  "entry_atom_p5",
  "entry_atom_reversal_min_pct",
  "entry_atom_in_low_band",
  "entry_atom_in_high_band",
  "entry_atom_matched_tfs",
  "entry_atom_match_count",
  "entry_atom_recent_low",
  "entry_atom_recent_high",
  "entry_atom_reclaim_pct",
  "entry_atom_body_now_pct",
  "entry_atom_avg_body_pct",
  "entry_atom_oi_rise_count",
  "entry_atom_price_pct",
  "entry_atom_funding_rate",
  "entry_atom_wick_pct",
  "entry_atom_wick_quality_score",
  "entry_atom_wick_strong",
  "entry_atom_wick_extreme",
  "b1_strong",
  "lean_15m",
  "lean_1h",
  "oi_15m_pct",
  "wick_strong",
  "wick_extreme",
  "flow_persists",
  "reversal_confirmed",
  "breakout_only",
  "ext_context_adj",
  "ext_context_bias",
  "ext_context_ok",
  "ext_context_reason",
  "ext_context_component_summary",
  "coin_day_pct",
  "vix_day_pct",
  "dxy_day_pct",
  "qqq_day_pct",
  "spx_day_pct",
  "us2y_delta",
  "btc_5m_price_5m_pct",
  "btc_5m_price_15m_pct",
  "btc_5m_price_30m_pct",
  "btc_5m_price_60m_pct",
  "btc_5m_oi_5m_pct",
  "btc_5m_oi_15m_pct",
  "btc_5m_oi_30m_pct",
  "btc_5m_oi_60m_pct",
  "btc_5m_funding",
  "btc_5m_funding_5m_avg",
  "btc_5m_funding_15m_avg",
  "btc_5m_funding_30m_avg",
  "btc_tape_state",
  "btc_macro_ok",
  "btc_macro_reason",
  "btc_macro_tf",
  "btc_macro_lean",
  "btc_macro_price_pct",
  "btc_macro_oi_pct",
  "btc_macro_bull_expansion",
  "btc_macro_price_threshold_pct",
  "btc_macro_oi_threshold_pct",
  "btc_macro_block_shorts_enabled",
  "symbol_vs_btc_15m_pct",
  "symbol_vs_btc_1h_pct",
  "symbol_vs_eth_15m_pct",
  "symbol_vs_eth_1h_pct",
  "crypto_breadth_15m_pct",
  "crypto_breadth_1h_pct",
  "crypto_breadth_tilt_15m",
  "crypto_breadth_tilt_1h",
  "spot_vs_perp_15m_pct",
  "spot_vs_perp_1h_pct",
  "spread_bps",
  "book_bid_depth_20_usd",
  "book_ask_depth_20_usd",
  "book_imbalance_20",
  "thin_book_flag",
  "market_structure_ok",
  "market_structure_reason",
  "bottoming_triggered",
  "bottoming_score",
  "bottoming_reasons",
  "bottoming_downside_stress",
  "bottoming_oi_stress",
  "bottoming_lower_wick_count",
  "bottoming_downside_decelerating",
  "bottoming_positioning_non_confirm",
  "anomaly_tf",
  "anomaly_score",
  "anomaly_rank",
  "anomaly_pattern",
  "anomaly_price_pct",
  "anomaly_oi_pct",
  "anomaly_funding_rate",
  "anomaly_basket_price_pct",
  "anomaly_basket_oi_pct",
  "anomaly_basket_funding_rate",
  "anomaly_price_oi_gap",
  "anomaly_funding_deviation_bps",
  "anomaly_oi_trend_deviation",
  "anomaly_price_deviation",
  "risk_budget_pct",
  "risk_budget_base_pct",
  "risk_budget_multiplier",
  "risk_budget_score",
  "risk_budget_reasons",
  "leverage_suggested_low",
  "leverage_suggested_high",
  "leverage_stop_dist_pct",
  "min_lev",
  "horizon_min",
  "status",
  "exit_price",
  "return_pct",
  "abs_return_pct",
  "mfe_pct",
  "mae_pct",
  "mfe_before_due_pct",
  "mae_before_due_pct",
  "hit_1r",
  "hit_1_5r",
  "hit_2r",
  "time_to_mfe_min",
  "return_at_due_pct",
  "return_at_2x_due_pct",
  "time_to_1r_min",
  "time_to_1_5r_min",
  "time_to_2r_min",
  "first_hit_level",
  "first_hit_min",
  "mfe_giveback_pct",
  "return_10m_pct",
  "return_20m_pct",
  "return_30m_pct",
  "return_60m_pct",
  "best_return_before_due_pct",
  "worst_return_before_due_pct",
  "result",
  "gateway_version",
  "observation_type",
  "rejection_reason",
  "random_group_id",
  "random_source",
];
    
const telegramDelimiter = "|";

const telegramRows = analyticsEvents
  .filter((e) => e.observation_type === "fired" || e.observation_type === "random")
  .map((e) =>
    telegramRowFields
      .map((k) => {
        const v = e?.[k];
        return v == null ? "" : String(v).replace(/\||\t|\n|\r/g, " ");
      })
      .join(telegramDelimiter)
  );


const telegramMessages = LIVE_MANUAL_RECIPES
  .map((recipe) => {
    const selections = recipeSelections.get(recipe.id) || [];
    const text = buildRankedRecipeTelegramMessage(recipe, selections);
    return {
      recipeId: recipe.id,
      recipe,
      selections,
      events: selections.map((selection) => selection.event),
      text,
    };
  })
  .filter((group) => group.text && group.events.length > 0);

const telegramEvents = telegramMessages.flatMap((group) => group.events);
const renderedTradeCount = telegramEvents.length;
const renderedMessageCount = telegramMessages.length;
let firedRowCount = 0;
const renderedRowCount = telegramRows.length;
const randomRowCount = analyticsEvents.filter(
  (e) => e.observation_type === "random"
).length;

// Debug renders all recipe messages together, but production sends each recipe
// as its own Telegram message so the shortlist stays actionable and coherent.
const message = telegramMessages.map((group) => group.text).join("\n\n---\n\n");

const { itemErrors, topSkips } = summarizeSkips(skipped);

if (renderedTradeCount === 0) {
  if (!dry) {
    analyticsPost = await postAnalyticsBatch(analyticsEvents, {
      deploy_sha:
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.VERCEL_GITHUB_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        null,
      modes,
      risk_profile,
    });
  }

  await writeHeartbeat(
    {
      ts: now,
      iso: new Date(now).toISOString(),
      ok: true,
      modes,
      risk_profile,
            sent: false,
      triggered_count: renderedTradeCount,
      rendered_trade_count: renderedTradeCount,
      rendered_message_count: renderedMessageCount,
      rendered_row_count: renderedRowCount,
      fired_row_count: firedRowCount,
      random_row_count: randomRowCount,
      ...analyticsHeartbeatFields(analyticsPost),
      itemErrors,
      topSkips,
    },
    { dry }
  );

  const heartbeat_last_run = debug ? await readHeartbeat() : undefined;
  const summary = debug
  ? buildDebugSummary({
      symbols,
      modes,
      macroByMode,
      skipped,
      triggered,
      debug_build_regimes,
      btcSymbol: CFG.macro.btcSymbol,
    })
  : undefined;
  return res.json({
    ok: true,
    sent: false,
    ...(debug
      ? {
          deploy: getDeployInfo(),
          multiUrl,
          macro: macroByMode,
          externalTelemetry,
          anomalyRanking,
          skipped,
          triggered,
          rendered_trade_count: renderedTradeCount,
          rendered_message_count: renderedMessageCount,
          rendered_row_count: renderedRowCount,
          fired_row_count: firedRowCount,
          random_row_count: randomRowCount,
          modes,
          debug_build_regimes,
          risk_profile,
          summary,
          renderedMessage: message,
          analytics: analyticsResponseSummary(analyticsPost),
          heartbeat_last_run,
        }
      : {}),
  });
}

    const randomEvents = analyticsEvents.filter((e) => e.observation_type === "random");
    const deliveredGroups = [];
    let failedDelivery = null;

    if (!dry) {
      for (const group of telegramMessages) {
        const tg = await sendTelegram(group.text);
        if (!tg.ok) {
          failedDelivery = {
            recipeId: group.recipeId,
            detail: tg.detail || null,
          };
          break;
        }
        deliveredGroups.push(group);
      }

      const deliveredTelegramEvents = deliveredGroups.flatMap((group) => group.events);
      firedRowCount = deliveredTelegramEvents.length;

      const firedStateWrites = deliveredTelegramEvents
        .filter((e) => e.instId && e.mode)
        .map((e) => {
          const match = orderedTriggered.find(
            (t) =>
              String(t.instId) === String(e.instId) &&
              String(t.mode) === String(e.mode) &&
              String(t.bias) === String(e.side) &&
              String(t.execReason || "") === String(e.exec_reason || "")
          );
          if (!match) return null;
          return writeLastState(match.mode, match.instId, match.curState, { dry: false });
        })
        .filter(Boolean);

      if (firedStateWrites.length > 0) {
        await Promise.all(firedStateWrites);
      }

      const firedAlertStateWrites = deliveredTelegramEvents
        .filter((e) => e.instId && e.mode)
        .map((e) => {
          const state = buildStoredAlertStateFromEvent(e);
          return Promise.all([
            redis.set(CFG.keys.lastFiredAlert(e.instId, e.mode), JSON.stringify(state)).catch(() => null),
            redis.set(CFG.keys.lastPremiumAlert(e.instId, e.mode), JSON.stringify(state)).catch(() => null),
            redis.set(CFG.keys.lastSentAt(e.instId, e.mode), String(now)).catch(() => null),
          ]);
        });

      const recipeCooldownWrites = deliveredGroups.map((group) =>
        redis.set(CFG.keys.lastRecipeSentAt(group.recipeId), String(now)).catch(() => null)
      );

      if (firedAlertStateWrites.length > 0 || recipeCooldownWrites.length > 0) {
        await Promise.all([...firedAlertStateWrites, ...recipeCooldownWrites]);
      }

      const persistedEvents = [...randomEvents, ...deliveredTelegramEvents];
      analyticsPost = await postAnalyticsBatch(persistedEvents, {
        deploy_sha:
          process.env.VERCEL_GIT_COMMIT_SHA ||
          process.env.VERCEL_GITHUB_COMMIT_SHA ||
          process.env.GITHUB_SHA ||
          null,
        modes,
        risk_profile,
        telegram_delivery: failedDelivery ? "partial_failure" : "sent",
      });
    }

    if (failedDelivery) {
      await writeHeartbeat(
        {
          ts: now,
          iso: new Date(now).toISOString(),
          ok: false,
          stage: "telegram_failed",
          modes,
          risk_profile,
          sent: deliveredGroups.length > 0,
          triggered_count: renderedTradeCount,
          rendered_trade_count: renderedTradeCount,
          rendered_message_count: renderedMessageCount,
          rendered_row_count: renderedRowCount,
          fired_row_count: firedRowCount,
          random_row_count: randomRowCount,
          ...analyticsHeartbeatFields(analyticsPost),
          itemErrors,
          topSkips,
          telegram_error: failedDelivery.detail,
          failed_recipe: failedDelivery.recipeId,
        },
        { dry }
      );

      return res.status(500).json({
        ok: false,
        error: "telegram_failed",
        failed_recipe: failedDelivery.recipeId,
        delivered_recipe_count: deliveredGroups.length,
        fired_row_count: firedRowCount,
        detail: failedDelivery.detail,
        ...(debug ? { analytics: analyticsResponseSummary(analyticsPost) } : {}),
      });
    }

    await writeHeartbeat(
      {
        ts: now,
        iso: new Date(now).toISOString(),
        ok: true,
        modes,
        risk_profile,
        sent: !dry && deliveredGroups.length > 0,
        triggered_count: renderedTradeCount,
        rendered_trade_count: renderedTradeCount,
        rendered_message_count: renderedMessageCount,
        rendered_row_count: renderedRowCount,
        fired_row_count: firedRowCount,
        random_row_count: randomRowCount,
        ...analyticsHeartbeatFields(analyticsPost),
        itemErrors,
        topSkips,
      },
      { dry }
    );

    const heartbeat_last_run = debug ? await readHeartbeat() : undefined;
const summary = debug
  ? buildDebugSummary({
      symbols,
      modes,
      macroByMode,
      skipped,
      triggered,
      debug_build_regimes,
      btcSymbol: CFG.macro.btcSymbol,
    })
  : undefined;
    return res.json({
      ok: true,
      sent: !dry && deliveredGroups.length > 0,
      triggered_count: renderedTradeCount,
      ...(debug
        ? {
            deploy: getDeployInfo(),
            multiUrl,
            macro: macroByMode,
            externalTelemetry,
            anomalyRanking,
                      skipped,
          triggered,
          rendered_trade_count: renderedTradeCount,
          rendered_message_count: renderedMessageCount,
          rendered_row_count: renderedRowCount,
          fired_row_count: firedRowCount,
          random_row_count: randomRowCount,
          modes,
          debug_build_regimes,
          risk_profile,
          summary,
          renderedMessage: message,
          analytics: analyticsResponseSummary(analyticsPost),
          heartbeat_last_run,
          }
        : {}),
    });
  } catch (e) {
    const now = Date.now();
    await writeHeartbeat(
      {
        ts: now,
        iso: new Date(now).toISOString(),
        ok: false,
        stage: "handler_exception",
        modes,
        risk_profile,
        sent: false,
        triggered_count: 0,
        ...analyticsHeartbeatFields(analyticsPost),
        error: String(e?.message || e),
      },
      { dry }
    );
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
