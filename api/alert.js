// /api/alert.js
// Crypto Market Gateway — Requirements (v1.3) aligned
//
// SYSTEM GOAL
// Send low-noise Telegram DMs only when a trade is executable within ~15 minutes.
// If it is not actionable now → no DM.
//
// KEY BEHAVIOR (v1.3)
// - /api/alert is the ONLY sender
// - Non-force sends ONLY if:
//   - criteria hit
//   - warmup passed (1h levels ready)
//   - macro gate passed
//   - B1 edge satisfied (reco=strong)
//   - execution trigger active (mode rules)
//   - OI rules satisfied (scalp strict)
//   - not in cooldown
// - dry=1: no Telegram, no writes
// - Drilldown link includes only alerted symbols + BTCUSDT
//
// NOTE ON “15m close”
// We approximate “current 15m close” using the current snapshot price (item.price),
// and we implement sweep logic using the stored 5m series (recent points).
// If you later add true 15m candle close/high/low from OKX, you can swap in real values.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

  // Defaults (v1.3)
  defaultMode: String(process.env.DEFAULT_MODE || "scalp").toLowerCase(),
  defaultRisk: String(process.env.DEFAULT_RISK_PROFILE || "normal").toLowerCase(),

  // Criteria thresholds (v1.3)
  momentumAbs5mPricePct: 0.1,
  shockOi15mPct: 0.5,
  shockAbs15mPricePct: 0.2,

  // Levels windows (from stored 5m series)
  levelWindows: {
    "1h": 12,
    "4h": 48,
  },

  // B1 edge (v1.3)
  strongEdgePct1h: Number(process.env.ALERT_STRONG_EDGE_PCT_1H || 0.15),

  telegramMaxChars: 3900,

  // Macro gate (v1.3)
  macro: {
    enabled: String(process.env.ALERT_MACRO_GATE_ENABLED || "1") === "1",
    btcSymbol: String(process.env.ALERT_MACRO_BTC_SYMBOL || "BTCUSDT").toUpperCase(),
    btc4hPricePctMin: Number(process.env.ALERT_MACRO_BTC_4H_PRICE_PCT_MIN || 2.0),
    btc4hOiPctMin: Number(process.env.ALERT_MACRO_BTC_4H_OI_PCT_MIN || 0.5),
    blockShortsOnAltsWhenBtcBull: String(process.env.ALERT_MACRO_BLOCK_SHORTS_ON_ALTS || "1") === "1",
  },

  // Optional regime adjust (kept; does not bypass B1/execution rules)
  regime: {
    enabled: String(process.env.ALERT_REGIME_ENABLED || "1") === "1",

    expansionPricePctMin: Number(process.env.ALERT_REGIME_EXPANSION_4H_PRICE_PCT_MIN || 3.0),
    expansionOiPctMin: Number(process.env.ALERT_REGIME_EXPANSION_4H_OI_PCT_MIN || 1.0),

    contractionAbsPricePctMax: Number(process.env.ALERT_REGIME_CONTRACTION_4H_ABS_PRICE_PCT_MAX || 1.0),
    contractionOiPctMax: Number(process.env.ALERT_REGIME_CONTRACTION_4H_OI_PCT_MAX || -1.0),

    contractionUpgradeEnabled: String(process.env.ALERT_REGIME_CONTRACTION_UPGRADE_ENABLED || "1") === "1",
    contractionUpgradeEdgeMult: Number(process.env.ALERT_REGIME_CONTRACTION_UPGRADE_EDGE_MULT || 1.5),
  },

  // Scalp sweep detection uses recent 5m points
  scalp: {
    sweepLookbackPoints: Number(process.env.ALERT_SCALP_SWEEP_LOOKBACK_POINTS || 3), // last N points
  },

  keys: {
    last15mState: (id) => `alert:lastState15m:${id}`,
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

function normalizeMode(raw) {
  const m = String(raw || "").toLowerCase();
  return ["scalp", "swing", "build"].includes(m) ? m : null;
}

function normalizeRisk(raw) {
  const r = String(raw || "").toLowerCase();
  return ["conservative", "normal", "aggressive"].includes(r) ? r : null;
}

const asNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const abs = (x) => (x == null ? null : Math.abs(Number(x)));

// v1.3 rounding rules
const fmtPrice = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(4);
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

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return { ok: false, detail: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };

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

// v1.3 bias logic
function biasFromItem(item, mode) {
  const m = String(mode || "scalp").toLowerCase();

  if (m === "swing" || m === "build") {
    const lean4h = item?.deltas?.["4h"]?.lean || item?.deltas?.["15m"]?.lean || item?.lean || "neutral";
    return String(lean4h).toLowerCase();
  }

  const lean15m = item?.deltas?.["15m"]?.lean || item?.lean || "neutral";
  return String(lean15m).toLowerCase();
}

// B1 edge check (v1.3)
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
    return { strong: ok, reason: ok ? "long_near_low" : "long_not_near_low" };
  }
  if (bias === "short") {
    const ok = p >= hi - edge;
    return { strong: ok, reason: ok ? "short_near_high" : "short_not_near_high" };
  }
  return { strong: false, reason: "neutral_bias" };
}

function strongRecoB1({ bias, levels, price }) {
  return edgeRecoCheck({ bias, levels, price, edgePct: CFG.strongEdgePct1h });
}

// Criteria layer (v1.3)
function evaluateCriteria(item, lastState) {
  const d5 = item?.deltas?.["5m"];
  const d15 = item?.deltas?.["15m"];
  const triggers = [];
  const curState = String(d15?.state || "unknown");

  if (lastState && curState !== lastState) triggers.push({ code: "setup_flip" });

  if (d5?.lean === d15?.lean && (abs(d5?.price_change_pct) ?? 0) >= CFG.momentumAbs5mPricePct)
    triggers.push({ code: "momentum_confirm" });

  if (
    (d15?.oi_change_pct ?? -Infinity) >= CFG.shockOi15mPct &&
    (abs(d15?.price_change_pct) ?? 0) >= CFG.shockAbs15mPricePct
  )
    triggers.push({ code: "positioning_shock" });

  return { triggers, curState };
}

// Macro gate (v1.3)
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

// Optional regime adjust (does not override B1/execution)
function computeSymbolRegime(item) {
  if (!CFG.regime.enabled) return { ok: false, type: "off" };

  const d4 = item?.deltas?.["4h"];
  const lean4h = String(d4?.lean || "").toLowerCase();
  const p4 = asNum(d4?.price_change_pct);
  const oi4 = asNum(d4?.oi_change_pct);

  if (!Number.isFinite(p4) || !Number.isFinite(oi4))
    return { ok: false, type: "unknown", lean4h: lean4h || null, p4, oi4 };

  const bullExpansion =
    lean4h === "long" && p4 >= CFG.regime.expansionPricePctMin && oi4 >= CFG.regime.expansionOiPctMin;

  const bearExpansion =
    lean4h === "short" && p4 <= -CFG.regime.expansionPricePctMin && oi4 >= CFG.regime.expansionOiPctMin;

  const contraction =
    Math.abs(p4) <= CFG.regime.contractionAbsPricePctMax && oi4 <= CFG.regime.contractionOiPctMax;

  if (bullExpansion) return { ok: true, type: "bull_expansion", lean4h, p4, oi4 };
  if (bearExpansion) return { ok: true, type: "bear_expansion", lean4h, p4, oi4 };
  if (contraction) return { ok: true, type: "contraction", lean4h, p4, oi4 };

  return { ok: true, type: "neutral", lean4h, p4, oi4 };
}

function adjustRecoForRegime({ item, bias, levels, price, baseReco }) {
  if (!CFG.regime.enabled) return { ...baseReco, adj: { type: "none" } };

  const reg = computeSymbolRegime(item);

  if (reg?.ok && baseReco?.strong) {
    if (reg.type === "bull_expansion" && bias === "short") {
      return { strong: false, reason: "regime_downgrade_bull_expansion_fade", adj: { type: reg.type, ...reg } };
    }
    if (reg.type === "bear_expansion" && bias === "long") {
      return { strong: false, reason: "regime_downgrade_bear_expansion_fade", adj: { type: reg.type, ...reg } };
    }
  }

  if (reg?.ok && reg.type === "contraction" && CFG.regime.contractionUpgradeEnabled && !baseReco?.strong) {
    const widened = CFG.strongEdgePct1h * Math.max(1, CFG.regime.contractionUpgradeEdgeMult);
    const up = edgeRecoCheck({ bias, levels, price, edgePct: widened });

    if (up.strong) {
      return { strong: true, reason: "regime_upgrade_contraction", adj: { type: reg.type, widenedEdgePct: widened, ...reg } };
    }
  }

  return { ...baseReco, adj: { type: reg?.type || "unknown", ...reg } };
}

/**
 * STRICT EXECUTION (v1.3) — SCALP
 * Non-force scalp sends ONLY if ALL are true:
 * - criteria hit (handled outside)
 * - B1 edge satisfied (handled outside; reco.strong must be true)
 * - price trigger active (15m close proxy + sweep pattern)
 * - strict OI confirmation: 15m oi_change_pct >= 0.50%
 *
 * Price trigger definitions (v1.3):
 * Long:
 *  - close > 1h high
 *  OR
 *  - sweep < 1h low AND close back above 1h low
 *
 * Short:
 *  - close < 1h low
 *  OR
 *  - sweep > 1h high AND close back below 1h high
 */
async function scalpExecutionGate({ instId, item, bias, levels }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "1h_warmup" };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const close15m = asNum(item?.price); // proxy for current 15m close
  if (hi == null || lo == null || close15m == null) return { ok: false, reason: "missing_levels_or_price" };

  const oi15 = asNum(item?.deltas?.["15m"]?.oi_change_pct);
  if (!Number.isFinite(oi15) || oi15 < CFG.shockOi15mPct) return { ok: false, reason: "oi15_not_confirming" };

  // Recent series points to approximate sweep
  const recent = await getRecentPricesFromSeries(instId, CFG.scalp.sweepLookbackPoints);
  const minRecent = recent.length ? Math.min(...recent) : null;
  const maxRecent = recent.length ? Math.max(...recent) : null;

  if (bias === "long") {
    const breakout = close15m > hi;
    const sweptDown = minRecent != null && minRecent < lo;
    const sweepReclaim = sweptDown && close15m > lo;

    if (breakout) {
      return {
        ok: true,
        reason: "long_breakout",
        triggerLine: `trigger: current 15m close > ${fmtPrice(hi)} (1h high) AND 15m OI >= ${CFG.shockOi15mPct.toFixed(2)}%`,
      };
    }
    if (sweepReclaim) {
      return {
        ok: true,
        reason: "long_sweep_reclaim",
        triggerLine: `trigger: sweep < ${fmtPrice(lo)} (1h low) AND current 15m close back > ${fmtPrice(lo)} AND 15m OI >= ${CFG.shockOi15mPct.toFixed(2)}%`,
      };
    }
    return {
      ok: false,
      reason: "price_trigger_not_active",
      detail: { close15m, hi, lo, minRecent },
    };
  }

  if (bias === "short") {
    const breakdown = close15m < lo;
    const sweptUp = maxRecent != null && maxRecent > hi;
    const sweepReject = sweptUp && close15m < hi;

    if (breakdown) {
      return {
        ok: true,
        reason: "short_breakdown",
        triggerLine: `trigger: current 15m close < ${fmtPrice(lo)} (1h low) AND 15m OI >= ${CFG.shockOi15mPct.toFixed(2)}%`,
      };
    }
    if (sweepReject) {
      return {
        ok: true,
        reason: "short_sweep_reject",
        triggerLine: `trigger: sweep > ${fmtPrice(hi)} (1h high) AND current 15m close back < ${fmtPrice(hi)} AND 15m OI >= ${CFG.shockOi15mPct.toFixed(2)}%`,
      };
    }
    return {
      ok: false,
      reason: "price_trigger_not_active",
      detail: { close15m, hi, lo, maxRecent },
    };
  }

  return { ok: false, reason: "neutral_bias" };
}

/**
 * SWING MODE EXECUTION (v1.3)
 * Requires:
 * - criteria hit
 * - B1 edge satisfied OR structural break
 * - price trigger active (15m close proxy beyond level)
 * - OI used as context only (no strict 0.50% spike required)
 *
 * Here: “structural break” approximated as current price beyond 1h hi/lo in direction of bias.
 */
function swingExecutionGate({ bias, levels, item }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "1h_warmup" };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const p = asNum(item?.price);
  if (hi == null || lo == null || p == null) return { ok: false, reason: "missing_levels_or_price" };

  if (bias === "long") {
    const ok = p > hi;
    return {
      ok,
      reason: ok ? "swing_break_above_1h_high" : "swing_not_beyond_1h_high",
      triggerLine: `trigger: current 15m close > ${fmtPrice(hi)} (1h high)`,
    };
  }
  if (bias === "short") {
    const ok = p < lo;
    return {
      ok,
      reason: ok ? "swing_break_below_1h_low" : "swing_not_beyond_1h_low",
      triggerLine: `trigger: current 15m close < ${fmtPrice(lo)} (1h low)`,
    };
  }
  return { ok: false, reason: "neutral_bias" };
}

export default async function handler(req, res) {
  try {
    const secret = process.env.ALERT_SECRET || "";

    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

    const key = String(req.query.key || "");
    const provided = bearer || key;

    if (!secret || provided !== secret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const debug = String(req.query.debug || "") === "1";
    const force = String(req.query.force || "") === "1";
    const dry = String(req.query.dry || "") === "1";
    const driver_tf = normalizeDriverTf(req.query.driver_tf);

    const mode = normalizeMode(req.query.mode) || CFG.defaultMode;
    const risk_profile = normalizeRisk(req.query.risk_profile) || CFG.defaultRisk;

    const querySyms = normalizeSymbols(req.query.symbols);
    const envSyms = normalizeSymbols(process.env.DEFAULT_SYMBOLS);
    const symbols = querySyms.length ? querySyms : envSyms.length ? envSyms : ["BTCUSDT"];

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();

    const multiUrl = `${proto}://${host}/api/multi?symbols=${encodeURIComponent(
      symbols.join(",")
    )}&driver_tf=${encodeURIComponent(driver_tf)}`;

    const r = await fetch(multiUrl, { headers: { "Cache-Control": "no-store" } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) {
      return res.status(500).json({ ok: false, error: "multi fetch failed", multiUrl, detail: j || null });
    }

    const macro = computeBtcMacro(j.results || []);

    const now = Date.now();
    const cooldownMs = CFG.cooldownMinutes * 60000;

    const triggered = [];
    const skipped = [];

    for (const item of j.results || []) {
      if (!item?.ok) {
        if (debug) skipped.push({ symbol: item?.symbol || "?", reason: "item_not_ok", detail: item?.error || null });
        continue;
      }

      const instId = String(item.instId || "");
      const symbol = String(item.symbol || "?");

      const [lastStateRaw, lastSentRaw] = await Promise.all([
        redis.get(CFG.keys.last15mState(instId)),
        redis.get(CFG.keys.lastSentAt(instId)),
      ]);

      const lastState = lastStateRaw ? String(lastStateRaw) : null;
      const lastSent = lastSentRaw == null ? null : Number(lastSentRaw);

      const { triggers, curState } = evaluateCriteria(item, lastState);

      // Detection layer must hit (unless force)
      if (!force && !triggers.length) {
        if (debug) skipped.push({ symbol, reason: "no_triggers" });
        continue;
      }

      // Cooldown (unless force)
      if (!force && Number.isFinite(lastSent) && lastSent != null && now - lastSent < cooldownMs) {
        if (debug) skipped.push({ symbol, reason: "cooldown" });
        continue;
      }

      const bias = biasFromItem(item, mode);

      // Macro gate: block SHORT bias alts during BTC bull expansion (unless force)
      if (
        !force &&
        CFG.macro.enabled &&
        CFG.macro.blockShortsOnAltsWhenBtcBull &&
        macro?.ok &&
        macro?.btcBullExpansion4h &&
        symbol.toUpperCase() !== CFG.macro.btcSymbol &&
        bias === "short"
      ) {
        if (debug) skipped.push({ symbol, reason: "macro_block_btc_bull_expansion", btc4h: macro?.btc || null });
        if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
        continue;
      }

      const levels = await computeLevelsFromSeries(instId);

      // Warmup gate (unless force)
      if (!force && levels?.["1h"]?.warmup) {
        if (debug) skipped.push({ symbol, reason: "warmup_gate_1h" });
        if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
        continue;
      }

      // B1 edge (reco strong) — required for automatic mode (unless force)
      const baseReco = strongRecoB1({ bias, levels, price: item.price });
      const reco = adjustRecoForRegime({ item, bias, levels, price: item.price, baseReco });

      let triggerLine = null;
      let execReason = null;

      if (!force) {
        // v1.3: B1 must be satisfied for reco=strong (used by all automatic modes)
        if (!reco.strong) {
          if (debug) skipped.push({ symbol, reason: `weak_reco:${reco.reason}` });
          if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
          continue;
        }

        // Mode execution gates
        if (String(mode) === "scalp") {
          const g = await scalpExecutionGate({ instId, item, bias, levels });
          if (!g.ok) {
            if (debug) {
              skipped.push({
                symbol,
                reason: `scalp_exec:${g.reason}`,
                bias,
                oi15: item?.deltas?.["15m"]?.oi_change_pct ?? null,
                detail: g.detail || null,
              });
            }
            if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
            continue;
          }
          triggerLine = g.triggerLine || null;
          execReason = g.reason || null;
        } else if (String(mode) === "swing") {
          // v1.3: swing can use “B1 OR structural break”; since B1 already true here,
          // we still require an execution trigger (price beyond level) to be actionable now.
          const g = swingExecutionGate({ bias, levels, item });
          if (!g.ok) {
            if (debug) skipped.push({ symbol, reason: `swing_exec:${g.reason}`, bias });
            if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
            continue;
          }
          triggerLine = g.triggerLine || null;
          execReason = g.reason || null;
        } else if (String(mode) === "build") {
          // v1.3: build still must be actionable now; we keep it strict by requiring a trigger beyond a level
          // (same as swing trigger for “act now”).
          const g = swingExecutionGate({ bias, levels, item });
          if (!g.ok) {
            if (debug) skipped.push({ symbol, reason: `build_exec:${g.reason}`, bias });
            if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
            continue;
          }
          triggerLine = g.triggerLine || null;
          execReason = g.reason || null;
        }
      }

      triggered.push({
        symbol,
        price: item.price,
        bias,
        triggers,
        levels,
        reco,
        triggerLine,
        execReason,
      });

      if (!dry) {
        await redis.set(CFG.keys.lastSentAt(instId), String(now));
        if (curState) await redis.set(CFG.keys.last15mState(instId), curState);
      }
    }

    if (!force && !triggered.length) {
      return res.json({
        ok: true,
        sent: false,
        ...(debug ? { deploy: getDeployInfo(), multiUrl, macro, skipped, mode, risk_profile } : {}),
      });
    }

    const lines = [];
    lines.push(`⚡️ OKX perps alert (${driver_tf})${force ? " [FORCE]" : ""}${dry ? " [DRY]" : ""}`);
    lines.push(new Date().toISOString());
    lines.push("");

    for (const t of triggered) {
      const l1h = t.levels?.["1h"];
      const lvl = l1h && !l1h.warmup ? ` | 1h H/L=${fmtPrice(l1h.hi)}/${fmtPrice(l1h.lo)}` : "";
      const recoTxt = t.reco?.strong ? "strong" : "weak";
      lines.push(`${t.symbol} $${fmtPrice(t.price)} | bias=${t.bias} | reco=${recoTxt}${lvl}`);
      if (t.triggerLine) lines.push(t.triggerLine);
      lines.push("");
    }

    // Drilldown includes only alerted symbols + BTC (v1.3)
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
    const renderedMessage = message;

    if (!dry) {
      const tg = await sendTelegram(message);
      if (!tg.ok) return res.status(500).json({ ok: false, error: "telegram_failed", detail: tg.detail || null });
    }

    return res.json({
      ok: true,
      sent: !dry,
      triggered_count: triggered.length,
      ...(debug ? { deploy: getDeployInfo(), multiUrl, macro, skipped, triggered, mode, risk_profile, renderedMessage } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}