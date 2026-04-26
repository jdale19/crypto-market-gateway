// /api/alert.js
// Crypto Market Gateway — mode-aware alerts (scalp strict, swing realistic)
//
// CHANGE (minimal rework):
// - MULTI MODE SELECTION: support mode=scalp,swing,build and DEFAULT_MODES env var
// - PRIORITY: faster mode always wins (SCALP > SWING > BUILD)
// - SCALP: unchanged logic (strict breakout/sweep + strict OI confirmation + B1 required)
// - SWING/BUILD: "B1 reversal" entry option (bounce/reject near 1h extremes)
// - DM COPY: explicit numeric zone ranges (ex: 1.594–1.597)
// - MESSAGE CONTRACT: header includes MODE; uses Entry Zone format (no Entry: line)
// - STATE SEEDING: always seed lastState; for swing/build mirror legacy lastState15m
// - LEVERAGE RECO: rendered in message, and ALERT_MIN_LEVERAGE can hard-gate trades at render stage
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

// Faster always wins
const MODE_PRIORITY = ["scalp", "swing", "build"]; // fastest -> slowest

const ANALYTICS_VERSION_TAGS = Object.freeze({
  selector_version: "selector_v2_2026_04_12",
  confidence_version: "confidence_v2_2026_04_14",
  trade_read_version: "trade_read_v1_2026_04_14",
  ext_context_version: "ext_context_v2_2026_04_11",
  btc_short_tf_version: "btc_short_tf_soft_v1_2026_04_14",
  entry_idea_version: "entry_ideas_v1_2026_04_20",
  random_baseline_version: "random_upstream_v2_2026_04_18",
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
async function postAnalyticsBatch(events, meta = {}) {
  if (!process.env.ANALYTICS_WEBHOOK_URL || !Array.isArray(events) || events.length === 0) return;

  const minPostMinutes = Number(process.env.ANALYTICS_MIN_POST_INTERVAL_MINUTES || 0);
  const throttleKey = String(
    process.env.ANALYTICS_POST_THROTTLE_KEY || "alert:analytics:lastPostAt"
  );

  if (Number.isFinite(minPostMinutes) && minPostMinutes > 0) {
    try {
      const lastPostRaw = await redis.get(throttleKey);
      const lastPostAt = lastPostRaw == null ? null : Number(lastPostRaw);

      if (
        Number.isFinite(lastPostAt) &&
        Date.now() - lastPostAt < minPostMinutes * 60 * 1000
      ) {
        return;
      }
    } catch (_) {}
  }

  try {
    await fetch(process.env.ANALYTICS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "gateway",
        ts: Date.now(),
        ...meta,
        events,
      }),
    });

    if (Number.isFinite(minPostMinutes) && minPostMinutes > 0) {
      await redis.set(throttleKey, String(Date.now())).catch(() => null);
    }
  } catch (_) {}
}

const CFG = {
  cooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 20),
  minRR: Number(process.env.ALERT_MIN_RR || 1.5),
  randomBaselineEnabled: String(process.env.RANDOM_BASELINE_ENABLED || "0") === "1",
  randomBaselinePct: Number(process.env.RANDOM_BASELINE_PCT || 10),
  stop: {
  // candle flip method for reversals
  reversalUseWick: String(process.env.ALERT_STOP_REVERSAL_USE_WICK || "0") === "1", // 0=body, 1=wick
  reversalBodyPct: Number(process.env.ALERT_STOP_REVERSAL_BODY_PCT || 1.0), // 0..1 (1 = full flipped body)
  reversalPadPct: Number(process.env.ALERT_STOP_REVERSAL_PAD_PCT || 0.05), // percent (0.05 = 0.05%)
  contPadPct: Number(process.env.ALERT_STOP_CONT_PAD_PCT || 0.03),          // percent
},
  
  // Defaults
  // NEW: DEFAULT_MODES="scalp,swing" (comma list)
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

  extContext: {
    enabled: String(process.env.ALERT_EXT_CONTEXT_ENABLED || "0") === "1",
    useRawFieldsLive: String(process.env.ALERT_EXT_CONTEXT_USE_RAW_FIELDS_LIVE || "1") === "1",
    swingWeight: Number(process.env.ALERT_EXT_CONTEXT_SWING_WEIGHT || 1),
    scalpWeight: Number(process.env.ALERT_EXT_CONTEXT_SCALP_WEIGHT || 0.5),
    buildWeight: Number(process.env.ALERT_EXT_CONTEXT_BUILD_WEIGHT || 0.25),
    timeoutMs: Number(process.env.ALERT_EXT_CONTEXT_TIMEOUT_MS || 4000),
    coinUrl: String(process.env.ALERT_EXT_CONTEXT_COIN_URL || "https://stooq.com/q/l/?s=coin.us&i=d"),
    vixUrl: String(process.env.ALERT_EXT_CONTEXT_VIX_URL || "https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS"),
    dxyUrl: String(process.env.ALERT_EXT_CONTEXT_DXY_URL || ""),
    qqqUrl: String(process.env.ALERT_EXT_CONTEXT_QQQ_URL || ""),
    spxUrl: String(process.env.ALERT_EXT_CONTEXT_SPX_URL || ""),
    us2yUrl: String(process.env.ALERT_EXT_CONTEXT_US2Y_URL || ""),
    metricWeights: {
      coin: Number(process.env.ALERT_EXT_CONTEXT_METRIC_WEIGHT_COIN || 1.0),
      vix: Number(process.env.ALERT_EXT_CONTEXT_METRIC_WEIGHT_VIX || 1.0),
      dxy: Number(process.env.ALERT_EXT_CONTEXT_METRIC_WEIGHT_DXY || 0.7),
      qqq: Number(process.env.ALERT_EXT_CONTEXT_METRIC_WEIGHT_QQQ || 0.8),
      spx: Number(process.env.ALERT_EXT_CONTEXT_METRIC_WEIGHT_SPX || 0.6),
      us2y: Number(process.env.ALERT_EXT_CONTEXT_METRIC_WEIGHT_US2Y || 0.6),
    },
  },
  
  anomaly: {
  enabled: String(process.env.ALERT_ANOMALY_ENABLED || "1") === "1",
  tf: String(process.env.ALERT_ANOMALY_TF || "15m").toLowerCase(),
  basketSymbols: normalizeSymbols(
    process.env.ALERT_ANOMALY_BASKET_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,NEARUSDT,SUIUSDT"
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
    series5m: (id) => `series5m:${id}`,
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

async function fetchTextWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "Cache-Control": "no-store" },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`http_${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function computePctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function parseStooqDayPct(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("stooq_rows_missing");

  const last = lines[lines.length - 1].split(",");
  if (last.length < 6) throw new Error("stooq_cols_missing");

  const openPx = Number(last[last.length - 5]);
  const close = Number(last[last.length - 2]);

  if (Number.isFinite(close) && Number.isFinite(openPx) && openPx !== 0) {
    return computePctChange(close, openPx);
  }

  throw new Error("stooq_prices_missing");
}

function parseFredDailyPct(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) throw new Error("fred_rows_missing");

  const vals = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    const raw = parts[1];
    if (raw == null || raw === ".") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) vals.push(n);
  }

  if (vals.length < 2) throw new Error("fred_values_missing");
  return computePctChange(vals[vals.length - 1], vals[vals.length - 2]);
}

function parseFredLatestDelta(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) throw new Error("fred_rows_missing");

  const vals = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    const raw = parts[1];
    if (raw == null || raw === ".") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) vals.push(n);
  }

  if (vals.length < 2) throw new Error("fred_values_missing");
  return vals[vals.length - 1] - vals[vals.length - 2];
}

function computeDerivedExternalBias({ coinDayPct, vixDayPct }) {
  if (Number.isFinite(coinDayPct) && Number.isFinite(vixDayPct)) {
    if (coinDayPct > 0 && vixDayPct < 0) return "supportive";
    if (coinDayPct < 0 && vixDayPct > 0) return "defensive";
  }
  return "neutral";
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

async function loadExternalContext() {
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
  };

  if (!CFG.extContext?.enabled) {
    out.reason = "disabled";
    return out;
  }

  const tasks = [
    ["coin", CFG.extContext.coinUrl, parseStooqDayPct],
    ["vix", CFG.extContext.vixUrl, parseFredDailyPct],
    ["dxy", CFG.extContext.dxyUrl, parseStooqDayPct],
    ["qqq", CFG.extContext.qqqUrl, parseStooqDayPct],
    ["spx", CFG.extContext.spxUrl, parseStooqDayPct],
    ["us2y", CFG.extContext.us2yUrl, parseFredLatestDelta],
  ];

  const settled = await Promise.allSettled(
    tasks.map(([_, url, parser]) => {
      if (!String(url || "").trim()) return Promise.resolve(null);
      return fetchTextWithTimeout(url, CFG.extContext.timeoutMs).then(parser);
    })
  );

  const metricMap = Object.fromEntries(tasks.map(([label], idx) => [label, settled[idx]]));

  const coinRes = metricMap.coin;
  const vixRes = metricMap.vix;
  const dxyRes = metricMap.dxy;
  const qqqRes = metricMap.qqq;
  const spxRes = metricMap.spx;
  const us2yRes = metricMap.us2y;

  if (coinRes?.status === "fulfilled" && Number.isFinite(coinRes.value)) out.coinDayPct = coinRes.value;
  if (vixRes?.status === "fulfilled" && Number.isFinite(vixRes.value)) out.vixDayPct = vixRes.value;
  if (dxyRes?.status === "fulfilled" && Number.isFinite(dxyRes.value)) out.dxyDayPct = dxyRes.value;
  if (qqqRes?.status === "fulfilled" && Number.isFinite(qqqRes.value)) out.qqqDayPct = qqqRes.value;
  if (spxRes?.status === "fulfilled" && Number.isFinite(spxRes.value)) out.spxDayPct = spxRes.value;
  if (us2yRes?.status === "fulfilled" && Number.isFinite(us2yRes.value)) out.us2yDelta = us2yRes.value;

  const reasons = [];
  if (!Number.isFinite(out.coinDayPct)) reasons.push(metricFailureReason("coin", coinRes));
  if (!Number.isFinite(out.vixDayPct)) reasons.push(metricFailureReason("vix", vixRes));
  if (String(CFG.extContext.dxyUrl || "").trim() && !Number.isFinite(out.dxyDayPct)) reasons.push(metricFailureReason("dxy", dxyRes));
  if (String(CFG.extContext.qqqUrl || "").trim() && !Number.isFinite(out.qqqDayPct)) reasons.push(metricFailureReason("qqq", qqqRes));
  if (String(CFG.extContext.spxUrl || "").trim() && !Number.isFinite(out.spxDayPct)) reasons.push(metricFailureReason("spx", spxRes));
  if (String(CFG.extContext.us2yUrl || "").trim() && !Number.isFinite(out.us2yDelta)) reasons.push(metricFailureReason("us2y", us2yRes));

  out.bias = computeDerivedExternalBias(out);

  if (Number.isFinite(out.coinDayPct) && Number.isFinite(out.vixDayPct)) {
    out.ok = true;
    out.reason = reasons.length ? `ok|${reasons.join("|")}` : "ok";
    return out;
  }

  out.reason = reasons.join("|") || "missing";
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
function getExternalWeightForMode(mode) {
  const m = String(mode || "").toLowerCase();
  return (
    m === "swing" ? CFG.extContext.swingWeight :
    m === "scalp" ? CFG.extContext.scalpWeight :
    m === "build" ? CFG.extContext.buildWeight :
    0
  );
}

function metricAlignmentFromValue(value, side, polarity = "risk_on") {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return 0;

  const sign = value > 0 ? 1 : -1;
  const longAligned = polarity === "risk_on" ? sign : -sign;
  return String(side || "").toLowerCase() === "long" ? longAligned : -longAligned;
}

function getExternalContextComponents({ side, ctx = {} }) {
  const weights = CFG.extContext.metricWeights || {};
  const out = [];

  const pushMetric = (key, value, weight, polarity) => {
    const align = metricAlignmentFromValue(value, side, polarity);
    if (align == null || !Number.isFinite(weight) || weight <= 0) return;
    out.push({ key, value, weight, align });
  };

  pushMetric("coin", asNum(ctx?.coinDayPct), weights.coin, "risk_on");
  pushMetric("vix", asNum(ctx?.vixDayPct), weights.vix, "risk_off");
  pushMetric("dxy", asNum(ctx?.dxyDayPct), weights.dxy, "risk_off");
  pushMetric("qqq", asNum(ctx?.qqqDayPct), weights.qqq, "risk_on");
  pushMetric("spx", asNum(ctx?.spxDayPct), weights.spx, "risk_on");
  pushMetric("us2y", asNum(ctx?.us2yDelta), weights.us2y, "risk_off");

  return out;
}

function getExternalContextAdj({ mode, side, ctx = {} }) {
  if (!CFG.extContext?.enabled || !CFG.extContext?.useRawFieldsLive) return 0;

  const modeWeight = getExternalWeightForMode(mode);
  if (!Number.isFinite(modeWeight) || modeWeight <= 0) return 0;

  const components = getExternalContextComponents({ side, ctx });
  if (!components.length) return 0;

  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0);
  if (!(totalWeight > 0)) return 0;

  const weighted = components.reduce((sum, item) => sum + item.align * item.weight, 0) / totalWeight;
  return Number((Math.max(-1, Math.min(1, weighted)) * modeWeight).toFixed(2));
}

function getExternalContextComponentSummary({ side, ctx = {} }) {
  return getExternalContextComponents({ side, ctx })
    .map((item) => `${item.key}:${item.align > 0 ? "+" : item.align < 0 ? "-" : "0"}`)
    .join(",");
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
 * - raw external fields are live; derived external bias is explainability-only
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

  const externalRawScore = Number(t?.ctx?.externalContextAdj || 0) || 0;
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
    externalRawScore,
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

 if (profile.mode === "swing" && profile.bias === "short" && profile.reversalConfirmed) {
  reasons.push("short_reversal_disabled");
}

  if (profile.pureBreakoutOnly) {
    reasons.push("pure_breakout_only_disabled");
  }

  if (profile.mode === "swing" && profile.bias === "long" && profile.flowPersists && !profile.reversalConfirmed) {
    if (!(profile.externalRawScore > 0)) reasons.push("flow_persists_long_needs_supportive_external");
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
  const extAdjRaw = Number(t?.ctx?.externalContextAdj || 0);
  const extAdj = Number.isFinite(extAdjRaw) ? extAdjRaw : 0;
  const anomalyPatternAdj = getAnomalyPatternAdj(profile);
  const btcShortTfSignal = getBtcShortTfSignal(profile);

  let adjustedScore = Number((baseScore + extAdj + anomalyPatternAdj + btcShortTfSignal.confidenceAdj).toFixed(2));

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

  if (profile.mode === "swing" && profile.bias === "long" && profile.flowPersists && !profile.reversalConfirmed) {
    if (profile.externalRawScore > 0) adjustedScore += 0.25;
    else adjustedScore -= 0.35;
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
    externalBias: String(t?.ctx?.externalBias || "neutral").toLowerCase(),
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

  const extAdj = Number(confidenceMeta?.extAdj || 0);
  const externalBias = String(confidenceMeta?.externalBias || "neutral").toLowerCase();
  if (extAdj > 0.15) parts.push(`${externalBias} external`);
  else if (extAdj < -0.15) parts.push(`${externalBias} external cap`);

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

    if (profile.externalRawScore > 0.15) {
      score += 1.5;
      positives.push("supportive external");
    } else if (profile.externalRawScore < -0.15) {
      score -= 1.5;
      cautions.push("external drag");
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

    if (profile.externalRawScore > 0.15) {
      score += 1;
      positives.push("external supports side");
    } else if (profile.externalRawScore < -0.15) {
      score -= 1;
      cautions.push("external fights side");
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
function computeRecipeStamp({ t, confidenceMeta }) {
  if (confidenceMeta?.selectorAllowed === false) {
    return { label: "", emoji: "", reason: "selector_rejected" };
  }

  const execReason = String(t?.execReason || "").toLowerCase();
  const finalConfidence = String(
    confidenceMeta?.finalConfidence || t?.confidence || ""
  ).toUpperCase();
  const extAdj = Number(confidenceMeta?.extAdj || 0);
  const externalBias = String(confidenceMeta?.externalBias || "neutral").toLowerCase();
  const anomalyOiPct = asNum(t?.ctx?.anomalyOiPct);

  const supportiveExternal = externalBias === "supportive" && extAdj > 0.15;
  const shortFriendlyExternal = externalBias !== "supportive";

  // PREMIUM should be blind-usable, so keep it limited to the validated pockets only.
  if (execReason === "build_b1_reversal_long" && supportiveExternal) {
    return {
      label: "PREMIUM",
      emoji: "✅",
      reason: `${execReason}_supportive_external`,
    };
  }

  if (execReason === "swing_liquidity_snap_reversal_long" && externalBias !== "neutral") {
    return {
      label: "PREMIUM",
      emoji: "✅",
      reason: `${execReason}_non_neutral_external`,
    };
  }

  if (execReason === "swing_flow_persists_long" && supportiveExternal) {
    return {
      label: "PREMIUM",
      emoji: "✅",
      reason: `${execReason}_supportive_external`,
    };
  }

  if (
    execReason === "swing_flow_persists_short" &&
    finalConfidence === "A" &&
    Number.isFinite(anomalyOiPct) &&
    anomalyOiPct < 0 &&
    shortFriendlyExternal
  ) {
    return {
      label: "PREMIUM",
      emoji: "✅",
      reason: `${execReason}_conf_a_negative_anomaly_oi_no_supportive_external`,
    };
  }

  if (execReason === "swing_ignition_breakout_long" && supportiveExternal) {
    return {
      label: "PREMIUM",
      emoji: "✅",
      reason: `${execReason}_supportive_external`,
    };
  }

  // Intentionally no active AVOID rules yet.
  return { label: "", emoji: "", reason: "no_stamp" };
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

function computeDynamicRiskBudget({ mode, t, confidence }) {
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

  if (confidence === "A") { score += 2; reasons.push("conf_A"); }
  else if (confidence === "B") { score += 1; reasons.push("conf_B"); }

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
const externalContext = await loadExternalContext();
const btcTapeInstId =
  (j.results || []).find(
    (it) => String(it?.symbol || "").toUpperCase() === String(CFG.macro.btcSymbol || "BTCUSDT").toUpperCase()
  )?.instId || btcInstIdFromSymbol(CFG.macro.btcSymbol);
const btcTapeContext = await loadBtcTapeContext(btcTapeInstId);
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
    const externalContextAdj = getExternalContextAdj({
      mode,
      side: bias,
      ctx: externalContext,
    });

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
        anomalyOiPct: asNum(anomalyCtx.anomaly_oi_pct),
        anomalyPattern: anomalyCtx.anomaly_pattern || "",
        oi15: asNum(item?.deltas?.["15m"]?.oi_change_pct),
        lean15m: String(item?.deltas?.["15m"]?.lean || "").toLowerCase(),
        lean1h: String(item?.deltas?.["1h"]?.lean || "").toLowerCase(),
        wickMeta: wickMeta || null,
        dps: dps || null,
        bottoming: bottoming || null,
        externalBias: String(externalContext?.bias || "neutral").toLowerCase(),
        externalContextAdj,
        externalContextOk: !!externalContext?.ok,
        externalContextReason: String(externalContext?.reason || ""),
        externalContextComponentSummary: getExternalContextComponentSummary({ side: bias, ctx: externalContext }),
        coinDayPct: externalContext?.coinDayPct ?? null,
        vixDayPct: externalContext?.vixDayPct ?? null,
        dxyDayPct: externalContext?.dxyDayPct ?? null,
        qqqDayPct: externalContext?.qqqDayPct ?? null,
        spxDayPct: externalContext?.spxDayPct ?? null,
        us2yDelta: externalContext?.us2yDelta ?? null,
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
      },
    };
  }

  const defaultMode = String(modeList?.[0] || "scalp").toLowerCase();
  const defaultBaseBias = biasFromItem(item, defaultMode);
  const defaultBias = forcedBias || defaultBaseBias;

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

    const lastSentRaw = await redis.get(CFG.keys.lastSentAt(instId, mode));
    const lastSent = lastSentRaw == null ? null : Number(lastSentRaw);

    if (!force && lastSent && now - lastSent < CFG.cooldownMinutes * 60 * 1000) {
      if (debug) skipped.push({ symbol, mode, reason: "cooldown" });
      lastReject = { reason: "cooldown", mode, bias, detail: null };
      candidate = { ...candidate, rejectionReason: "cooldown" };
      continue;
    }

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
      winner.ctx = {
        ...(winner.ctx || {}),
        ...candidate.ctx,
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

    break;
  }

  return {
    winner,
    candidate,
    rejectionReason: winner ? "" : lastReject.reason,
    rejectionMode: winner ? "" : lastReject.mode,
    rejectionBias: winner ? "" : lastReject.bias,
    rejectionDetail: winner ? null : lastReject.detail,
  };
}

let randomEval = null;
const randomGroupId = `${now}_random`;

if (CFG.randomBaselineEnabled && Array.isArray(j.results) && j.results.length > 0) {
  const roll = Math.floor(Math.random() * 100) + 1;

  if (roll <= CFG.randomBaselinePct) {
    const eligible = j.results.filter((x) => x?.ok && x?.price);

    if (eligible.length > 0) {
      const pick = eligible[Math.floor(Math.random() * eligible.length)];
      const side = Math.random() < 0.5 ? "long" : "short";
      const modePick = modes[Math.floor(Math.random() * modes.length)];

      randomEval = await evaluateCandidate({
        item: pick,
        modeList: [modePick],
        forcedBias: side,
        observationType: "random",
        randomGroupId,
        randomSource: "upstream_pre_fired_loop",
        analyticsOnly: true,
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

  const evaluated = await evaluateCandidate({ item });
  if (evaluated.winner) triggered.push(evaluated.winner);
}

if (randomEval?.winner) {
  triggered.push(randomEval.winner);
} else if (randomEval?.candidate) {
  triggered.push(randomEval.candidate);
}

// ---- Render DM ----

const lines = [];
for (const t of triggered) {
  const mode = String(t.mode || "swing").toLowerCase();
  const modeUp = mode.toUpperCase();
  const observationType = t.observationType || "fired";
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
    anomalyOiPct: asNum(anomalyCtx.anomaly_oi_pct),
    anomalyPattern: anomalyCtx.anomaly_pattern || "",
  };

  const confidenceMeta = computeConfidence(t);
  const confidence = confidenceMeta.finalConfidence;
  const profile = getTradeProfile(t);
  const wickMeta = t?.ctx?.wickMeta || {};
  const flowPersists = profile.flowPersists;
  const reversalConfirmed = profile.reversalConfirmed;
  const breakoutOnly = profile.pureBreakoutOnly;
  const dynamicRisk =
  mode === "swing"
    ? computeDynamicRiskBudget({ mode, t, confidence })
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
    skipped.push({
      symbol: t.symbol,
      mode,
      reason: "leverage_floor",
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
    lateRejectionReasons.push("leverage_floor");
    if (!isRejected) {
      if (isRandom) {
        rejectionReason = "leverage_floor";
        isRejected = true;
      } else {
        continue;
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
  skipped.push({ symbol: t.symbol, mode, reason: "no_dynamic_tp" });
  lateRejectionReasons.push("no_dynamic_tp");
  if (!isRejected) {
    if (isRandom) {
      rejectionReason = "no_dynamic_tp";
      isRejected = true;
    } else {
      continue;
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

  lateRejectionReasons.push("build_tp_too_small");
  if (!isRejected) {
    if (isRandom) {
      rejectionReason = "build_tp_too_small";
      isRejected = true;
    } else {
      continue;
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

  lateRejectionReasons.push("rr_too_small");
  if (!isRejected) {
    if (isRandom) {
      rejectionReason = "rr_too_small";
      isRejected = true;
    } else {
      continue;
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
      reason: "range_floor",
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

    lateRejectionReasons.push("range_floor");
    if (!isRejected) {
      if (isRandom) {
        rejectionReason = "range_floor";
        isRejected = true;
      } else {
        continue;
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
const tradeCautions = tradeRead.cautions.length ? tradeRead.cautions.join(", ") : "none";
const btcShortTfSignal = confidenceMeta?.btcShortTfSignal || getBtcShortTfSignal(profile);
const recipeStamp = computeRecipeStamp({ t, confidenceMeta });
const analyticsVersionTags = getAnalyticsVersionTags();
const entryAtoms = getEntryAtoms(t);

if (!isRandom) {
  const mainEdge = prettifyDecisionToken(t?.execReason || tradeRead.summary || "n/a");

  lines.push(`[${modeUp}] ${t.symbol} ${price.toFixed(4)} | ${biasUp}`);

  if (recipeStamp.label === "PREMIUM") {
    lines.push(`PREMIUM ${recipeStamp.emoji}`);
  } else if (recipeStamp.label === "AVOID") {
    lines.push(`AVOID ${recipeStamp.emoji}`);
  }

  lines.push(`Main Edge: ${mainEdge}`);
  lines.push(`Why: ${tradeRead.summary}`);
  lines.push(`Cautions: ${tradeCautions}`);
  lines.push("");
}

const horizonMin = horizonMinForMode(mode);
const evalTiming = buildEvaluationTiming(now, horizonMin);
const anomaly = getAnomalyEventFields(t.symbol);


const finalRejectionReason = [
  rejectionReason,
  ...lateRejectionReasons.filter((x) => x && x !== rejectionReason),
].filter(Boolean).join("|");
analyticsEvents.push({
  alert_id: isRandom
  ? `${now}_random_${t.symbol}_${mode}_${bias}`
  : `${now}_${t.symbol}_${mode}_${bias}`,
  source: "gateway",
  ts: now,
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
});

if (!isRandom) {
  lines.push(`Entry: ${price != null ? fmtPrice(price) : ""}`);
  lines.push(`Invalidation: ${invalidationPx != null ? fmtPrice(invalidationPx) : ""}`);

  if (mode === "build" && buildTargets.length) {
    const targetSummary = buildTargets
      .map((target) => `${target.label} ${fmtPrice(target.tp)}`)
      .join(" | ");
    lines.push(`TP: ${targetSummary}`);
  } else {
    lines.push(`TP: ${tp != null ? fmtPrice(tp) : ""}`);
  }

  lines.push(`Stop: ${stopLossPx != null ? fmtPrice(stopLossPx) : ""}`);
  lines.push(`Leverage: ${lev ? `${lev.suggestedLow}–${lev.suggestedHigh}x` : ""}`);
  lines.push("");
}
}

const telegramRowFields = [
  "alert_id",
  "source",
  "ts",
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


const renderedTradeCount = analyticsEvents.filter(
  (e) => e.observation_type === "fired"
).length;

const renderedRowCount = telegramRows.length;

const randomRowCount = analyticsEvents.filter(
  (e) => e.observation_type === "random"
).length;

const messageHeader = renderedTradeCount > 0
  ? "⚡️TRADE ENTRY"
  : "";

const message = renderedTradeCount > 0
  ? [messageHeader, lines.join("\n")]
      .filter(Boolean)
      .join("\n\n")
  : "";

const firedKeys = [
  ...new Set(
    analyticsEvents
      .filter((e) => e.observation_type === "fired" && e.instId && e.mode)
      .map((e) => `${String(e.instId)}__${String(e.mode)}`)
  )
];

const { itemErrors, topSkips } = summarizeSkips(skipped);

if (!force && renderedRowCount === 0) {
  if (!dry) {
    await postAnalyticsBatch(analyticsEvents, {
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
      rendered_row_count: renderedRowCount,
      random_row_count: randomRowCount,
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
          externalContext,
          anomalyRanking,
          skipped,
          triggered,
          rendered_trade_count: renderedTradeCount,
          rendered_row_count: renderedRowCount,
          random_row_count: randomRowCount,
          modes,
          debug_build_regimes,
          risk_profile,
          summary,
          renderedMessage: message,
          heartbeat_last_run,
        }
      : {}),
  });
}

    if (!dry) {
      const tg = await sendTelegram(message);
      
      if (!tg.ok) {
  await writeHeartbeat(
    {
      ts: now,
      iso: new Date(now).toISOString(),
      ok: false,
      stage: "telegram_failed",
      modes,
      risk_profile,
           sent: false,
      triggered_count: renderedTradeCount,
      rendered_trade_count: renderedTradeCount,
      rendered_row_count: renderedRowCount,
      random_row_count: randomRowCount,
      itemErrors,
      topSkips,
      telegram_error: tg.detail || null,
    },
    { dry }
  );
  return res.status(500).json({ ok: false, error: "telegram_failed", detail: tg.detail || null });
        
}
      const firedStateWrites = analyticsEvents
  .filter((e) => e.observation_type === "fired" && e.instId && e.mode)
  .map((e) => {
    const match = triggered.find(
      (t) => String(t.instId) === String(e.instId) && String(t.mode) === String(e.mode)
    );
    if (!match) return null;
    return writeLastState(match.mode, match.instId, match.curState, { dry: false });
  })
  .filter(Boolean);

if (firedStateWrites.length > 0) {
  await Promise.all(firedStateWrites);
}

      if (firedKeys.length > 0) {
  await Promise.all(
    firedKeys.map((key) => {
      const [id, mode] = key.split("__");
      return redis.set(CFG.keys.lastSentAt(id, mode), String(now)).catch(() => null);
    })
  );
}

    await postAnalyticsBatch(analyticsEvents, {
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
                sent: !dry,
        triggered_count: renderedTradeCount,
        rendered_trade_count: renderedTradeCount,
        rendered_row_count: renderedRowCount,
        random_row_count: randomRowCount,
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
      sent: !dry,
      triggered_count: renderedTradeCount,
      ...(debug
        ? {
            deploy: getDeployInfo(),
            multiUrl,
            macro: macroByMode,
            externalContext,
            anomalyRanking,
                      skipped,
          triggered,
          rendered_trade_count: renderedTradeCount,
          rendered_row_count: renderedRowCount,
          random_row_count: randomRowCount,
          modes,
          debug_build_regimes,
          risk_profile,
          summary,
          renderedMessage: message,
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
        error: String(e?.message || e),
      },
      { dry }
    );
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
