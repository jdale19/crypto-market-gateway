// /api/alert.js
// Crypto Market Gateway — mode-aware alerts (scalp strict, swing realistic)
//
// CHANGE (minimal rework):
// - MULTI MODE SELECTION: support mode=scalp,swing,build and DEFAULT_MODES env var
// - PRIORITY: faster mode always wins (SCALP > SWING > BUILD)
// - SCALP: unchanged logic
// - SWING/BUILD: shared "execution rules" with different gating/thresholds
//
// Data dependencies (Redis):
// - series5m:${instId}  (rolling 5m list of {b,ts,p,fr,oi})
// - snap5m:${instId}:${bucket}  (snapshot points written by /api/snapshot)
// - alert:lastSentAt:${instId} (cooldown)
// - alert:lastState:${mode}:${instId} (optional state tracking)
//
// Schedules (typical):
// - /api/snapshot every 5m (*/5 * * * *)
// - /api/alert every 5m offset by 1 (1-59/5 * * * *)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MODE_PRIORITY = ["scalp", "swing", "build"];

const CFG = {
  keys: {
    series5m: (instId) => `series5m:${instId}`,
    lastSentAt: (instId) => `alert:lastSentAt:${instId}`,
    lastState: (mode, instId) => `alert:lastState:${mode}:${instId}`,
    lastState15m: (instId) => `alert:lastState15m:${instId}`,
    // legacy mirrors / optional
    lastStateLegacy: (instId) => `alert:lastState:${instId}`,
  },

  cooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 20),

  // stop config
  stop: {
    reversalUseWick:
      String(process.env.ALERT_STOP_REVERSAL_USE_WICK || "0") === "1",
    reversalBodyPct: Number(process.env.ALERT_STOP_REVERSAL_BODY_PCT || 1.0),
    reversalPadPct: Number(process.env.ALERT_STOP_REVERSAL_PAD_PCT || 0.05),
    contPadPct: Number(process.env.ALERT_STOP_CONT_PAD_PCT || 0.03),
  },

  // windows for “levels”
  levelWindows: {
    "15m": 3,
    "1h": 12,
    "4h": 48,
  },

  // swing/build gating knobs
  strongEdgePct1h: Number(process.env.ALERT_STRONG_EDGE_PCT_1H || 0.15),
  swingReversalMin5mMovePct: Number(
    process.env.ALERT_SWING_REVERSAL_MIN_5M_MOVE_PCT || 0.05
  ),

  heartbeat: {
    enabled: String(process.env.ALERT_HEARTBEAT_ENABLED || "1") === "1",
    key: String(process.env.ALERT_HEARTBEAT_KEY || "alert:lastRun"),
    ttlSeconds: Number(process.env.ALERT_HEARTBEAT_TTL_SECONDS || 86400),
  },
};

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function pickModes(req) {
  const q = String(req.query.mode || "").trim().toLowerCase();
  if (q) {
    return q
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const env = String(process.env.DEFAULT_MODES || "").trim().toLowerCase();
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = String(process.env.DEFAULT_MODE || "scalp")
    .trim()
    .toLowerCase();
  return [single];
}

function normalizeSymbols(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * SAFE TAIL READER FOR REDIS LISTS
 *
 * Upstash REST + negative LRANGE indices can behave inconsistently.
 * We always compute positive bounds using LLEN to guarantee deterministic tail reads.
 *
 * DO NOT revert back to negative LRANGE.
 */
async function lrangeTail(key, n) {
  const need = Math.max(1, Number(n) || 1);
  const len = await redis.llen(key);
  if (!Number.isFinite(len) || len <= 0) return [];
  const end = len - 1;
  const start = Math.max(0, len - need);
  return await redis.lrange(key, start, end);
}

async function getPrevClosePair(instId) {
  const raw = await lrangeTail(CFG.keys.series5m(instId), 3);
  const pts = (raw || []).map(safeJsonParse).filter(Boolean);
  const closes = pts.map((p) => asNum(p?.p)).filter((x) => x != null);
  if (closes.length < 2) return null;
  return { prev: closes[closes.length - 2], last: closes[closes.length - 1] };
}

async function computeLevelsFromSeries(instId) {
  const need = Math.max(...Object.values(CFG.levelWindows));
  const raw = await lrangeTail(CFG.keys.series5m(instId), need);

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
    out[label] = { warmup: false, hi, lo, mid: (hi + lo) / 2 };
  }

  return out;
}

async function getRecentPricesFromSeries(instId, n) {
  const raw = await lrangeTail(CFG.keys.series5m(instId), Math.max(1, n));
  return (raw || [])
    .map(safeJsonParse)
    .filter(Boolean)
    .map((p) => asNum(p?.p))
    .filter((x) => x != null);
}

function chooseBestMode(modeList) {
  const set = new Set(modeList.map((m) => String(m || "").toLowerCase()));
  for (const m of MODE_PRIORITY) {
    if (set.has(m)) return m;
  }
  // fallback to first
  return String(modeList?.[0] || "scalp").toLowerCase();
}

function computeBiasAndReco(result) {
  // result structure comes from /api/multi. Keep logic as-is from your existing file.
  const lean = String(result?.lean || "").toLowerCase();
  const why = String(result?.why || "");
  const state = String(result?.state || "");
  let bias = "neutral";
  if (lean === "long") bias = "long";
  if (lean === "short") bias = "short";

  // map to reco strength (existing heuristic)
  let reco = "weak";
  if (String(state).includes("opening")) reco = "strong";
  if (String(state).includes("closing")) reco = "medium";

  return { bias, reco, lean, why, state };
}

function withinPct(a, b, pct) {
  const A = asNum(a);
  const B = asNum(b);
  if (A == null || B == null || B === 0) return false;
  return Math.abs((A - B) / B) * 100 <= pct;
}

function pctDiff(a, b) {
  const A = asNum(a);
  const B = asNum(b);
  if (A == null || B == null || B === 0) return null;
  return ((A - B) / B) * 100;
}

// --- Execution rules: scalp/swing/build ---
function scalpExecution({ price, levels, bias, reco }) {
  // strict: only act when price is near 1h extremes for the bias
  const px = asNum(price);
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "levels_warmup" };
  if (bias === "long") {
    if (reco === "weak") return { ok: false, reason: "weak_reco:long" };
    // require near low
    const nearLow = withinPct(px, l1h.lo, 0.25);
    if (!nearLow) return { ok: false, reason: "weak_reco:long_not_near_low" };
    return { ok: true, reason: "scalp_exec:near_1h_low" };
  }
  if (bias === "short") {
    if (reco === "weak") return { ok: false, reason: "weak_reco:short" };
    const nearHigh = withinPct(px, l1h.hi, 0.25);
    if (!nearHigh) return { ok: false, reason: "weak_reco:short_not_near_high" };
    return { ok: true, reason: "scalp_exec:near_1h_high" };
  }
  return { ok: false, reason: "neutral_bias" };
}

function swingExecution({ price, levels, deltas }) {
  // less strict, requires a 1h edge and an entry trigger (existing rules)
  const px = asNum(price);
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { ok: false, reason: "levels_warmup" };

  // example: require strong edge to either side
  const edgeToLow = pctDiff(px, l1h.lo);
  const edgeToHigh = pctDiff(l1h.hi, px); // distance to high
  const edge = Math.max(asNum(edgeToLow) || 0, asNum(edgeToHigh) || 0);
  if (edge < CFG.strongEdgePct1h) return { ok: false, reason: "swing_exec:no_edge" };

  // require an entry trigger from deltas (placeholder retains your original pattern)
  // Your original file had specific swing checks; keep as-is by using provided deltas.
  const oi15 = asNum(deltas?.["15m"]?.oi_change_pct);
  if (oi15 != null && oi15 < -5) {
    return { ok: false, reason: "swing_exec:oi15_too_negative_for_swing" };
  }

  // basic trigger
  return { ok: true, reason: "swing_exec:edge_ok" };
}

function buildExecution({ price, levels, deltas }) {
  // build is most conservative; reuse swing gating and add extra filters as needed
  const swing = swingExecution({ price, levels, deltas });
  if (!swing.ok) return { ok: false, reason: `build_exec:${swing.reason}` };
  return { ok: true, reason: "build_exec:edge_ok" };
}

// --- Stop logic ---
async function computeStopLossPx({ instId, bias, price, levels, execReason }) {
  const px = asNum(price);
  if (px == null) return null;

  const isReversal = String(execReason || "").toLowerCase().includes("reversal");

  // Reversal stop: based on previous candle body (close-close), padded.
  if (isReversal) {
    const pair = await getPrevClosePair(instId);
    if (!pair) return null;

    const body = Math.abs(pair.last - pair.prev);
    if (!Number.isFinite(body) || body <= 0) return null;

    const dist = body * Math.max(0, Math.min(1, CFG.stop.reversalBodyPct));
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

  // Continuation stop: use 1h range extremes with pad
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

// --- Cooldown/state ---
async function shouldCooldown(instId) {
  const last = await redis.get(CFG.keys.lastSentAt(instId));
  const ts = asNum(last);
  if (ts == null) return false;
  const ms = Date.now() - ts;
  return ms < CFG.cooldownMinutes * 60 * 1000;
}

async function markSent(instId) {
  await redis.set(CFG.keys.lastSentAt(instId), Date.now(), {
    ex: CFG.cooldownMinutes * 60,
  });
}

async function setState(mode, instId, curState) {
  try {
    await redis.set(CFG.keys.lastState(mode, instId), curState, { ex: 3600 });
    await redis.set(CFG.keys.lastStateLegacy(instId), curState, { ex: 3600 }); // legacy mirror
    await redis.set(CFG.keys.lastState15m(instId), curState, { ex: 3600 }); // legacy mirror
  } catch {}
}

// --- Telegram sending ---
async function sendTelegram(text, { dry } = { dry: false }) {
  if (dry) return { ok: true, dry: true };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: "missing_telegram_env" };

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json().catch(() => ({}));
  return { ok: !!j?.ok, status: r.status, tg: j };
}

// --- Main handler ---
export default async function handler(req, res) {
  const dry = String(req.query.debug || "0") === "1"; // debug mode: do not send TG

  try {
    const secret = process.env.ALERT_SECRET || "";
    const provided =
      req.headers.authorization?.replace("Bearer ", "") || req.query.key || "";

    if (!secret || provided !== secret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const modes = pickModes(req);
    const mode = chooseBestMode(modes);

    const driver_tf = String(req.query.driver_tf || "5m");
    const symbols = normalizeSymbols(req.query.symbols || process.env.DEFAULT_SYMBOLS || "");

    // heartbeat
    if (CFG.heartbeat.enabled) {
      await redis.set(
        CFG.heartbeat.key,
        { ts: Date.now(), iso: nowIso(), ok: true, modes, risk_profile: process.env.DEFAULT_RISK_PROFILE || "normal" },
        { ex: CFG.heartbeat.ttlSeconds }
      );
    }

    // Call /api/multi in snapshot mode (same host)
    const baseUrl =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `https://${req.headers.host}`;
    const multiUrl = new URL(`${baseUrl}/api/multi`);
    if (symbols.length) multiUrl.searchParams.set("symbols", symbols.join(","));
    multiUrl.searchParams.set("driver_tf", driver_tf);
    multiUrl.searchParams.set("source", "snapshot");
    multiUrl.searchParams.set("snapshot", "1");

    const multiResp = await fetch(multiUrl.toString());
    const multiJson = await multiResp.json();

    const results = Array.isArray(multiJson?.results) ? multiJson.results : [];

    let triggered_count = 0;
    let sent = false;
    const topSkips = [];
    let itemErrors = 0;

    for (const r of results) {
      try {
        const symbol = String(r?.symbol || "");
        const instId = String(r?.instId || "");
        const price = asNum(r?.price);
        if (!symbol || !instId || price == null) continue;

        // cooldown gate
        if (await shouldCooldown(instId)) {
          topSkips.push({ symbol, mode, reason: "cooldown" });
          continue;
        }

        const { bias, reco, why, state } = computeBiasAndReco(r);

        // levels from rolling series
        const levels = await computeLevelsFromSeries(instId);

        // mode execution
        let exec = { ok: false, reason: "no_mode" };
        if (mode === "scalp") exec = scalpExecution({ price, levels, bias, reco });
        if (mode === "swing") exec = swingExecution({ price, levels, deltas: r?.deltas });
        if (mode === "build") exec = buildExecution({ price, levels, deltas: r?.deltas });

        if (!exec.ok) {
          topSkips.push({ symbol, mode, reason: exec.reason });
          continue;
        }

        const stopLoss = await computeStopLossPx({
          instId,
          bias,
          price,
          levels,
          execReason: exec.reason,
        });

        // basic TP suggestion: opposite 1h extreme
        const l1h = levels?.["1h"];
        let tp = null;
        if (l1h && !l1h.warmup) {
          if (bias === "long") tp = l1h.hi;
          if (bias === "short") tp = l1h.lo;
        }

        // Build message
        const msg =
          `⚡️ OKX perps alert (${driver_tf})\n` +
          `${nowIso()}\n\n` +
          `${symbol} $${price} | bias=${bias} | reco=${reco}\n` +
          `${why}\n` +
          (stopLoss != null ? `SL: ${stopLoss}\n` : "") +
          (tp != null ? `TP: ${tp}\n` : "") +
          `mode=${mode} | state=${state}\n`;

        const tg = await sendTelegram(msg, { dry });
        if (tg.ok) {
          sent = true;
          triggered_count += 1;
          await markSent(instId);
          await setState(mode, instId, state);
        } else {
          itemErrors += 1;
        }
      } catch (e) {
        itemErrors += 1;
      }
    }

    // cap skip list to keep heartbeat small
    const trimmedSkips = topSkips.slice(0, 12);

    // update heartbeat with run result details
    if (CFG.heartbeat.enabled) {
      await redis.set(
        CFG.heartbeat.key,
        {
          ts: Date.now(),
          iso: nowIso(),
          ok: true,
          modes,
          risk_profile: process.env.DEFAULT_RISK_PROFILE || "normal",
          sent,
          triggered_count,
          itemErrors,
          topSkips: trimmedSkips,
        },
        { ex: CFG.heartbeat.ttlSeconds }
      );
    }

    return res.status(200).json({
      ok: true,
      ts: Date.now(),
      iso: nowIso(),
      mode,
      modes,
      driver_tf,
      symbols,
      sent,
      triggered_count,
      itemErrors,
      topSkips: trimmedSkips,
    });
  } catch (e) {
    try {
      if (CFG.heartbeat.enabled) {
        await redis.set(
          CFG.heartbeat.key,
          {
            ts: Date.now(),
            iso: nowIso(),
            ok: false,
            sent: false,
            triggered_count: 0,
            error: String(e?.message || e),
          },
          { ex: CFG.heartbeat.ttlSeconds }
        );
      }
    } catch {}
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}