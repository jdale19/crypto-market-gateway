// /api/alert.js
// Crypto Market Gateway — mode-aware alerts (scalp strict, swing realistic)
//
// CHANGE (minimal rework):
// - MULTI MODE SELECTION: support mode=scalp,swing,build and DEFAULT_MODES env var
// - PRIORITY: faster mode always wins (SCALP > SWING > BUILD)
// - SCALP: unchanged logic (strict breakout/sweep + strict OI confirmation + B1 required)
// - SWING/BUILD: "B1 reversal" entry option (bounce/reject near 1h extremes)
// - DM COPY: explicit numeric zone ranges (ex: 1.594–1.597)
// - MESSAGE CONTRACT: include "Entry:" one-liner (trader style)
// - STATE SEEDING: always seed lastState; for swing/build mirror legacy lastState15m
// - LEVERAGE RECO: advisory only (compact line) + OI/funding adjustments
//
// Notes:
// - Behavior: same per-mode rules; we just evaluate multiple modes in order and choose first that triggers.
// - Default modes now use DEFAULT_MODES env var (comma list). DEFAULT_MODE is still honored as fallback.
// - Leverage reco is advisory text only; does not change gating.

import { Redis } from "@upstash/redis";

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

const CFG = {
  cooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 20),

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
    "1h": 12,
    "4h": 48,
  },

  // B1 edge (structural proximity)
  strongEdgePct1h: Number(process.env.ALERT_STRONG_EDGE_PCT_1H || 0.15),

  // Swing reversal micro-confirm (5m push away from extreme)
  swingReversalMin5mMovePct: Number(process.env.ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT || 0.05),

  telegramMaxChars: 3900,

  // Macro gate
  macro: {
    enabled: String(process.env.ALERT_MACRO_GATE_ENABLED || "1") === "1",
    btcSymbol: String(process.env.ALERT_MACRO_BTC_SYMBOL || "BTCUSDT").toUpperCase(),
    btc4hPricePctMin: Number(process.env.ALERT_MACRO_BTC_4H_PRICE_PCT_MIN || 2.0),
    btc4hOiPctMin: Number(process.env.ALERT_MACRO_BTC_4H_OI_PCT_MIN || 0.5),
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

  // Swing/build OI context rule
  swing: {
    minOiPct: Number(process.env.ALERT_SWING_MIN_OI_PCT || -0.5),
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

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId)
    return { ok: false, detail: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };

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

    const slice = pts
      .slice(-n)
      .map((p) => asNum(p?.p))
      .filter((x) => x != null);

    if (!slice.length) {
      out[label] = { warmup: true };
      continue;
    }

    const hi = Math.max(...slice);
    const lo = Math.min(...slice);
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
function computeLeverageSuggestion({ bias, entryPrice, levels, item, mode }) {
  if (!CFG.leverage?.enabled) return null;

  const m = String(mode || "scalp").toLowerCase();
  const riskBudgetPct =
    CFG.leverage?.riskBudgetPctByMode?.[m] ??
    CFG.leverage?.riskBudgetPctByMode?.scalp ??
    Number(process.env.ALERT_RISK_BUDGET_PCT || 1.0);

  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return null;

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const price = asNum(entryPrice);
  if (hi == null || lo == null || price == null) return null;

  // NOTE: this is a STRUCTURE proxy only (advisory) — not your actual invalidation rule.
  // We use the opposite 1h extreme as a "worst case" structure stop distance.
  const invalidation = bias === "long" ? lo : hi;
  const distancePct = Math.abs((price - invalidation) / price) * 100;

  if (!Number.isFinite(distancePct) || distancePct <= 0) return null;

  const baseMax = Math.floor(
    Math.max(0, Number(riskBudgetPct) || 0) / Math.max(0.01, distancePct)
  );

  // OI adjustment (use abs, because instability is instability)
  const oi5 = Math.abs(asNum(item?.deltas?.["5m"]?.oi_change_pct) ?? 0);
  const oi15 = Math.abs(asNum(item?.deltas?.["15m"]?.oi_change_pct) ?? 0);

  let oiMult = 1;
  if (oi5 > CFG.leverage.oiReduce2 || oi15 > CFG.leverage.oiReduce2) oiMult = 0.6;
  else if (oi5 > CFG.leverage.oiReduce1 || oi15 > CFG.leverage.oiReduce1) oiMult = 0.75;

  // Funding adjustment (abs)
  const funding = Math.abs(asNum(item?.funding_rate) ?? 0);

  let fMult = 1;
  if (funding > CFG.leverage.fundingReduce2) fMult = 0.6;
  else if (funding > CFG.leverage.fundingReduce1) fMult = 0.8;

  const adjustedMax = Math.max(
    1,
    Math.min(Math.floor(baseMax * oiMult * fMult), CFG.leverage.maxCap)
  );
  const suggestedLow = Math.max(1, Math.floor(adjustedMax * 0.5));
  const suggestedHigh = adjustedMax;

  return {
    suggestedLow,
    suggestedHigh,
    adjustedMax,
    distancePct,
    oi5,
    oi15,
    funding,
    riskBudgetPct,
    mode: m,
    flags: {
      oiReduced: oiMult < 1,
      fundingReduced: fMult < 1,
    },
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
  const bias = String(t?.bias || "").toLowerCase(); // "long" | "short"
  const b1Strong = !!t?.b1?.strong;

  const execReason = String(t?.execReason || "").toLowerCase();

  // 5m reversal confirmed = reversal path (not break path)
  const reversalConfirmed = execReason.includes("b1_reversal");

  // breakout-only = break path
  const breakoutOnly =
    execReason.includes("break_above") ||
    execReason.includes("break_below") ||
    execReason.includes("breakout") ||
    execReason.includes("breakdown");

  // 15m OI aligned (mechanical proxy) = 15m lean matches bias
  const lean15m = String(t?.ctx?.lean15m || "").toLowerCase();
  const oiAligned = lean15m === bias;

  // OI neutral = 15m lean is neutral/unknown OR abs OI small vs shock threshold
  const oi15 = asNum(t?.ctx?.oi15);
  const oiNeutral =
    lean15m === "neutral" ||
    lean15m === "" ||
    (Number.isFinite(oi15) && Math.abs(oi15) < CFG.shockOi15mPct);

  // weak OI = not aligned and not neutral
  const oiWeak = !oiAligned && !oiNeutral;

  // 1h lean aligned = 1h lean matches bias
  const lean1h = String(t?.ctx?.lean1h || "").toLowerCase();
  const oneHourAligned = lean1h === bias;
  const counter1hLean = lean1h && lean1h !== "neutral" && !oneHourAligned;

  // A: B1 strong + reversalConfirmed + oiAligned + 1h aligned
  if (b1Strong && reversalConfirmed && oiAligned && oneHourAligned) return "A";

  // B: B1 strong + reversalConfirmed + oiNeutral
  if (b1Strong && reversalConfirmed && oiNeutral) return "B";

  // C: only breakout trigger OR weak OI OR counter 1h lean
  if (breakoutOnly || oiWeak || counter1hLean) return "C";

  // conservative fallback
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
function computeBtcMacro(results) {
  if (!CFG.macro.enabled) return { ok: false, reason: "macro_disabled", btcBullExpansion4h: false };

  const btcSym = CFG.macro.btcSymbol;
  const btcItem = (results || []).find((x) => String(x?.symbol || "").toUpperCase() === btcSym);

  if (!btcItem?.ok) return { ok: false, reason: "btc_missing", btcBullExpansion4h: false };

  const d4 = btcItem?.deltas?.["4h"];
  const pricePct = asNum(d4?.price_change_pct);
  const oiPct = asNum(d4?.oi_change_pct);
  const lean = String(d4?.lean || "").toLowerCase();

  const bull =
    lean === "long" &&
    Number.isFinite(pricePct) &&
    Number.isFinite(oiPct) &&
    pricePct >= CFG.macro.btc4hPricePctMin &&
    oiPct >= CFG.macro.btc4hOiPctMin;

  return {
    ok: true,
    reason: "ok",
    btcBullExpansion4h: bull,
    btc: {
      lean4h: lean || null,
      pricePct4h: Number.isFinite(pricePct) ? pricePct : null,
      oiPct4h: Number.isFinite(oiPct) ? oiPct : null,
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

  const recent = await getRecentPricesFromSeries(instId, CFG.scalp.sweepLookbackPoints);
  const minRecent = recent.length ? Math.min(...recent) : null;
  const maxRecent = recent.length ? Math.max(...recent) : null;

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
function swingExecutionGate({ bias, levels, item, modeLabel = "SWING" }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "1h_warmup" };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const p = asNum(item?.price);
  if (hi == null || lo == null || p == null) return { ok: false, reason: "missing_levels_or_price" };

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

  const range = hi - lo;
  if (!(range > 0)) return { ok: false, reason: "bad_range" };

  const edge = CFG.strongEdgePct1h * range;

  // Explicit band boundaries
  const lowBandLo = lo;
  const lowBandHi = lo + edge;

  const highBandLo = hi - edge;
  const highBandHi = hi;

  const inLowBand = p <= lowBandHi;
  const inHighBand = p >= highBandLo;

  const lowBandTxt = `${fmtPrice(lowBandLo)}–${fmtPrice(lowBandHi)}`;
  const highBandTxt = `${fmtPrice(highBandLo)}–${fmtPrice(highBandHi)}`;

  if (bias === "long") {
    if (p > hi) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_break_above_1h_high`,
        entryLine: `break above 1h high (${fmtPrice(hi)}) → continuation`,
      };
    }

    const reversalOk = inLowBand && Number.isFinite(p5) && p5 >= CFG.swingReversalMin5mMovePct;
    if (reversalOk) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_b1_reversal_long`,
        entryLine: `bounce in B1 low band (${lowBandTxt}) + 5m turned up (≥ ${fmtPct(
          CFG.swingReversalMin5mMovePct
        )})`,
      };
    }

    return { ok: false, reason: "no_entry_trigger", detail: { p, hi, lo, inLowBand, p5 } };
  }

  if (bias === "short") {
    if (p < lo) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_break_below_1h_low`,
        entryLine: `break below 1h low (${fmtPrice(lo)}) → continuation`,
      };
    }

    const reversalOk = inHighBand && Number.isFinite(p5) && p5 <= -CFG.swingReversalMin5mMovePct;
    if (reversalOk) {
      return {
        ok: true,
        reason: `${modeLabel.toLowerCase()}_b1_reversal_short`,
        entryLine: `reject in B1 high band (${highBandTxt}) + 5m turned down (≤ -${fmtPct(
          CFG.swingReversalMin5mMovePct
        )})`,
      };
    }

    return { ok: false, reason: "no_entry_trigger", detail: { p, hi, lo, inHighBand, p5 } };
  }

  return { ok: false, reason: "neutral_bias" };
}

export default async function handler(req, res) {
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

    const multiUrl = `${proto}://${host}/api/multi?symbols=${encodeURIComponent(
      symbols.join(",")
    )}&driver_tf=${encodeURIComponent(driver_tf)}&source=snapshot`;

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

    const macro = computeBtcMacro(j.results || []);

    const now = Date.now();
    const cooldownMs = CFG.cooldownMinutes * 60000;

    const triggered = [];
    const skipped = [];

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

        if (!force && !triggers.length) {
          if (debug) skipped.push({ symbol, mode, reason: "no_triggers" });
          continue;
        }

        const bias = biasFromItem(item, mode);

        // Macro block
        if (
          !force &&
          CFG.macro.enabled &&
          CFG.macro.blockShortsOnAltsWhenBtcBull &&
          macro?.ok &&
          macro?.btcBullExpansion4h &&
          symbol.toUpperCase() !== CFG.macro.btcSymbol &&
          bias === "short"
        ) {
          if (debug)
            skipped.push({
              symbol,
              mode,
              reason: "macro_block_btc_bull_expansion",
              btc4h: macro?.btc || null,
            });
          continue;
        }

        const b1 = strongRecoB1({ bias, levels, price: item.price });

        let entryLine = null;
        let execReason = null;

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
          } else {
            const modeLabel = mode === "build" ? "BUILD" : "SWING";
            const g = swingExecutionGate({ bias, levels, item, modeLabel });

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
          },
        };

        winner.leverage = computeLeverageSuggestion({
          bias: winner.bias,
          entryPrice: winner.price,
          levels: winner.levels,
          item,
          mode,
        });

        break;
      }

      if (!winner) continue;

      triggered.push(winner);

      if (!dry) {
        await redis.set(CFG.keys.lastSentAt(instId), String(now));
      }
    }

    const itemErrors = (skipped || []).filter((s) => String(s?.reason || "") === "item_not_ok").length;
    const topSkips = (skipped || []).slice(0, 12).map((s) => ({
      symbol: s.symbol,
      mode: s.mode,
      reason: s.reason,
    }));

    if (!force && !triggered.length) {
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
          ? { deploy: getDeployInfo(), multiUrl, macro, skipped, modes, risk_profile, heartbeat_last_run }
          : {}),
      });
    }

    // ---- Render DM ----
    const lines = [];
    lines.push("⚡️ PERP TRADE ENTRY");
    lines.push("");

    for (const t of triggered) {
      const l1h = t.levels?.["1h"];
      const hi = l1h && !l1h.warmup ? asNum(l1h.hi) : null;
      const lo = l1h && !l1h.warmup ? asNum(l1h.lo) : null;
      const mid = hi != null && lo != null ? (hi + lo) / 2 : null;

      const price = asNum(t.price);
      const biasUp = String(t.bias).toUpperCase();

      const confidence = computeConfidence(t);

      lines.push(`${t.symbol} $${fmtPrice(price)} | ${biasUp}`);
      lines.push(`Confidence: ${confidence}`);

      // Message contract: include Entry: one-liner (if available)
      if (t.entryLine) {
        lines.push(`Entry: ${biasUp} — ${t.entryLine}`);
      }
      lines.push("");

      // Entry Zone = B1 band based on 1h range + strongEdgePct1h
      if (hi != null && lo != null) {
        const range = hi - lo;
        const edge = CFG.strongEdgePct1h * range;

        if (String(t.bias).toLowerCase() === "long") {
          lines.push(`Entry Zone: ${fmtPrice(lo)}–${fmtPrice(lo + edge)}`);
        } else if (String(t.bias).toLowerCase() === "short") {
          lines.push(`Entry Zone: ${fmtPrice(hi - edge)}–${fmtPrice(hi)}`);
        }
      }

      // Avoid chasing = 0.25% buffer from current price (mechanical)
      if (price != null) {
        const chaseBuffer = price * 0.0025;
        if (String(t.bias).toLowerCase() === "long") {
          lines.push(`Avoid chasing above: ${fmtPrice(price + chaseBuffer)}`);
        } else {
          lines.push(`Avoid chasing below: ${fmtPrice(price - chaseBuffer)}`);
        }
      }

      if (t.leverage) {
        lines.push(
          `Leverage: ${t.leverage.suggestedLow}–${t.leverage.suggestedHigh}x (max ${t.leverage.adjustedMax}x)`
        );
      }

      lines.push("");

      // Stop Loss = opposite 1h extreme (structure proxy)
      if (hi != null && lo != null) {
        const stop = String(t.bias).toLowerCase() === "long" ? lo : hi;
        lines.push(`Stop Loss: ${fmtPrice(stop)}`);
      }

      if (hi != null && lo != null) {
        lines.push("Take Profit:");
        if (mid != null) lines.push(`• ${fmtPrice(mid)} (range mid)`);
        if (String(t.bias).toLowerCase() === "long") lines.push(`• ${fmtPrice(hi)} (1h high)`);
        else lines.push(`• ${fmtPrice(lo)} (1h low)`);
      }

      lines.push("");
    }

    const drillSyms = Array.from(
      new Set([
        ...triggered.map((x) => String(x.symbol || "").toUpperCase()).filter(Boolean),
        CFG.macro.btcSymbol,
      ])
    );

    const drillUrl = `${proto}://${host}/api/multi?symbols=${encodeURIComponent(
      drillSyms.join(",")
    )}&driver_tf=${encodeURIComponent(driver_tf)}`;

    lines.push(drillUrl);

    const message = lines.join("\n");

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
            triggered_count: triggered.length,
            itemErrors,
            topSkips,
            telegram_error: tg.detail || null,
          },
          { dry }
        );
        return res.status(500).json({ ok: false, error: "telegram_failed", detail: tg.detail || null });
      }
    }

    await writeHeartbeat(
      {
        ts: now,
        iso: new Date(now).toISOString(),
        ok: true,
        modes,
        risk_profile,
        sent: !dry,
        triggered_count: triggered.length,
        itemErrors,
        topSkips,
      },
      { dry }
    );

    const heartbeat_last_run = debug ? await readHeartbeat() : undefined;

    return res.json({
      ok: true,
      sent: !dry,
      triggered_count: triggered.length,
      ...(debug
        ? {
            deploy: getDeployInfo(),
            multiUrl,
            macro,
            skipped,
            triggered,
            modes,
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