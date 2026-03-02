// /api/alert.js
// Crypto Market Gateway — mode-aware alerts (scalp strict, swing realistic)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MODE_PRIORITY = ["scalp", "swing", "build"];

const CFG = {
  cooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 20),

  stop: {
    reversalUseWick:
      String(process.env.ALERT_STOP_REVERSAL_USE_WICK || "0") === "1",
    reversalBodyPct: Number(process.env.ALERT_STOP_REVERSAL_BODY_PCT || 1.0),
    reversalPadPct: Number(process.env.ALERT_STOP_REVERSAL_PAD_PCT || 0.05),
    contPadPct: Number(process.env.ALERT_STOP_CONT_PAD_PCT || 0.03),
  },

  defaultModesRaw: String(process.env.DEFAULT_MODES || "").toLowerCase(),
  defaultMode: String(process.env.DEFAULT_MODE || "scalp").toLowerCase(),
  defaultRisk: String(process.env.DEFAULT_RISK_PROFILE || "normal").toLowerCase(),

  levelWindows: {
    "15m": 3,
    "1h": 12,
    "4h": 48,
  },

  strongEdgePct1h: Number(process.env.ALERT_STRONG_EDGE_PCT_1H || 0.15),

  swingReversalMin5mMovePct: Number(
    process.env.ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT || 0.05
  ),

  heartbeat: {
    key: String(process.env.ALERT_HEARTBEAT_KEY || "alert:lastRun"),
    ttlSeconds: Number(
      process.env.ALERT_HEARTBEAT_TTL_SECONDS || 60 * 60 * 24
    ),
  },

  keys: {
    lastSentAt: (id) => `alert:lastSentAt:${id}`,
    series5m: (id) => `series5m:${id}`,
  },
};

const asNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/**
 * SAFE TAIL READER FOR REDIS LISTS
 *
 * Upstash REST + negative LRANGE indices can behave inconsistently.
 * We always compute positive bounds using LLEN.
 */
async function lrangeTail(redis, key, n) {
  const need = Math.max(1, Number(n) || 1);
  const len = await redis.llen(key);
  if (!Number.isFinite(len) || len <= 0) return [];
  const end = len - 1;
  const start = Math.max(0, len - need);
  return await redis.lrange(key, start, end);
}

async function getPrevClosePair(instId) {
  const raw = await lrangeTail(redis, CFG.keys.series5m(instId), 3);
  const pts = (raw || []).map(safeJsonParse).filter(Boolean);
  const closes = pts.map((p) => asNum(p?.p)).filter((x) => x != null);
  if (closes.length < 2) return null;
  return {
    prev: closes[closes.length - 2],
    last: closes[closes.length - 1],
  };
}

async function computeLevelsFromSeries(instId) {
  const need = Math.max(...Object.values(CFG.levelWindows));
  const raw = await lrangeTail(redis, CFG.keys.series5m(instId), need);

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
  const raw = await lrangeTail(redis, CFG.keys.series5m(instId), n);
  return (raw || [])
    .map(safeJsonParse)
    .filter(Boolean)
    .map((p) => asNum(p?.p))
    .filter((x) => x != null);
}

async function computeStopLossPx({
  instId,
  mode,
  bias,
  price,
  levels,
  execReason,
}) {
  const px = asNum(price);
  if (px == null) return null;

  const isReversal =
    String(execReason || "").toLowerCase().includes("b1_reversal");

  if (isReversal) {
    const pair = await getPrevClosePair(instId);
    if (!pair) return null;

    const body = Math.abs(pair.last - pair.prev);
    if (!Number.isFinite(body) || body <= 0) return null;

    const dist =
      body *
      Math.max(0, Math.min(1, CFG.stop.reversalBodyPct));

    let sl = null;

    if (bias === "long") sl = px - dist;
    if (bias === "short") sl = px + dist;

    const pad = CFG.stop.reversalPadPct / 100;
    if (pad > 0) {
      if (bias === "long") sl *= 1 - pad;
      if (bias === "short") sl *= 1 + pad;
    }

    return sl;
  }

  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return null;

  let sl = null;
  if (bias === "long") sl = l1h.lo;
  if (bias === "short") sl = l1h.hi;

  const pad = CFG.stop.contPadPct / 100;
  if (pad > 0) {
    if (bias === "long") sl *= 1 - pad;
    if (bias === "short") sl *= 1 + pad;
  }

  return sl;
}

export default async function handler(req, res) {
  try {
    const secret = process.env.ALERT_SECRET || "";
    const provided =
      req.headers.authorization?.replace("Bearer ", "") ||
      req.query.key ||
      "";

    if (!secret || provided !== secret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    return res.json({ ok: true, status: "alert.js loaded cleanly" });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: String(e?.message || e) });
  }
}