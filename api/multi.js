// /api/multi.js
// OKX PERP (SWAP) ONLY — rolling 5m series + flexible timeframe deltas + lean/why
// Requires env vars:
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
// Optional:
// - DEFAULT_SYMBOLS (comma list like "BTCUSDT,ETHUSDT,LDOUSDT")

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BUCKET_MS = 5 * 60 * 1000;
const SERIES_POINTS_24H = 288; // 24h / 5m
const SERIES_TTL_SECONDS = 60 * 60 * 48; // 48h
const INST_MAP_TTL_SECONDS = 60 * 60 * 24; // 24h
const INST_LIST_TTL_SECONDS = 60 * 60 * 12; // 12h

// Allowed timeframes (derived from the 5m series)
const TF_TO_STEPS = {
  "5m": 1,
  "15m": 3,
  "30m": 6,
  "1h": 12,
  "4h": 48,
};

function pctChange(now, prev) {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return null;
  if (now == null || !Number.isFinite(now)) return null;
  return ((now - prev) / prev) * 100;
}

function safeJsonParse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function baseFromSymbolUSDT(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!s.endsWith("USDT")) return null;
  return s.slice(0, -4);
}

// Classification for a given timeframe delta
function classifyState(priceChgPct, oiChgPct) {
  if (priceChgPct == null || oiChgPct == null) return "unknown";
  const pUp = priceChgPct > 0;
  const oiUp = oiChgPct > 0;

  if (pUp && !oiUp) return "shorts closing";
  if (!pUp && !oiUp) return "longs closing";
  if (pUp && oiUp) return "longs opening";
  if (!pUp && oiUp) return "shorts opening";
  return "unknown";
}

function addLeanAndWhy(state, funding_rate) {
  if (state === "longs opening") {
    return { lean: "long", why: "Price up while positions grew (buyers adding)." };
  }
  if (state === "shorts opening") {
    return { lean: "short", why: "Price down while positions grew (sellers adding)." };
  }
  if (state === "shorts closing") {
    return { lean: "long", why: "Price up while positions shrank (shorts exiting pushed up)." };
  }
  if (state === "longs closing") {
    return { lean: "short", why: "Price down while positions shrank (longs exiting pushed down)." };
  }

  if (Number.isFinite(funding_rate)) {
    if (funding_rate > 0) return { lean: "neutral", why: "Not enough change data yet; funding slightly positive." };
    if (funding_rate < 0) return { lean: "neutral", why: "Not enough change data yet; funding slightly negative." };
  }
  return { lean: "neutral", why: "Not enough change data yet." };
}

function normalizeTf(rawTf) {
  const tf = String(rawTf || "5m").toLowerCase();
  return TF_TO_STEPS[tf] ? tf : "5m";
}

async function getOkxSwapInstrumentListCached() {
  const cacheKey = `okx:instruments:swap:list:v1`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    const list = safeJsonParse(cached);
    if (Array.isArray(list)) return list;
  }

  const url = "https://www.okx.com/api/v5/public/instruments?instType=SWAP";
  const r = await fetch(url);
  if (!r.ok) return null;

  const j = await r.json();
  const list = Array.isArray(j?.data) ? j.data : null;
  if (!Array.isArray(list)) return null;

  await redis.set(cacheKey, JSON.stringify(list));
  await redis.expire(cacheKey, INST_LIST_TTL_SECONDS);
  return list;
}

async function resolveOkxSwapInstId(symbol) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) return null;

  const mapKey = `instmap:okx:swap:${base}`;
  const cached = await redis.get(mapKey);
  if (cached) return cached === "__NONE__" ? null : cached;

  const list = await getOkxSwapInstrumentListCached();
  if (!Array.isArray(list)) {
    // If OKX list fetch fails, fall back to a guess (do NOT cache it).
    return `${base}-USDT-SWAP`;
  }

  const target = `${base}-USDT-SWAP`;
  const found = list.find((x) => String(x?.instId || "").toUpperCase() === target);

  if (found?.instId) {
    await redis.set(mapKey, String(found.instId));
    await redis.expire(mapKey, INST_MAP_TTL_SECONDS);
    return String(found.instId);
  }

  await redis.set(mapKey, "__NONE__");
  await redis.expire(mapKey, INST_MAP_TTL_SECONDS);
  return null;
}

async function fetchOkxSwap(instId) {
  const [tickerRes, fundingRes, oiRes] = await Promise.all([
    fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
    fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
    fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`),
  ]);

  if (!tickerRes.ok) return { ok: false, error: "ticker fetch failed" };
  if (!fundingRes.ok) return { ok: false, error: "funding fetch failed" };
  if (!oiRes.ok) return { ok: false, error: "oi fetch failed" };

  const tickerJson = await tickerRes.json();
  const fundingJson = await fundingRes.json();
  const oiJson = await oiRes.json();

  const price = Number(tickerJson?.data?.[0]?.last);
  const funding_rate = Number(fundingJson?.data?.[0]?.fundingRate);
  const open_interest_contracts = Number(oiJson?.data?.[0]?.oi);

  if (!Number.isFinite(price) || !Number.isFinite(open_interest_contracts)) {
    return { ok: false, error: "instrument not found or missing data" };
  }

  return {
    ok: true,
    price,
    funding_rate: Number.isFinite(funding_rate) ? funding_rate : null,
    open_interest_contracts,
  };
}

async function fetchOne(symbol, now, tf) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) {
    return { ok: false, symbol, error: "unsupported symbol format (expected like ETHUSDT)" };
  }

  const instId = await resolveOkxSwapInstId(symbol);
  if (!instId) {
    return {
      ok: false,
      symbol,
      instId: `${base}-USDT-SWAP`,
      error: "no OKX perp market (perps-only mode)",
    };
  }

  const okx = await fetchOkxSwap(instId);
  if (!okx.ok) return { ok: false, symbol, instId, error: okx.error };

  const price = okx.price;
  const funding_rate = okx.funding_rate;
  const open_interest_contracts = okx.open_interest_contracts;

  const open_interest_usd =
    Number.isFinite(open_interest_contracts) && Number.isFinite(price)
      ? open_interest_contracts * price
      : null;

  // ---- Rolling 5-minute history append ----
  const bucket = Math.floor(now / BUCKET_MS);

  const seriesKey = `series5m:${instId}`;
  const lastBucketKey = `lastBucket:${instId}`;

  const lastBucketRaw = await redis.get(lastBucketKey);
  const lastBucketNum = lastBucketRaw == null ? null : Number(lastBucketRaw);

  if (!Number.isFinite(lastBucketNum) || lastBucketNum !== bucket) {
    const point = { b: bucket, ts: now, p: price, fr: funding_rate, oi: open_interest_contracts };

    await redis.rpush(seriesKey, JSON.stringify(point));
    await redis.ltrim(seriesKey, -SERIES_POINTS_24H, -1);

    await redis.set(lastBucketKey, String(bucket));

    await redis.expire(seriesKey, SERIES_TTL_SECONDS);
    await redis.expire(lastBucketKey, SERIES_TTL_SECONDS);
  }

  // ---- Timeframe deltas from the 5m series ----
  const steps = TF_TO_STEPS[tf] || 1;
  const neededPoints = steps + 1;

  const raw = await redis.lrange(seriesKey, -neededPoints, -1);
  const points = (raw || []).map(safeJsonParse).filter(Boolean);

  const nowPoint = points.length >= 1 ? points[points.length - 1] : null;
  const prevTfPoint = points.length >= neededPoints ? points[0] : null;

  const price_change_tf_pct = pctChange(nowPoint?.p, prevTfPoint?.p);
  const oi_change_tf_pct = pctChange(nowPoint?.oi, prevTfPoint?.oi);

  const funding_change_tf =
    Number.isFinite(nowPoint?.fr) && Number.isFinite(prevTfPoint?.fr)
      ? nowPoint.fr - prevTfPoint.fr
      : null;

  const state = classifyState(price_change_tf_pct, oi_change_tf_pct);
  const { lean, why } = addLeanAndWhy(state, funding_rate);

  const warmup_tf = !(nowPoint && prevTfPoint);

  return {
    ok: true,
    symbol,
    instId,
    tf,
    price,
    funding_rate,
    open_interest_contracts,
    open_interest_usd,

    // timeframe changes
    price_change_tf_pct,
    oi_change_tf_pct,
    funding_change_tf,

    // read
    state,
    lean,
    why,

    warmup_tf,

    source: "okx_swap_public_api+upstash_series",
  };
}

export default async function handler(req, res) {
  try {
    const tf = normalizeTf(req.query.tf);

    const symbolsRaw = String(req.query.symbols || process.env.DEFAULT_SYMBOLS || "ETHUSDT,LDOUSDT");
    const symbols = symbolsRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (symbols.length === 0) {
      return res.status(400).json({ ok: false, error: "No symbols provided. Use ?symbols=ETHUSDT,LDOUSDT" });
    }
    if (symbols.length > 50) {
      return res.status(400).json({ ok: false, error: "Too many symbols (max 50)." });
    }

    const now = Date.now();
    const results = await Promise.all(symbols.map((sym) => fetchOne(sym, now, tf)));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      ts: now,
      tf,
      symbols,
      results,
      note:
        "OKX perps-only. Rolling 5m series (24h). Timeframe deltas are derived from 5m points. warmup_tf=false once enough points exist for selected tf.",
      tf_help: Object.keys(TF_TO_STEPS),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}