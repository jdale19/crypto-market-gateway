// /api/alert.js
// V1 Alerts: pulls /api/multi, evaluates trigger criteria, applies cooldown, sends Telegram DM.
// Adds "levels" (1h/4h hi/lo/mid) computed from stored 5m series in Upstash.
//
// NEW:
// - Hard warmup gate: non-force alerts require 1h levels ready
// - B1 strong recommendation gate retained

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

  momentumAbs5mPricePct: 0.1,
  shockOi15mPct: 0.5,
  shockAbs15mPricePct: 0.2,

  levelWindows: {
    "1h": 12,
    "4h": 48,
  },

  strongEdgePct1h: Number(process.env.ALERT_STRONG_EDGE_PCT_1H || 0.15),

  telegramMaxChars: 3900,

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

const asNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const abs = (x) => (x == null ? null : Math.abs(x));
const fmtPct = (x) => (x == null ? "n/a" : `${x.toFixed(3)}%`);
const fmtPrice = (x) =>
  x == null
    ? "n/a"
    : x < 1
    ? x.toFixed(6)
    : x < 100
    ? x.toFixed(4)
    : x.toFixed(2);

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
  const raw = await redis.lrange(
    CFG.keys.series5m(instId),
    -Math.max(...Object.values(CFG.levelWindows)),
    -1
  );

  const pts = (raw || []).map(safeJsonParse).filter(Boolean);
  const out = {};

  for (const [label, n] of Object.entries(CFG.levelWindows)) {
    if (pts.length < n) {
      out[label] = { warmup: true };
      continue;
    }
    const slice = pts.slice(-n).map((p) => asNum(p?.p)).filter(Boolean);
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

function biasFromItem(item) {
  const lean =
    item?.deltas?.["15m"]?.lean ||
    item?.lean ||
    "neutral";
  return lean.toLowerCase();
}

function strongRecoB1({ bias, levels, price }) {
  const l1h = levels?.["1h"];
  if (!l1h || l1h.warmup) return { strong: false, reason: "1h_warmup" };

  const hi = asNum(l1h.hi);
  const lo = asNum(l1h.lo);
  const p = asNum(price);
  if (hi == null || lo == null || p == null) return { strong: false };

  const edge = CFG.strongEdgePct1h * (hi - lo);

  if (bias === "long") return { strong: p <= lo + edge };
  if (bias === "short") return { strong: p >= hi - edge };
  return { strong: false };
}

function evaluateCriteria(item, lastState) {
  const d5 = item?.deltas?.["5m"];
  const d15 = item?.deltas?.["15m"];
  const triggers = [];
  const curState = String(d15?.state || "unknown");

  if (lastState && curState !== lastState)
    triggers.push({ code: "setup_flip" });

  if (
    d5?.lean === d15?.lean &&
    abs(d5?.price_change_pct) >= CFG.momentumAbs5mPricePct
  )
    triggers.push({ code: "momentum_confirm" });

  if (
    d15?.oi_change_pct >= CFG.shockOi15mPct &&
    abs(d15?.price_change_pct) >= CFG.shockAbs15mPricePct
  )
    triggers.push({ code: "positioning_shock" });

  return { triggers, curState };
}

export default async function handler(req, res) {
  try {
    const secret = process.env.ALERT_SECRET || "";
    const bearer = String(req.headers.authorization || "")
      .toLowerCase()
      .startsWith("bearer ")
      ? req.headers.authorization.slice(7).trim()
      : "";

    const key = req.query.key;
    if ((bearer || key) !== secret)
      return res.status(401).json({ ok: false, error: "unauthorized" });

    const force = req.query.force === "1";
    const dry = req.query.dry === "1";
    const driver_tf = normalizeDriverTf(req.query.driver_tf);

    const symbols =
      normalizeSymbols(req.query.symbols).length
        ? normalizeSymbols(req.query.symbols)
        : ["BTCUSDT"];

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto =
      (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const multiUrl = `${proto}://${host}/api/multi?symbols=${symbols.join(
      ","
    )}&driver_tf=${driver_tf}`;

    const r = await fetch(multiUrl);
    const j = await r.json();
    if (!j?.ok) return res.status(500).json({ ok: false });

    const now = Date.now();
    const cooldownMs = CFG.cooldownMinutes * 60000;
    const triggered = [];

    for (const item of j.results || []) {
      if (!item?.ok) continue;

      const instId = item.instId;
      const lastState = await redis.get(CFG.keys.last15mState(instId));
      const lastSent = Number(await redis.get(CFG.keys.lastSentAt(instId)));

      const { triggers, curState } = evaluateCriteria(item, lastState);
      if (!force && !triggers.length) continue;
      if (
        !force &&
        lastSent &&
        now - lastSent < cooldownMs
      )
        continue;

      const levels = await computeLevelsFromSeries(instId);

      // HARD WARMUP GATE
      if (!force && levels?.["1h"]?.warmup) continue;

      const bias = biasFromItem(item);
      const reco = strongRecoB1({
        bias,
        levels,
        price: item.price,
      });

      if (!force && !reco.strong) continue;

      triggered.push({
        symbol: item.symbol,
        price: item.price,
        bias,
        levels,
      });

      if (!dry) {
        await redis.set(CFG.keys.lastSentAt(instId), now);
        await redis.set(CFG.keys.last15mState(instId), curState);
      }
    }

    if (!force && !triggered.length)
      return res.json({ ok: true, sent: false });

    const lines = [];
    lines.push(
      `⚡️ OKX perps alert (${driver_tf})${
        force ? " [FORCE]" : ""
      }`
    );
    lines.push(new Date().toISOString());
    lines.push("");

    for (const t of triggered) {
      lines.push(
        `${t.symbol} $${fmtPrice(t.price)} | bias=${t.bias}`
      );
      lines.push("");
    }

    lines.push(multiUrl);

    const message = lines.join("\n");

    if (!dry) await sendTelegram(message);

    return res.json({
      ok: true,
      sent: !dry,
      triggered_count: triggered.length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}