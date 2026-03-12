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
// - LEVERAGE RECO: advisory only (compact line) + OI/funding adjustments
//
// Notes:
// - Behavior: same per-mode rules; we just evaluate multiple modes in order and choose first that triggers.
// - Default modes now use DEFAULT_MODES env var (comma list). DEFAULT_MODE is still honored as fallback.
// - Leverage reco is advisory text only; does not change gating.

const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Faster always wins
const MODE_PRIORITY = ["scalp", "swing", "build"]; // fastest -> slowest

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

  telegramMaxChars: 3900,

  // Macro gate (mode-aware timeframe)
macro: {
  enabled: String(process.env.ALERT_MACRO_GATE_ENABLED || "1") === "1",
  btcSymbol: String(process.env.ALERT_MACRO_BTC_SYMBOL || "BTCUSDT").toUpperCase(),

  // Mode -> BTC delta timeframe used for macro
  // Defaults: scalp=1h, swing=1h, build=4h
  btcTfByMode: {
  scalp: String(process.env.ALERT_MACRO_BTC_TF_SCALP || "1h").toLowerCase(),
  swing: String(process.env.ALERT_MACRO_BTC_TF_SWING || "1h").toLowerCase(),
  build: String(process.env.ALERT_MACRO_BTC_TF_BUILD || "4h").toLowerCase(),
},

  // Thresholds apply to the selected BTC timeframe
  btcPricePctMin: Number(process.env.ALERT_MACRO_BTC_PRICE_PCT_MIN || 2.0),
  btcOiPctMin: Number(process.env.ALERT_MACRO_BTC_OI_PCT_MIN || 0.5),

  blockShortsOnAltsWhenBtcBull: String(process.env.ALERT_MACRO_BLOCK_SHORTS_ON_ALTS || "1") === "1",
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

  // --- Leverage Model (advisory copy only) ---
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
    lastSentAt: (id) => `alert:lastSentAt:${id}`,
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

  if (!token || !chatId)
    return { ok: false, detail: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };

  // Hard guard: Telegram limit is 4096 chars. Keep a safety margin.
  const maxChars = Number(CFG.telegramMaxChars || 3800);
  if (text && text.length > maxChars) {
    const over = text.length - maxChars;
    text = text.slice(0, Math.max(0, maxChars - 40)) + `\n\n…(truncated ${over} chars)`;
  }

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) return { ok: false, detail: j };
  return { ok: true };
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
function computeLeverageFromStop({ mode, entryPrice, stopLossPx, item }) {
  if (!CFG.leverage?.enabled) return null;

  const m = String(mode || "scalp").toLowerCase();
  const riskBudgetPct = CFG.leverage?.riskBudgetPctByMode?.[m] ?? 1.0;

  const entry = asNum(entryPrice);
  const sl = asNum(stopLossPx);
  if (entry == null || sl == null) return null;

  const stopDistPct = Math.abs((entry - sl) / entry) * 100;
  if (!Number.isFinite(stopDistPct) || stopDistPct <= 0) return null;

  // base leverage proxy (same model as before, but using stop distance)
  const baseMax = Math.floor(
    Math.max(0, Number(riskBudgetPct) || 0) / Math.max(0.01, stopDistPct)
  );

  // OI adjustment
  const oi5 = Math.abs(asNum(item?.deltas?.["5m"]?.oi_change_pct) ?? 0);
  const oi15 = Math.abs(asNum(item?.deltas?.["15m"]?.oi_change_pct) ?? 0);

  let oiMult = 1;
  if (oi5 > CFG.leverage.oiReduce2 || oi15 > CFG.leverage.oiReduce2) oiMult = 0.6;
  else if (oi5 > CFG.leverage.oiReduce1 || oi15 > CFG.leverage.oiReduce1) oiMult = 0.75;

  // Funding adjustment
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
    flags: { oiReduced: oiMult < 1, fundingReduced: fMult < 1 },
  };
}

/**
 * CONFIDENCE ENGINE (rule-based, mechanical)
 *
 * A:
 *  - B1 zone strong
 *  - 5m reversal confirmed
 *  - 15m OI aligned (we interpret this mechanically as 15m "lean" aligned)
 *  - 1h lean aligned
 *
 * B:
 *  - B1 zone strong
 *  - 5m reversal confirmed
 *  - OI neutral
 *
 * C:
 *  - Breakout-only entry
 *  - Weak OI
 *  - Counter 1h lean
 *
 * No subjective scoring.
 * No string-parsing vibes.
 * Only execReason + ctx fields.
 */
function computeConfidence(t) {
  const bias = String(t?.bias || "").toLowerCase();
  const b1Strong = !!t?.b1?.strong;

  const execReason = String(t?.execReason || "").toLowerCase();

  const reversalConfirmed =
    execReason.includes("b1_reversal") ||
    execReason.includes("wick_reclaim") ||
    execReason.includes("wick_reject") ||
    execReason.includes("wick_flush_reclaim") ||
    execReason.includes("wick_spike_reject") ||
  execReason.includes("liquidity_snap_reversal");

  const wickDriven = execReason.includes("wick");

  const flowPersists =
    execReason.includes("flow_persists_long") ||
    execReason.includes("flow_persists_short") ||
    execReason.includes("flow_persists");

  const breakoutOnly =
    execReason.includes("break_above") ||
    execReason.includes("break_below") ||
    execReason.includes("breakout") ||
    execReason.includes("breakdown") ||
    execReason.includes("ignition_breakout") ||
    execReason.includes("slow_leverage_squeeze") ||
    execReason.includes("slow_short_breakdown");

  const lean15m = String(t?.ctx?.lean15m || "").toLowerCase();
  const oiAligned = lean15m === bias;

  const oi15 = asNum(t?.ctx?.oi15);
  const oiNeutral =
    lean15m === "neutral" ||
    lean15m === "" ||
    (Number.isFinite(oi15) && Math.abs(oi15) < CFG.shockOi15mPct);

  const oiWeak = !oiAligned && !oiNeutral;

  const lean1h = String(t?.ctx?.lean1h || "").toLowerCase();
  const oneHourAligned = lean1h === bias;
  const counter1hLean = lean1h && lean1h !== "neutral" && !oneHourAligned;

  const wickMeta = t?.ctx?.wickMeta || {};
  const wickStrong = !!wickMeta?.strong;
  const wickExtreme = !!wickMeta?.extreme;

  if (flowPersists && oiAligned && oneHourAligned) return "A";
  if (flowPersists && (oiAligned || oneHourAligned)) return "B";
  if (b1Strong && wickDriven && wickExtreme && oiAligned && oneHourAligned) return "A";
  if (b1Strong && wickDriven && wickStrong && oiAligned) return "A";
  if (b1Strong && reversalConfirmed && oiAligned && oneHourAligned) return "A";
  if (b1Strong && wickDriven && wickStrong && oiNeutral) return "B";
  if (b1Strong && reversalConfirmed && oiNeutral) return "B";
  if (breakoutOnly || oiWeak || counter1hLean) return "C";
  return "C";
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

async function swingExecutionGate({ instId, bias, levels, item, modeLabel = "SWING" }) {
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
    10
  );
  const recentPts = await getIdeaWindow(instId, maxIdeaLookback);
  const lastPt = recentPts.length ? recentPts[recentPts.length - 1] : null;
  const wickMeta = wickQuality(lastPt, bias);
  const lastWickPct = wickMeta.wickPct;

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

  if (bias === "long") {
    const ignition = ignitionBreakoutLongCheck(recentPts, p, asNum(item?.funding_rate));
    if (ignition.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_${ignition.reason}`,
        entryLine: ignition.entryLine,
        detail: ignition.detail,
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
      };
    }

    const slowSqueeze = slowLeverageSqueezeLongCheck(recentPts, p);
    if (slowSqueeze.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_${slowSqueeze.reason}`,
        entryLine: slowSqueeze.entryLine,
        detail: slowSqueeze.detail,
      };
    }

    if (p > contHi) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_break_above_${contTf}_high`,
        entryLine: `break above ${contTf} high (${fmtPrice(contHi)}) → continuation`,
      };
    }

    const reversalOk = inLowBand && Number.isFinite(p5) && p5 >= CFG.swingReversalMin5mMovePct;
    if (reversalOk) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_b1_reversal_long`,
        entryLine: `bounce in B1 low band (${lowBandTxt}) + 5m turned up (≥ ${fmtPct(CFG.swingReversalMin5mMovePct)})`,
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
      };
    }

    const flowPersist = flowPersistsAcrossTfs(item, "long");
    if (flowPersist.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_flow_persists_long`,
        entryLine: `flow persists across TFs (${flowPersist.matchedTfs.join("/")}) + OI aligned`,
        detail: flowPersist,
      };
    }

    return {
      ok: false,
      reason: "no_entry_trigger",
      detail: { p, hi, lo, inLowBand, p5, lastWickPct, flowPersists: flowPersist },
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
      };
    }

    if (p < contLo) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_break_below_${contTf}_low`,
        entryLine: `break below ${contTf} low (${fmtPrice(contLo)}) → continuation`,
      };
    }

    const reversalOk = inHighBand && Number.isFinite(p5) && p5 <= -CFG.swingReversalMin5mMovePct;
    if (reversalOk) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_b1_reversal_short`,
        entryLine: `reject in B1 high band (${highBandTxt}) + 5m turned down (≤ -${fmtPct(CFG.swingReversalMin5mMovePct)})`,
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
      };
    }

    const flowPersist = flowPersistsAcrossTfs(item, "short");
    if (flowPersist.ok) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_flow_persists_short`,
        entryLine: `flow persists across TFs (${flowPersist.matchedTfs.join("/")}) + OI aligned`,
        detail: flowPersist,
      };
    }

    return {
      ok: false,
      reason: "no_entry_trigger",
      detail: { p, hi, lo, inHighBand, p5, lastWickPct, flowPersists: flowPersist },
    };
  }

  return { ok: false, reason: "neutral_bias" };
}


function modeTpTfOrder(mode) {
  mode = String(mode || "").toLowerCase();
  if (mode === "scalp") return ["15m", "1h", "4h"];
  if (mode === "swing") return ["1h", "4h"];
  if (mode === "build") return ["4h"];
  return ["1h"];
}

function tpCandidatesForBias(bias, lvl) {
  if (!lvl || lvl.warmup) return [];
  const mid = lvl.mid != null ? Number(lvl.mid) : null;
  const hi  = lvl.hi  != null ? Number(lvl.hi)  : null;
  const lo  = lvl.lo  != null ? Number(lvl.lo)  : null;

  if (bias === "long") return [mid, hi].filter((x) => x != null);
  if (bias === "short") return [mid, lo].filter((x) => x != null);
  return [];
}

// chooses the FIRST TF that gives you “enough room”; if none do, picks farthest TF available
function chooseDynamicTp({ mode, bias, price, levels, minTpPct = 0 }) {
  const order = modeTpTfOrder(mode);
  const pctMove = (a, b) => (Math.abs(b - a) / a) * 100;

  const isValidDir = (entry, tp) => {
    if (bias === "long") return tp > entry;
    if (bias === "short") return tp < entry;
    return false;
  };

  // First pass: find a TP with enough room
  for (const tf of order) {
    const lvl = levels?.[tf];
    for (const tp of tpCandidatesForBias(bias, lvl)) {
      if (!isValidDir(price, tp)) continue;          // ✅ direction guard
      const tpPct = pctMove(price, tp);
      if (tpPct >= minTpPct) return { tf, tp, tpPct, forced: false };
    }
  }

  // Fallback: farthest available (but still correct direction)
  for (let i = order.length - 1; i >= 0; i--) {
    const tf = order[i];
    const lvl = levels?.[tf];
    const tps = tpCandidatesForBias(bias, lvl).filter((tp) => isValidDir(price, tp)); // ✅
    if (tps.length) {
      // pick FARTHER one, not tps[0]
      let best = null;
      for (const tp of tps) {
        const tpPct = pctMove(price, tp);
        if (!best || tpPct > best.tpPct) best = { tf, tp, tpPct, forced: true };
      }
      return best;
    }
  }

  return null;
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
    const cooldownMs = CFG.cooldownMinutes * 60000;

    const triggered = [];
    const skipped = [];

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

    for (const item of j.results || []) {
      if (!item?.ok) {
        if (debug)
          skipped.push({
            symbol: item?.symbol || "?",
            reason: "item_not_ok",
            detail: item?.error || null,
          });
        continue;
      }

      const instId = String(item.instId || "");
      const symbol = String(item.symbol || "?");

      // cooldown is per-instId (shared across modes) so you don't spam
      const lastSentRaw = await redis.get(CFG.keys.lastSentAt(instId));
      const lastSent = lastSentRaw == null ? null : Number(lastSentRaw);

      if (!force && Number.isFinite(lastSent) && lastSent != null && now - lastSent < cooldownMs) {
        if (debug) skipped.push({ symbol, reason: "cooldown" });
        continue;
      }

      const levels = await computeLevelsFromSeries(instId);

      if (!force && levels?.["1h"]?.warmup) {
        if (debug) skipped.push({ symbol, reason: "warmup_gate_1h" });
        continue;
      }

      // Evaluate modes in priority order; first mode that passes wins.
      let winner = null;

      for (const mode of modes) {
        const lastStateModeRaw = await redis.get(CFG.keys.lastState(mode, instId));
        const lastState = lastStateModeRaw ? String(lastStateModeRaw) : null;

        const { triggers, curState } = evaluateCriteria(item, lastState, mode);

        // ✅ MEMORY ISOLATED — ALWAYS WRITE IMMEDIATELY
        await writeLastState(mode, instId, curState, { dry });

        const requiresTrigger = mode === "scalp";

if (!force && requiresTrigger && !triggers.length) {
  if (debug) skipped.push({ symbol, mode, reason: "no_triggers" });
  continue;
}

        const bias = biasFromItem(item, mode);
        
        const { minRangePct } = getModeCfg(mode);
const rPct = rangePct1h({ levels, price: item.price });

if (!force && Number.isFinite(minRangePct) && minRangePct > 0) {
  if (!Number.isFinite(rPct) || rPct < minRangePct) {
    if (debug)
      skipped.push({
        symbol,
        mode,
        reason: "range_floor",
        detail: { rangePct1h: rPct, minRangePct },
      });
    continue;
  }
}
        
        const macroMode = computeBtcMacro(j.results || [], mode);
        
        // Macro block
        if (
          !force &&
          CFG.macro.enabled &&
          CFG.macro.blockShortsOnAltsWhenBtcBull &&
          macroMode?.ok &&
          macroMode?.btcBullExpansion &&
          symbol.toUpperCase() !== CFG.macro.btcSymbol &&
          bias === "short"
        ) {
          if (debug)
            skipped.push({
              symbol,
              mode,
              reason: "macro_block_btc_bull_expansion",
              btc: macroMode?.btc || null,
              tf: macroMode?.tf || null,
            });
          continue;
        }

        const waterfallMode = computeBtcWaterfall(j.results || [], mode);

if (
  !force &&
  waterfallMode?.ok &&
  waterfallMode?.btcWaterfall &&
  bias === "long"
) {
  if (debug) {
    skipped.push({
      symbol,
      mode,
      reason: "btc_waterfall_override",
      btc: waterfallMode?.btc || null,
      tf: waterfallMode?.tf || null,
    });
  }
  continue;
}

        const b1 = strongRecoB1({ bias, levels, price: item.price });

        let entryLine = null;
        let execReason = null;
        let execWickMeta = null;

        if (!force) {
          if (mode === "scalp") {
            if (!b1.strong) {
              if (debug) skipped.push({ symbol, mode, reason: `weak_reco:${b1.reason}` });
              continue;
            }

            const g = await scalpExecutionGate({ instId, item, bias, levels });
            if (!g.ok) {
              if (debug)
                skipped.push({
                  symbol,
                  mode,
                  reason: `scalp_exec:${g.reason}`,
                  bias,
                  oi15: item?.deltas?.["15m"]?.oi_change_pct ?? null,
                });
              continue;
            }

            entryLine = g.entryLine || null;
            execReason = g.reason || null;
            execWickMeta = g.wickMeta || null;
          } else {
            // --- Build Regime Gate (soft) ---
if (mode === "build") {
  const br = item?.build_regime;
  if (br?.regime === "avoid") {
    if (debug) skipped.push({ symbol, mode, reason: "build_regime_avoid", detail: br });
    continue;
  }
}
            const modeLabel = mode === "build" ? "BUILD" : "SWING";
            const g = await swingExecutionGate({ instId, bias, levels, item, modeLabel });

            if (!g.ok) {
              if (debug)
                skipped.push({
                  symbol,
                  mode,
                  reason: `${mode}_exec:${g.reason}`,
                  bias,
                  detail: g.detail || null,
                });
              continue;
            }

            entryLine = g.entryLine || null;
            execReason = g.reason || null;
          }
        }

        winner = {
          mode,
          instId,
          _rawItem: item,
          symbol,
          price: item.price,
          bias,
          triggers,
          levels,
          b1,
          entryLine,
          execReason,
          curState,

          // Confidence context (mechanical inputs)
          ctx: {
            oi15: asNum(item?.deltas?.["15m"]?.oi_change_pct),
            lean15m: String(item?.deltas?.["15m"]?.lean || "").toLowerCase(),
            lean1h: String(item?.deltas?.["1h"]?.lean || "").toLowerCase(),
            wickMeta: execWickMeta || null,
          },
        };

        break;
      }

      if (!winner) continue;

      triggered.push(winner);
    }

// ---- Render DM ----

const lines = [];
const analyticsEvents = [];

lines.push(`⚡️TRADE ENTRY`);
lines.push("");
// Independent random baseline observation
if (CFG.randomBaselineEnabled && Array.isArray(j.results) && j.results.length > 0) {
  const roll = Math.floor(Math.random() * 100) + 1;

  if (roll <= CFG.randomBaselinePct) {
    const eligible = j.results.filter((x) => x?.ok && x?.price);

    if (eligible.length > 0) {
      const pick = eligible[Math.floor(Math.random() * eligible.length)];

      const side = Math.random() < 0.5 ? "long" : "short";
      const modePick = modes[Math.floor(Math.random() * modes.length)];

      const horizonMin = horizonMinForMode(modePick);
      analyticsEvents.push({
        alert_id: `${now}_random_${pick.symbol}_${side}`,
        source: "gateway",
        ts: now,
        due_ts: now + horizonMin * 60 * 1000,
        symbol: pick.symbol,
        instId: pick.instId,
        mode: modePick,
        side,
        entry_price: asNum(pick.price),
        confidence: null,
        driver_tf,
        horizon_min: horizonMin,
        observation_type: "random",
        rejection_reason: "",
        random_group_id: `${now}_random`,
        random_source: "independent_random"
      });
    }
  }
}

for (const t of triggered) {
  const mode = String(t.mode || "swing").toLowerCase();
  const modeUp = mode.toUpperCase();

  // ENTRY ZONE stays 1h B1 band (per your current spec)
  const levels = t.levels;
  const l1h = t.levels?.["1h"];
  const hi1h = l1h && !l1h.warmup ? asNum(l1h.hi) : null;
  const lo1h = l1h && !l1h.warmup ? asNum(l1h.lo) : null;
  const mid1h = hi1h != null && lo1h != null ? (hi1h + lo1h) / 2 : null;

  const price = asNum(t.price);
  const bias = String(t.bias || "neutral").toLowerCase();
  const biasUp = bias.toUpperCase();
  const confidence = computeConfidence(t);

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
});

const minLev = Number(process.env.ALERT_MIN_LEVERAGE || 0);

if (!force) {
  const effectiveLev = Number(lev?.suggestedHigh || 0);

  if (effectiveLev < minLev) {
    if (debug) {
      skipped.push({
        symbol: t.symbol,
        mode,
        reason: "leverage_floor",
        detail: {
          suggestedLow: lev?.suggestedLow ?? null,
          suggestedHigh: lev?.suggestedHigh ?? null,
          minLev,
        },
      });
    }
    continue;
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
});

if (!tpPick) {
  if (debug) skipped.push({ symbol: t.symbol, mode, reason: "no_dynamic_tp" });
  continue;
}

const tp = tpPick.tp;
const tpTf = tpPick.tf;
const tpPct = tpPick.tpPct;

const rrInfo = computeRiskReward({
  entryPrice: price,
  stopLossPx,
  tp,
});

if (!rrInfo || rrInfo.rr < CFG.minRR) {
  if (debug) {
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
  }
  continue;
}
lines.push(`[${modeUp}] ${t.symbol} ${price.toFixed(4)} | ${biasUp}`);
lines.push(`Confidence = ${confidence}`);
lines.push("");

const horizonMin = horizonMinForMode(mode);
analyticsEvents.push({
  alert_id: `${now}_${t.symbol}_${mode}_${bias}`,
  source: "gateway",
  ts: now,
  due_ts: now + horizonMin * 60 * 1000,
  symbol: t.symbol,
  instId: t.instId,
  mode,
  side: bias,
  entry_price: price,
  confidence,
  driver_tf,
  horizon_min: horizonMin,
  tp_tf: tpTf,
  tp_price: tp,
  stop_loss: stopLossPx,
  invalidation_price: invalidationPx,
  rr: rrInfo?.rr ?? null,
  observation_type: "fired",
  rejection_reason: ""
});

// Entry Zone (1h B1 band)
if (hi1h != null && lo1h != null) {
  const range1h = hi1h - lo1h;
  const edge1h = CFG.strongEdgePct1h * range1h;

  if (bias === "long") lines.push(`Entry Zone: ${lo1h.toFixed(4)}-${(lo1h + edge1h).toFixed(4)}`);
  else if (bias === "short") lines.push(`Entry Zone: ${(hi1h - edge1h).toFixed(4)}-${hi1h.toFixed(4)}`);
}

// Invalidation (mode-aware TF)
if (invalidationPx != null) lines.push(`Invalidation (${invTf}): ${fmtPrice(invalidationPx)}`);
else lines.push("Invalidation:");

// Avoid chasing (unchanged)
if (price != null) {
  const chaseBuffer = price * 0.0025;
  if (bias === "long") lines.push(`Avoid chasing above: ${fmtPrice(price + chaseBuffer)}`);
  else if (bias === "short") lines.push(`Avoid chasing below: ${fmtPrice(price - chaseBuffer)}`);
}

// Leverage (from stop distance)
if (lev) {
  lines.push(`Leverage: ${lev.suggestedLow}–${lev.suggestedHigh}x (max ${lev.adjustedMax}x)`);
}

lines.push("");

// Stop Loss (separate from invalidation now)
if (stopLossPx != null) lines.push(`Stop Loss: ${fmtPrice(stopLossPx)}`);
else lines.push("Stop Loss:");

// MESSAGE
lines.push(`Take Profit (${tpTf}${tpPick.forced ? ", forced" : ""}):`);
lines.push(`• ${tp.toFixed(4)} (≈ ${tpPct.toFixed(2)}%)`);
  
  lines.push("");
}

const message = lines.join("\n");
const renderedTradeCount = analyticsEvents.filter(
  (e) => e.observation_type === "fired"
).length;

const firedInstIds = [
  ...new Set(
    analyticsEvents
      .filter((e) => e.observation_type === "fired" && e.instId)
      .map((e) => String(e.instId))
  )
];

const { itemErrors, topSkips } = summarizeSkips(skipped);

if (!force && renderedTradeCount === 0) {
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
      triggered_count: 0,
      itemErrors,
      topSkips,
    },
    { dry }
  );

  const heartbeat_last_run = debug ? await readHeartbeat() : undefined;

  return res.json({
    ok: true,
    sent: false,
    ...(debug
      ? {
          deploy: getDeployInfo(),
          multiUrl,
          macro: macroByMode,
          skipped,
          triggered,
          modes,
          debug_build_regimes,
          risk_profile,
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
      itemErrors,
      topSkips,
      telegram_error: tg.detail || null,
    },
    { dry }
  );
  return res.status(500).json({ ok: false, error: "telegram_failed", detail: tg.detail || null });
}

if (firedInstIds.length > 0) {
  await Promise.all(
    firedInstIds.map((id) =>
      redis.set(CFG.keys.lastSentAt(id), String(now)).catch(() => null)
    )
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
        itemErrors,
        topSkips,
      },
      { dry }
    );

    const heartbeat_last_run = debug ? await readHeartbeat() : undefined;

    return res.json({
      ok: true,
      sent: !dry,
      triggered_count: renderedTradeCount,
      ...(debug
        ? {
            deploy: getDeployInfo(),
            multiUrl,
            macro: macroByMode,
            skipped,
            triggered,
            modes,
            debug_build_regimes,
            risk_profile,
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
