// /api/alert.js
// V1 Alerts: pulls /api/multi, evaluates trigger criteria, applies cooldown, sends Telegram DM.
// Adds "levels" (1h/4h hi/lo/mid) computed from stored 5m series in Upstash.
//
// NEW:
// - Hard warmup gate: non-force alerts require 1h levels ready
// - B1 strong recommendation gate retained
// - FIX: safeJsonParse handles string OR already-parsed object (matches multi.js)
// - debug=1 returns skip reasons (no Telegram behavior change)
// - NEW MACRO GATE: if BTC is in 4h bull expansion, block SHORT-bias alerts on ALTS (non-force)
// - NEW REGIME ADJUST (expansion + contraction):
//   - If 4h expansion in one direction, downgrade fade signals (strong->weak)
//   - If extreme contraction, optionally upgrade near-edge signals (weak->strong) via wider edge
//
// STEP 1 (Mode + Risk Wiring):
// - Parse mode + risk_profile from query params
// - Fall back to env defaults DEFAULT_MODE / DEFAULT_RISK_PROFILE
// - Echo mode/risk_profile in debug JSON only
//
// STEP 2 (Mode-aware Bias):
// - scalp => bias from 15m lean (fallback item lean)
// - swing/build => bias from 4h lean (fallback 15m, then item lean)

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

  // STEP 1 defaults (wiring only)
  defaultMode: String(process.env.DEFAULT_MODE || "scalp").toLowerCase(),
  defaultRisk: String(process.env.DEFAULT_RISK_PROFILE || "normal").toLowerCase(),

  momentumAbs5mPricePct: 0.1,
  shockOi15mPct: 0.5,
  shockAbs15mPricePct: 0.2,

  levelWindows: {
    "1h": 12,
    "4h": 48,
  },

  strongEdgePct1h: Number(process.env.ALERT_STRONG_EDGE_PCT_1H || 0.15),

  telegramMaxChars: 3900,

  // ---- MACRO GATE (BTC regime) ----
  macro: {
    enabled: String(process.env.ALERT_MACRO_GATE_ENABLED || "1") === "1",
    btcSymbol: String(process.env.ALERT_MACRO_BTC_SYMBOL || "BTCUSDT").toUpperCase(),
    // Bull expansion thresholds (4h)
    btc4hPricePctMin: Number(process.env.ALERT_MACRO_BTC_4H_PRICE_PCT_MIN || 2.0),
    btc4hOiPctMin: Number(process.env.ALERT_MACRO_BTC_4H_OI_PCT_MIN || 0.5),
    // If true: block ALTs that have bias=short while BTC is bull expansion
    blockShortsOnAltsWhenBtcBull: String(process.env.ALERT_MACRO_BLOCK_SHORTS_ON_ALTS || "1") === "1",
  },

  // ---- REGIME ADJUST (per-symbol 4h) ----
  regime: {
    enabled: String(process.env.ALERT_REGIME_ENABLED || "1") === "1",

    // Expansion: directional trend + participation
    expansionPricePctMin: Number(process.env.ALERT_REGIME_EXPANSION_4H_PRICE_PCT_MIN || 3.0),
    expansionOiPctMin: Number(process.env.ALERT_REGIME_EXPANSION_4H_OI_PCT_MIN || 1.0),

    // Contraction: low movement + OI bleed
    contractionAbsPricePctMax: Number(process.env.ALERT_REGIME_CONTRACTION_4H_ABS_PRICE_PCT_MAX || 1.0),
    contractionOiPctMax: Number(process.env.ALERT_REGIME_CONTRACTION_4H_OI_PCT_MAX || -1.0),

    // Upgrade weak->strong only in contraction if price is within a wider edge band
    contractionUpgradeEnabled: String(process.env.ALERT_REGIME_CONTRACTION_UPGRADE_ENABLED || "1") === "1",
    contractionUpgradeEdgeMult: Number(process.env.ALERT_REGIME_CONTRACTION_UPGRADE_EDGE_MULT || 1.5),
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

// STEP 1: mode + risk normalizers
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
  if (x == null || !Number.isFinite(x)) return "n/a";
  if (x < 1) return x.toFixed(6);
  if (x < 100) return x.toFixed(4);
  return x.toFixed(2);
};

// ✅ FIX: handle string OR already-parsed object (same as multi.js)
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

// STEP 2: mode-aware bias selection
function biasFromItem(item, mode) {
  const m = String(mode || "scalp").toLowerCase();

  if (m === "swing" || m === "build") {
    const lean4h = item?.deltas?.["4h"]?.lean || item?.deltas?.["15m"]?.lean || item?.lean || "neutral";
    return String(lean4h).toLowerCase();
  }

  // scalp (default)
  const lean15m = item?.deltas?.["15m"]?.lean || item?.lean || "neutral";
  return String(lean15m).toLowerCase();
}

// ---- edge check helper (used for base + contraction upgrade) ----
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

// ---- base B1 reco ----
function strongRecoB1({ bias, levels, price }) {
  return edgeRecoCheck({ bias, levels, price, edgePct: CFG.strongEdgePct1h });
}

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

// ---- derive BTC macro regime from /api/multi results ----
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

// ---- NEW: per-symbol 4h regime ----
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

// ---- NEW: adjust reco using regime (expansion downgrade + contraction upgrade) ----
function adjustRecoForRegime({ item, bias, levels, price, baseReco }) {
  if (!CFG.regime.enabled) return { ...baseReco, adj: { type: "none" } };

  const reg = computeSymbolRegime(item);

  // Expansion: downgrade fade setups (strong->weak)
  if (reg?.ok && baseReco?.strong) {
    if (reg.type === "bull_expansion" && bias === "short") {
      return {
        strong: false,
        reason: "regime_downgrade_bull_expansion_fade",
        adj: { type: reg.type, ...reg },
      };
    }
    if (reg.type === "bear_expansion" && bias === "long") {
      return {
        strong: false,
        reason: "regime_downgrade_bear_expansion_fade",
        adj: { type: reg.type, ...reg },
      };
    }
  }

  // Contraction: optional upgrade weak->strong if within wider edge band
  if (reg?.ok && reg.type === "contraction" && CFG.regime.contractionUpgradeEnabled && !baseReco?.strong) {
    const widened = CFG.strongEdgePct1h * Math.max(1, CFG.regime.contractionUpgradeEdgeMult);
    const up = edgeRecoCheck({ bias, levels, price, edgePct: widened });

    if (up.strong) {
      return {
        strong: true,
        reason: "regime_upgrade_contraction",
        adj: { type: reg.type, widenedEdgePct: widened, ...reg },
      };
    }
  }

  return { ...baseReco, adj: { type: reg?.type || "unknown", ...reg } };
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

    // STEP 1: parse mode + risk_profile
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

      const [lastStateRaw, lastSentRaw] = await Promise.all([
        redis.get(CFG.keys.last15mState(instId)),
        redis.get(CFG.keys.lastSentAt(instId)),
      ]);

      const lastState = lastStateRaw ? String(lastStateRaw) : null;
      const lastSent = lastSentRaw == null ? null : Number(lastSentRaw);

      const { triggers, curState } = evaluateCriteria(item, lastState);

      if (!force && !triggers.length) {
        if (debug) skipped.push({ symbol, reason: "no_triggers" });
        continue;
      }

      if (!force && Number.isFinite(lastSent) && lastSent != null && now - lastSent < cooldownMs) {
        if (debug) skipped.push({ symbol, reason: "cooldown" });
        continue;
      }

      // STEP 2: mode-aware bias
      const bias = biasFromItem(item, mode);

      // ---- MACRO GATE (block shorts on ALTs during BTC bull expansion) ----
      if (
        !force &&
        CFG.macro.enabled &&
        CFG.macro.blockShortsOnAltsWhenBtcBull &&
        macro?.ok &&
        macro?.btcBullExpansion4h &&
        symbol.toUpperCase() !== CFG.macro.btcSymbol &&
        bias === "short"
      ) {
        if (debug) {
          skipped.push({
            symbol,
            reason: "macro_block_btc_bull_expansion",
            btc4h: macro?.btc || null,
          });
        }
        if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
        continue;
      }

      const levels = await computeLevelsFromSeries(instId);

      // HARD WARMUP GATE
      if (!force && levels?.["1h"]?.warmup) {
        if (debug) skipped.push({ symbol, reason: "warmup_gate_1h" });
        if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
        continue;
      }

      // Base reco then regime-adjusted reco
      const baseReco = strongRecoB1({ bias, levels, price: item.price });
      const reco = adjustRecoForRegime({ item, bias, levels, price: item.price, baseReco });

      if (!force && !reco.strong) {
        if (debug) skipped.push({ symbol, reason: `weak_reco:${reco.reason}` });
        if (!dry && curState) await redis.set(CFG.keys.last15mState(instId), curState);
        continue;
      }

      triggered.push({ symbol, price: item.price, bias, triggers, levels, reco });

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
      lines.push("");
    }

    // Drilldown should include only alerted symbols + BTC for context
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