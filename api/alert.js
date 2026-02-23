// /api/alert.js
// Pulls /api/multi and sends a Telegram DM summary ONLY when rules trigger.
// Easily modifiable: all thresholds + toggles live in ALERT_CONFIG.
// Env vars required:
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
// Optional:
// - DEFAULT_SYMBOLS (same as multi.js)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ----------------------
// Modifiable alert config
// ----------------------
const ALERT_CONFIG = {
  // Per-symbol cooldown (seconds) unless force=1
  COOLDOWN_SECONDS: 20 * 60,

  // Rule 1: Setup flip on 15m state change
  RULE_SETUP_FLIP: true,

  // Rule 2: Momentum confirmation
  RULE_MOMENTUM: true,
  MOMENTUM_MIN_ABS_5M_PRICE_PCT: 0.10, // 0.10%+

  // Rule 3: Positioning shock on 15m
  RULE_POSITIONING_SHOCK: true,
  SHOCK_MIN_15M_OI_PCT: 0.50,          // +0.50%+
  SHOCK_MIN_ABS_15M_PRICE_PCT: 0.20,   // 0.20%+

  // Which timeframe drives the "flip" comparison
  FLIP_TF: "15m",
};

// ----------------------
// Helpers
// ----------------------
function normalizeSymbols(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeDriverTf(raw) {
  const tf = String(raw || "5m").toLowerCase();
  const allowed = new Set(["5m", "15m", "30m", "1h", "4h"]);
  return allowed.has(tf) ? tf : "5m";
}

function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x.toFixed(3)}%`;
}

function absNum(x) {
  return x == null || !Number.isFinite(x) ? null : Math.abs(x);
}

function num(x) {
  return x == null || !Number.isFinite(x) ? null : x;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { ok: false, error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) {
    return { ok: false, error: "Telegram send failed", detail: j || null };
  }
  return { ok: true };
}

function pickSymbols(req) {
  const querySymbols = normalizeSymbols(req.query.symbols);
  if (querySymbols.length > 0) return querySymbols;

  const envSymbols = normalizeSymbols(process.env.DEFAULT_SYMBOLS);
  if (envSymbols.length > 0) return envSymbols;

  return ["BTCUSDT", "ETHUSDT", "LDOUSDT"];
}

function buildMultiUrl(req, symbols, driver_tf, debug) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();

  const qs = new URLSearchParams();
  qs.set("symbols", symbols.join(","));
  qs.set("driver_tf", driver_tf);
  if (debug) qs.set("debug", "1");

  return `${proto}://${host}/api/multi?${qs.toString()}`;
}

function shouldTriggerForSymbol(item, prevFlipState) {
  // item is one entry from /api/multi results
  const d5 = item?.deltas?.["5m"] || null;
  const d15 = item?.deltas?.["15m"] || null;

  const reasons = [];

  // RULE 1: Setup flip (15m state changed since last alert check)
  if (ALERT_CONFIG.RULE_SETUP_FLIP) {
    const flipStateNow = item?.deltas?.[ALERT_CONFIG.FLIP_TF]?.state || null;
    if (flipStateNow && prevFlipState && flipStateNow !== prevFlipState) {
      reasons.push(`flip(${ALERT_CONFIG.FLIP_TF}): ${prevFlipState} -> ${flipStateNow}`);
    }
  }

  // RULE 2: Momentum confirmation (5m & 15m lean match AND abs(5m price) >= threshold)
  if (ALERT_CONFIG.RULE_MOMENTUM) {
    const lean5 = d5?.lean || null;
    const lean15 = d15?.lean || null;
    const p5 = absNum(num(d5?.price_change_pct));
    if (lean5 && lean15 && lean5 === lean15 && p5 != null && p5 >= ALERT_CONFIG.MOMENTUM_MIN_ABS_5M_PRICE_PCT) {
      reasons.push(`momentum: 5m&15m=${lean5} and |5m p|>=${ALERT_CONFIG.MOMENTUM_MIN_ABS_5M_PRICE_PCT}%`);
    }
  }

  // RULE 3: Positioning shock (15m OI up big AND abs(15m price) >= threshold)
  if (ALERT_CONFIG.RULE_POSITIONING_SHOCK) {
    const oi15 = num(d15?.oi_change_pct);
    const p15 = absNum(num(d15?.price_change_pct));
    if (
      oi15 != null &&
      p15 != null &&
      oi15 >= ALERT_CONFIG.SHOCK_MIN_15M_OI_PCT &&
      p15 >= ALERT_CONFIG.SHOCK_MIN_ABS_15M_PRICE_PCT
    ) {
      reasons.push(
        `shock: 15m oi>=${ALERT_CONFIG.SHOCK_MIN_15M_OI_PCT}% and |15m p|>=${ALERT_CONFIG.SHOCK_MIN_ABS_15M_PRICE_PCT}%`
      );
    }
  }

  return reasons;
}

async function isCoolingDown(symbol, nowMs) {
  const key = `alert:lastsent:${symbol}`;
  const raw = await redis.get(key);
  const lastMs = raw == null ? null : Number(raw);
  if (!Number.isFinite(lastMs)) return false;

  const ageSec = (nowMs - lastMs) / 1000;
  return ageSec < ALERT_CONFIG.COOLDOWN_SECONDS;
}

async function setLastSent(symbol, nowMs) {
  const key = `alert:lastsent:${symbol}`;
  await redis.set(key, String(nowMs));
  // keep a while, not critical
  await redis.expire(key, 60 * 60 * 24 * 7);
}

async function getPrevFlipState(symbol) {
  const key = `alert:flipstate:${ALERT_CONFIG.FLIP_TF}:${symbol}`;
  const v = await redis.get(key);
  return v == null ? null : String(v);
}

async function setPrevFlipState(symbol, state) {
  const key = `alert:flipstate:${ALERT_CONFIG.FLIP_TF}:${symbol}`;
  await redis.set(key, String(state || ""));
  await redis.expire(key, 60 * 60 * 24 * 7);
}

export default async function handler(req, res) {
  try {
    const now = Date.now();

    const symbols = pickSymbols(req);
    const driver_tf = normalizeDriverTf(req.query.driver_tf);
    const debug = String(req.query.debug || "") === "1";
    const force = String(req.query.force || "") === "1";

    const multiUrl = buildMultiUrl(req, symbols, driver_tf, debug);

    const r = await fetch(multiUrl, { headers: { "Cache-Control": "no-store" } });
    const j = await r.json().catch(() => null);

    if (!r.ok || !j?.ok) {
      return res.status(500).json({
        ok: false,
        error: "multi fetch failed",
        detail: j || null,
        multiUrl,
        symbols,
        driver_tf,
      });
    }

    // Decide triggers per symbol
    const triggered = [];
    const skippedCooldown = [];

    for (const item of j.results || []) {
      if (!item?.ok) continue;

      const sym = item.symbol;

      // Always update prev flip state so flip detection works even if we didn't alert last time
      const flipStateNow = item?.deltas?.[ALERT_CONFIG.FLIP_TF]?.state || null;
      const prevFlipState = await getPrevFlipState(sym);

      const reasons = force ? ["force=1"] : shouldTriggerForSymbol(item, prevFlipState);

      // update stored flip state after evaluating
      if (flipStateNow) await setPrevFlipState(sym, flipStateNow);

      if (reasons.length === 0) continue;

      if (!force) {
        const cooling = await isCoolingDown(sym, now);
        if (cooling) {
          skippedCooldown.push(sym);
          continue;
        }
      }

      triggered.push({ item, reasons });
    }

    // If nothing triggered, return cleanly (no Telegram)
    if (triggered.length === 0) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        sent: false,
        reason: "no triggers",
        symbols,
        driver_tf,
        multiUrl,
        skippedCooldown,
      });
    }

    // Build DM (only triggered symbols)
    const lines = [];
    lines.push(`OKX perps alert (${driver_tf})`);
    lines.push(new Date(j.ts).toISOString());
    lines.push("");

    for (const t of triggered) {
      const item = t.item;
      const d5 = item.deltas?.["5m"];
      const d15 = item.deltas?.["15m"];
      const d1h = item.deltas?.["1h"];

      lines.push(
        [
          `${item.symbol} $${item.price}`,
          `driver=${item.state}/${item.lean}`,
          `reasons=${t.reasons.join(", ")}`,
        ].join(" | ")
      );

      lines.push(
        [
          `  5m p=${fmtPct(d5?.price_change_pct)} oi=${fmtPct(d5?.oi_change_pct)}`,
          `15m p=${fmtPct(d15?.price_change_pct)} oi=${fmtPct(d15?.oi_change_pct)}`,
          `1h p=${fmtPct(d1h?.price_change_pct)} oi=${fmtPct(d1h?.oi_change_pct)}`,
        ].join(" | ")
      );
    }

    lines.push("");
    lines.push(multiUrl);

    const text = lines.join("\n");
    const tg = await sendTelegram(text);

    if (!tg.ok) {
      return res.status(500).json({
        ok: false,
        error: tg.error,
        detail: tg.detail || null,
        symbols,
        driver_tf,
        multiUrl,
      });
    }

    // Record last sent for cooldown
    for (const t of triggered) {
      await setLastSent(t.item.symbol, now);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      sent: true,
      forced: force,
      symbols,
      driver_tf,
      multiUrl,
      triggered: triggered.map((t) => ({ symbol: t.item.symbol, reasons: t.reasons })),
      skippedCooldown,
      config: debug ? ALERT_CONFIG : undefined,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}