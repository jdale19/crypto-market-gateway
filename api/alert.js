// /api/alert.js
// V1 Alerts: pulls /api/multi, evaluates trigger criteria, applies cooldown, sends Telegram DM.
// Adds "levels" (1h/4h hi/lo/mid) computed from stored 5m series in Upstash.
//
// Env vars required:
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
// Optional:
// - DEFAULT_SYMBOLS (comma list like "BTCUSDT,ETHUSDT,LDOUSDT")
// - ALERT_COOLDOWN_MINUTES (default 20)
//
// Query params:
// - symbols=BTCUSDT,ETHUSDT   (optional; falls back to env; then fallback list)
// - driver_tf=5m|15m|30m|1h|4h (optional; default 5m)
// - debug=1 (optional; adds debug fields to response JSON ONLY)
// - force=1 (optional; bypass criteria + cooldown; sends snapshot for all symbols)
// - dry=1 (optional; NEVER sends Telegram, NEVER writes to Upstash, returns would-send payload)
//
// Criteria v1 (per symbol):
// 1) Setup flip: 15m state changed since last check
// 2) Momentum confirmation: 5m AND 15m lean match AND abs(5m price change) >= 0.10%
// 3) Positioning shock: 15m oi_change_pct >= +0.50% AND abs(15m price_change_pct) >= 0.20%
// Anti-spam: cooldown per symbol (default 20m) unless force=1

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---- Deploy stamp (to verify what's actually deployed) ----
function getDeployInfo() {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_GITHUB_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    null;

  const ref =
    process.env.VERCEL_GIT_COMMIT_REF ||
    process.env.VERCEL_GITHUB_COMMIT_REF ||
    process.env.GITHUB_REF_NAME ||
    null;

  return {
    vercel: process.env.VERCEL ? true : false,
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || null,
    sha,
    ref,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    buildId: process.env.VERCEL_BUILD_ID || null,
  };
}

// ---- Config (easy to modify later) ----
const CFG = {
  cooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 20),

  // Criteria thresholds
  momentumAbs5mPricePct: 0.1, // %
  shockOi15mPct: 0.5, // %
  shockAbs15mPricePct: 0.2, // %

  // Levels computed from stored 5m points
  levelWindows: {
    "1h": 12, // 12 * 5m
    "4h": 48, // 48 * 5m
  },

  // Redis keys
  keys: {
    last15mState: (instId) => `alert:lastState15m:${instId}`,
    lastSentAt: (instId) => `alert:lastSentAt:${instId}`, // epoch ms
    // series is written by /api/multi.js
    series5m: (instId) => `series5m:${instId}`,
  },
};

// ---- helpers ----
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

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function abs(x) {
  return x == null ? null : Math.abs(x);
}

function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x.toFixed(3)}%`;
}

function fmtPrice(x) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  if (x < 1) return x.toFixed(6);
  if (x < 100) return x.toFixed(4);
  return x.toFixed(2);
}

function safeJsonParse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
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

// Pull last N points from the stored series and compute hi/lo/mid.
// Points are objects like { b, ts, p, fr, oi } written by /api/multi.js
async function computeLevelsFromSeries(instId) {
  const seriesKey = CFG.keys.series5m(instId);
  const out = {};

  const maxNeeded = Math.max(...Object.values(CFG.levelWindows));
  const raw = await redis.lrange(seriesKey, -maxNeeded, -1);
  const points = (raw || []).map(safeJsonParse).filter(Boolean);

  function windowLevels(windowPoints) {
    const ps = windowPoints.map((pt) => asNum(pt?.p)).filter((x) => x != null);
    if (ps.length === 0) return null;
    let hi = ps[0];
    let lo = ps[0];
    for (const v of ps) {
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    const mid = (hi + lo) / 2;
    return { hi, lo, mid };
  }

  for (const [label, n] of Object.entries(CFG.levelWindows)) {
    if (points.length < n) {
      out[label] = { warmup: true, hi: null, lo: null, mid: null };
      continue;
    }
    const slice = points.slice(points.length - n);
    const lv = windowLevels(slice);
    out[label] = lv ? { warmup: false, ...lv } : { warmup: true, hi: null, lo: null, mid: null };
  }

  return out;
}

function playbookLine(bias, levels) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup || !Number.isFinite(l1h.hi) || !Number.isFinite(l1h.lo) || !Number.isFinite(l1h.mid)) {
    if (bias === "short") return "Watch: continuation lower if weakness persists; wait for 15m confirmation.";
    if (bias === "long") return "Watch: continuation higher if strength persists; wait for 15m confirmation.";
    return "Watch: wait for 15m alignment; avoid noise.";
  }

  const hi = fmtPrice(l1h.hi);
  const lo = fmtPrice(l1h.lo);
  const mid = fmtPrice(l1h.mid);

  if (bias === "short") {
    return `Watch: breakdown < 1h low (${lo}) = continuation; reclaim > 1h mid (${mid}) = fade risk. (1h hi ${hi})`;
  }
  if (bias === "long") {
    return `Watch: breakout > 1h high (${hi}) = continuation; lose < 1h mid (${mid}) = fade risk. (1h low ${lo})`;
  }
  return `Watch: range until break of 1h hi/lo (${hi}/${lo}). Mid=${mid}.`;
}

function biasFromItem(item) {
  const lean15 = item?.deltas?.["15m"]?.lean;
  const leanDriver = item?.lean;
  const lean = (lean15 || leanDriver || "neutral").toLowerCase();
  if (lean === "long") return "long";
  if (lean === "short") return "short";
  return "neutral";
}

// ---- Criteria evaluation ----
function evaluateCriteria(item, last15mState) {
  const d5 = item?.deltas?.["5m"];
  const d15 = item?.deltas?.["15m"];

  const triggers = [];

  // 1) Setup flip (15m state changed)
  const cur15mState = String(d15?.state || "unknown");
  if (last15mState && cur15mState && last15mState !== cur15mState) {
    triggers.push({ code: "setup_flip", msg: `15m state flip: ${last15mState} → ${cur15mState}` });
  }

  // 2) Momentum confirmation
  const lean5 = String(d5?.lean || "neutral");
  const lean15 = String(d15?.lean || "neutral");
  const absP5 = abs(d5?.price_change_pct);
  if (lean5 === lean15 && (absP5 ?? 0) >= CFG.momentumAbs5mPricePct) {
    triggers.push({
      code: "momentum_confirm",
      msg: `Momentum: 5m+15m both ${lean15}, |5m p|=${fmtPct(absP5)}≥${CFG.momentumAbs5mPricePct.toFixed(2)}%`,
    });
  }

  // 3) Positioning shock
  const oi15 = d15?.oi_change_pct;
  const absP15 = abs(d15?.price_change_pct);
  if ((oi15 ?? -Infinity) >= CFG.shockOi15mPct && (absP15 ?? 0) >= CFG.shockAbs15mPricePct) {
    triggers.push({
      code: "positioning_shock",
      msg: `Positioning shock: 15m OI=${fmtPct(oi15)} & |15m p|=${fmtPct(absP15)}`,
    });
  }

  return { triggers, cur15mState };
}

// ---- main handler ----
export default async function handler(req, res) {
  try {
    const debug = String(req.query.debug || "") === "1";
    const force = String(req.query.force || "") === "1";
    const dry = String(req.query.dry || "") === "1";
    const driver_tf = normalizeDriverTf(req.query.driver_tf);

    // symbols: query -> env -> fallback
    const querySymbols = normalizeSymbols(req.query.symbols);
    const envSymbols = normalizeSymbols(process.env.DEFAULT_SYMBOLS);
    const symbols =
      querySymbols.length > 0 ? querySymbols : envSymbols.length > 0 ? envSymbols : ["BTCUSDT", "ETHUSDT", "LDOUSDT"];

    // Build absolute URL to /api/multi on same host
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();

    const qs = new URLSearchParams();
    qs.set("symbols", symbols.join(","));
    qs.set("driver_tf", driver_tf);
    const multiUrl = `${proto}://${host}/api/multi?${qs.toString()}`;

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
        dry,
        ...(debug ? { deploy: getDeployInfo() } : {}),
      });
    }

    const now = Date.now();
    const cooldownMs = CFG.cooldownMinutes * 60 * 1000;

    const triggered = [];
    const skipped = [];

    // Evaluate each symbol
    for (const item of j.results || []) {
      if (!item?.ok) {
        skipped.push({ symbol: item?.symbol || "?", reason: `error: ${item?.error || "unknown"}` });
        continue;
      }

      const instId = String(item.instId || "");
      const symbol = String(item.symbol || "?");

      // In dry mode we still read state from Upstash (read-only), but we DO NOT write anything.
      const [lastState15mRaw, lastSentRaw] = await Promise.all([
        redis.get(CFG.keys.last15mState(instId)),
        redis.get(CFG.keys.lastSentAt(instId)),
      ]);

      const lastState15m = lastState15mRaw ? String(lastState15mRaw) : null;
      const lastSentAt = lastSentRaw ? Number(lastSentRaw) : null;

      const evalRes = evaluateCriteria(item, lastState15m);
      const cur15mState = evalRes.cur15mState;

      const triggers = force ? [{ code: "force", msg: "force=1" }] : evalRes.triggers;

      const inCooldown =
        !force && Number.isFinite(lastSentAt) && lastSentAt != null && now - lastSentAt < cooldownMs;

      if (triggers.length === 0) {
        skipped.push({
          symbol,
          reason: "no criteria hit",
          ...(debug ? { cur15mState, lastState15m, lastSentAt } : {}),
        });
      } else if (inCooldown) {
        skipped.push({
          symbol,
          reason: `cooldown (${Math.ceil((cooldownMs - (now - lastSentAt)) / 60000)}m remaining)`,
          triggers,
          ...(debug ? { cur15mState, lastState15m, lastSentAt } : {}),
        });
      } else {
        const levels = await computeLevelsFromSeries(instId);
        const bias = biasFromItem(item);
        const watch = playbookLine(bias, levels);

        triggered.push({
          symbol,
          instId,
          price: item.price,
          bias,
          state_driver: item.state,
          lean_driver: item.lean,
          triggers,
          levels,
          watch,
          ...(debug ? { cur15mState, lastState15m, lastSentAt } : {}),
        });

        // ✅ Writes only when NOT dry-run
        if (!dry) {
          await redis.set(CFG.keys.lastSentAt(instId), String(now));
          if (cur15mState) {
            await redis.set(CFG.keys.last15mState(instId), cur15mState);
          }
        }
      }

      // ✅ IMPORTANT: advance lastState15m even when NOT triggered (for setup-flip), but ONLY if not dry
      if (!dry && triggers.length === 0 && cur15mState) {
        await redis.set(CFG.keys.last15mState(instId), cur15mState);
      }
    }

    // Nothing triggered (and not force) => no DM
    if (!force && triggered.length === 0) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        dry,
        sent: false,
        reason: "no triggers",
        driver_tf,
        symbols,
        multiUrl,
        triggered_count: 0,
        ...(debug ? { deploy: getDeployInfo(), skipped } : {}),
      });
    }

    // Build Telegram message (or "would send" payload)
    const lines = [];
    lines.push(`⚡️ OKX perps alert (${driver_tf})${force ? " [FORCE]" : ""}${dry ? " [DRY]" : ""}`);
    lines.push(new Date(j.ts || now).toISOString());
    if (debug) {
      const d = getDeployInfo();
      lines.push(`deploy: ${d.sha || "no-sha"} ${d.env || ""} ${d.ref || ""}`.trim());
    }
    lines.push("");

    const listToSend = force
      ? await Promise.all(
          (j.results || [])
            .filter((it) => it?.ok)
            .map(async (it) => {
              const lv = await computeLevelsFromSeries(String(it.instId || ""));
              const bias = biasFromItem(it);
              const watch = playbookLine(bias, lv);
              return {
                symbol: String(it.symbol),
                price: it.price,
                bias,
                d5: it.deltas?.["5m"],
                d15: it.deltas?.["15m"],
                levels: lv,
                watch,
                triggers: [{ code: "force", msg: "force=1" }],
              };
            })
        )
      : triggered.map((t) => {
          const orig = (j.results || []).find((x) => x?.ok && x.symbol === t.symbol);
          return {
            symbol: t.symbol,
            price: t.price,
            bias: t.bias,
            d5: orig?.deltas?.["5m"],
            d15: orig?.deltas?.["15m"],
            levels: t.levels,
            watch: t.watch,
            triggers: t.triggers,
          };
        });

    for (const t of listToSend) {
      const d5 = t.d5;
      const d15 = t.d15;

      const reason = (t.triggers || []).map((x) => x.code).join(",");

      const l1h = t.levels?.["1h"];
      const l4h = t.levels?.["4h"];
      const lvlParts = [];

      if (l1h && !l1h.warmup) {
        lvlParts.push(`1h H/L=${fmtPrice(l1h.hi)}/${fmtPrice(l1h.lo)} mid=${fmtPrice(l1h.mid)}`);
      } else {
        lvlParts.push(`1h levels: warmup`);
      }

      if (l4h && !l4h.warmup) {
        lvlParts.push(`4h H/L=${fmtPrice(l4h.hi)}/${fmtPrice(l4h.lo)} mid=${fmtPrice(l4h.mid)}`);
      } else {
        lvlParts.push(`4h levels: warmup`);
      }

      lines.push(`${t.symbol} $${fmtPrice(t.price)} | bias=${t.bias} | hit=${reason}`);
      lines.push(
        `15m ${d15?.state || "?"}/${d15?.lean || "?"} p=${fmtPct(d15?.price_change_pct)} oi=${fmtPct(
          d15?.oi_change_pct
        )}`
      );
      lines.push(
        `5m  ${d5?.state || "?"}/${d5?.lean || "?"} p=${fmtPct(d5?.price_change_pct)} oi=${fmtPct(
          d5?.oi_change_pct
        )}`
      );
      lines.push(`Levels: ${lvlParts.join(" | ")}`);
      lines.push(t.watch);
      lines.push("");
    }

    lines.push(multiUrl);

    const text = lines.join("\n");

    // ✅ DRY-RUN: never send Telegram and never write (writes are already gated above)
    if (dry) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        dry: true,
        sent: false,
        would_send: true,
        driver_tf,
        force,
        symbols,
        multiUrl,
        triggered_count: triggered.length,
        preview: text,
        ...(debug ? { deploy: getDeployInfo(), triggered, skipped } : {}),
      });
    }

    // Real send
    const tg = await sendTelegram(text);
    if (!tg.ok) {
      return res.status(500).json({
        ok: false,
        error: tg.error,
        detail: tg.detail || null,
        multiUrl,
        symbols,
        driver_tf,
        dry,
        ...(debug ? { deploy: getDeployInfo() } : {}),
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      dry: false,
      sent: true,
      force,
      driver_tf,
      symbols,
      multiUrl,
      triggered_count: triggered.length,
      ...(debug ? { deploy: getDeployInfo(), triggered, skipped } : {}),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(err?.message || err),
      ...(String(req?.query?.debug || "") === "1" ? { deploy: getDeployInfo() } : {}),
    });
  }
}