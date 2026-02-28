// /api/alert.js
// Crypto Market Gateway — mode-aware alerts (scalp strict, swing realistic)
// CHANGE (minimal rework):
// - SCALP: unchanged (strict breakout/sweep + strict OI confirmation + B1 required)
// - SWING/BUILD: add "B1 reversal" entry option (bounce/reject near 1h extremes)
//   so you get real trader-style entries in range/chop days, not only breakout days.

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

  // Defaults
  defaultMode: String(process.env.DEFAULT_MODE || "scalp").toLowerCase(),
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

  // NEW (swing reversal micro-confirm):
  // If we are at a 1h extreme, require a small 5m push away from the extreme.
  // This avoids firing on "catching the knife".
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
    contractionOiPctMax: Number(process.env.ALERT_REGIME_CONTRACTION_4H_OI_PCT_MAX || -1.0),

    contractionUpgradeEnabled: String(process.env.ALERT_REGIME_CONTRACTION_UPGRADE_ENABLED || "1") === "1",
    contractionUpgradeEdgeMult: Number(process.env.ALERT_REGIME_CONTRACTION_UPGRADE_EDGE_MULT || 1.5),
  },

  scalp: {
    sweepLookbackPoints: Number(process.env.ALERT_SCALP_SWEEP_LOOKBACK_POINTS || 3),
  },

  // Swing/build OI context rule
  // "Must not be sharply negative against direction"
  swing: {
    minOiPct: Number(process.env.ALERT_SWING_MIN_OI_PCT || -0.5),
  },

  // Heartbeat (debug/run visibility)
  heartbeat: {
    key: String(process.env.ALERT_HEARTBEAT_KEY || "alert:lastRun"),
    ttlSeconds: Number(process.env.ALERT_HEARTBEAT_TTL_SECONDS || 60 * 60 * 24),
  },

  keys: {
    lastState: (mode, id) => `alert:lastState:${String(mode || "unknown")}:${id}`,
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
 * STRICT ENTRY (SCALP) — unchanged
 */
async function scalpExecutionGate({ instId, item, bias, levels }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "1h_warmup" };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const priceNow = asNum(item?.price);
  if (hi == null || lo == null || priceNow == null) return { ok: false, reason: "missing_levels_or_price" };

  const oi15 = asNum(item?.deltas?.["15m"]?.oi_change_pct);
  if (!Number.isFinite(oi15) || oi15 < CFG.shockOi15mPct) return { ok: false, reason: "oi15_not_confirming" };

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
        triggerLine: `Entry: breakout > 1h high (${fmtPrice(hi)}) + OI confirm (15m ≥ ${CFG.shockOi15mPct.toFixed(2)}%)`,
      };
    }
    if (sweepReclaim) {
      return {
        ok: true,
        reason: "long_sweep_reclaim",
        triggerLine: `Entry: sweep below 1h low (${fmtPrice(lo)}) then reclaim + OI confirm (15m ≥ ${CFG.shockOi15mPct.toFixed(
          2
        )}%)`,
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
        triggerLine: `Entry: breakdown < 1h low (${fmtPrice(lo)}) + OI confirm (15m ≥ ${CFG.shockOi15mPct.toFixed(2)}%)`,
      };
    }
    if (sweepReject) {
      return {
        ok: true,
        reason: "short_sweep_reject",
        triggerLine: `Entry: sweep above 1h high (${fmtPrice(hi)}) then reject + OI confirm (15m ≥ ${CFG.shockOi15mPct.toFixed(
          2
        )}%)`,
      };
    }
    return { ok: false, reason: "price_trigger_not_active" };
  }

  return { ok: false, reason: "neutral_bias" };
}

/**
 * SWING/BUILD ENTRY
 * Two ways to be actionable:
 *  A) BREAK: price beyond 1h high/low (existing behavior)
 *  B) REVERSAL: price at 1h extreme (B1 zone) + small 5m push away from the extreme (NEW)
 */
function swingExecutionGate({ bias, levels, item }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "1h_warmup" };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const p = asNum(item?.price);
  if (hi == null || lo == null || p == null) return { ok: false, reason: "missing_levels_or_price" };

  const oi15 = asNum(item?.deltas?.["15m"]?.oi_change_pct);
  if (Number.isFinite(oi15) && oi15 < CFG.swing.minOiPct) {
    return { ok: false, reason: "oi15_too_negative_for_swing", detail: { oi15, min: CFG.swing.minOiPct } };
  }

  const d5 = item?.deltas?.["5m"];
  const p5 = asNum(d5?.price_change_pct);

  // Build the B1 band using the same edge math
  const range = hi - lo;
  if (!(range > 0)) return { ok: false, reason: "bad_range" };
  const edge = CFG.strongEdgePct1h * range;

  const nearLow = p <= lo + edge;
  const nearHigh = p >= hi - edge;

  // A) Breakout/breakdown (existing)
  if (bias === "long") {
    if (p > hi) {
      return {
        ok: true,
        reason: "swing_break_above_1h_high",
        triggerLine: `Entry: break above 1h high (${fmtPrice(hi)})`,
      };
    }

    // B) Reversal (NEW)
    const reversalOk =
      nearLow &&
      Number.isFinite(p5) &&
      p5 >= CFG.swingReversalMin5mMovePct;

    if (reversalOk) {
      return {
        ok: true,
        reason: "swing_b1_reversal_long",
        triggerLine: `Entry: bounce at 1h low zone (≤ ${fmtPrice(lo + edge)}) + 5m turn up (≥ ${CFG.swingReversalMin5mMovePct.toFixed(
          2
        )}%)`,
      };
    }

    return { ok: false, reason: "swing_no_entry_trigger", detail: { p, hi, lo, nearLow, p5 } };
  }

  if (bias === "short") {
    if (p < lo) {
      return {
        ok: true,
        reason: "swing_break_below_1h_low",
        triggerLine: `Entry: break below 1h low (${fmtPrice(lo)})`,
      };
    }

    // B) Reversal (NEW)
    const reversalOk =
      nearHigh &&
      Number.isFinite(p5) &&
      p5 <= -CFG.swingReversalMin5mMovePct;

    if (reversalOk) {
      return {
        ok: true,
        reason: "swing_b1_reversal_short",
        triggerLine: `Entry: rejection at 1h high zone (≥ ${fmtPrice(hi - edge)}) + 5m turn down (≤ -${CFG.swingReversalMin5mMovePct.toFixed(
          2
        )}%)`,
      };
    }

    return { ok: false, reason: "swing_no_entry_trigger", detail: { p, hi, lo, nearHigh, p5 } };
  }

  return { ok: false, reason: "neutral_bias" };
}

export default async function handler(req, res) {
  let dry = false;
  let debug = false;
  let mode = CFG.defaultMode;
  let risk_profile = CFG.defaultRisk;

  try {
    const secret = process.env.ALERT_SECRET || "";

    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

    const key = String(req.query.key || "");
    const provided = bearer || key;

    if (!secret || provided !== secret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    debug = String(req.query.debug || "") === "1";
    const force = String(req.query.force || "") === "1";
    dry = String(req.query.dry || "") === "1";
    const driver_tf = normalizeDriverTf(req.query.driver_tf);

    mode = normalizeMode(req.query.mode) || CFG.defaultMode;
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
          mode,
          risk_profile,
          sent: false,
          triggered_count: 0,
          error: "multi fetch failed",
        },
        { dry }
      );
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

      const [lastStateModeRaw, lastStateLegacyRaw, lastSentRaw] = await Promise.all([
        redis.get(CFG.keys.lastState(mode, instId)),
        mode !== "scalp" ? redis.get(CFG.keys.last15mState(instId)) : Promise.resolve(null),
        redis.get(CFG.keys.lastSentAt(instId)),
      ]);

      const lastState = lastStateModeRaw
        ? String(lastStateModeRaw)
        : mode !== "scalp" && lastStateLegacyRaw
        ? String(lastStateLegacyRaw)
        : null;

      const lastSent = lastSentRaw == null ? null : Number(lastSentRaw);

      const { triggers, curState } = evaluateCriteria(item, lastState, mode);

      if (!force && !triggers.length) {
        if (debug) skipped.push({ symbol, reason: "no_triggers" });

        // Seed/refresh lastState even when skipping
        if (!dry && curState && curState !== "unknown") {
          await redis.set(CFG.keys.lastState(mode, instId), curState);
          if (mode !== "scalp") await redis.set(CFG.keys.last15mState(instId), curState);
        }
        continue;
      }

      if (!force && Number.isFinite(lastSent) && lastSent != null && now - lastSent < cooldownMs) {
        if (debug) skipped.push({ symbol, reason: "cooldown" });
        continue;
      }

      const bias = biasFromItem(item, mode);

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

        if (!dry && curState) {
          await redis.set(CFG.keys.lastState(mode, instId), curState);
          if (mode !== "scalp") await redis.set(CFG.keys.last15mState(instId), curState);
        }
        continue;
      }

      const levels = await computeLevelsFromSeries(instId);

      if (!force && levels?.["1h"]?.warmup) {
        if (debug) skipped.push({ symbol, reason: "warmup_gate_1h" });

        if (!dry && curState) {
          await redis.set(CFG.keys.lastState(mode, instId), curState);
          if (mode !== "scalp") await redis.set(CFG.keys.last15mState(instId), curState);
        }
        continue;
      }

      // B1 evaluation (scalp requires it; swing uses it via reversal trigger)
      const b1 = strongRecoB1({ bias, levels, price: item.price });

      let triggerLine = null;
      let execReason = null;

      if (!force) {
        if (String(mode) === "scalp") {
          if (!b1.strong) {
            if (debug) skipped.push({ symbol, reason: `weak_reco:${b1.reason}` });
            if (!dry && curState) await redis.set(CFG.keys.lastState(mode, instId), curState);
            continue;
          }

          const g = await scalpExecutionGate({ instId, item, bias, levels });
          if (!g.ok) {
            if (debug) skipped.push({ symbol, reason: `scalp_exec:${g.reason}`, bias, oi15: item?.deltas?.["15m"]?.oi_change_pct ?? null });
            if (!dry && curState) await redis.set(CFG.keys.lastState(mode, instId), curState);
            continue;
          }

          triggerLine = g.triggerLine || null;
          execReason = g.reason || null;
        } else {
          const g = swingExecutionGate({ bias, levels, item });
          if (!g.ok) {
            if (debug) skipped.push({ symbol, reason: `${String(mode)}_exec:${g.reason}`, bias, detail: g.detail || null });
            if (!dry && curState) {
              await redis.set(CFG.keys.lastState(mode, instId), curState);
              await redis.set(CFG.keys.last15mState(instId), curState);
            }
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
        b1,
        triggerLine,
        execReason,
      });

      if (!dry) {
        await redis.set(CFG.keys.lastSentAt(instId), String(now));
        if (curState) {
          await redis.set(CFG.keys.lastState(mode, instId), curState);
          if (mode !== "scalp") await redis.set(CFG.keys.last15mState(instId), curState);
        }
      }
    }

    const itemErrors = (skipped || []).filter((s) => String(s?.reason || "") === "item_not_ok").length;
    const topSkips = (skipped || []).slice(0, 12).map((s) => ({ symbol: s.symbol, reason: s.reason }));

    if (!force && !triggered.length) {
      await writeHeartbeat(
        { ts: now, iso: new Date(now).toISOString(), ok: true, mode, risk_profile, sent: false, triggered_count: 0, itemErrors, topSkips },
        { dry }
      );

      const heartbeat_last_run = debug ? await readHeartbeat() : undefined;

      return res.json({
        ok: true,
        sent: false,
        ...(debug ? { deploy: getDeployInfo(), multiUrl, macro, skipped, mode, risk_profile, heartbeat_last_run } : {}),
      });
    }

    const lines = [];
    lines.push(`⚡️ OKX perps alert (${driver_tf})${force ? " [FORCE]" : ""}${dry ? " [DRY]" : ""}`);
    lines.push(new Date().toISOString());
    lines.push("");

    for (const t of triggered) {
      const l1h = t.levels?.["1h"];
      const lvl = l1h && !l1h.warmup ? ` | 1h H/L=${fmtPrice(l1h.hi)}/${fmtPrice(l1h.lo)}` : "";
      lines.push(`${t.symbol} $${fmtPrice(t.price)} | bias=${t.bias}${lvl}`);
      if (t.triggerLine) lines.push(t.triggerLine);
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
          { ts: now, iso: new Date(now).toISOString(), ok: false, stage: "telegram_failed", mode, risk_profile, sent: false, triggered_count: triggered.length, itemErrors, topSkips, telegram_error: tg.detail || null },
          { dry }
        );
        return res.status(500).json({ ok: false, error: "telegram_failed", detail: tg.detail || null });
      }
    }

    await writeHeartbeat(
      { ts: now, iso: new Date(now).toISOString(), ok: true, mode, risk_profile, sent: !dry, triggered_count: triggered.length, itemErrors, topSkips },
      { dry }
    );

    const heartbeat_last_run = debug ? await readHeartbeat() : undefined;

    return res.json({
      ok: true,
      sent: !dry,
      triggered_count: triggered.length,
      ...(debug
        ? { deploy: getDeployInfo(), multiUrl, macro, skipped, triggered, mode, risk_profile, renderedMessage: message, heartbeat_last_run }
        : {}),
    });
  } catch (e) {
    const now = Date.now();
    await writeHeartbeat(
      { ts: now, iso: new Date(now).toISOString(), ok: false, stage: "handler_exception", mode, risk_profile, sent: false, triggered_count: 0, error: String(e?.message || e) },
      { dry }
    );
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}