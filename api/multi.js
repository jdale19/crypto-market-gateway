// /api/multi.js
// OKX PERP (SWAP) ONLY — rolling 5m series + 5m/1h deltas + simple lean/why
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

const FETCH_TIMEOUT_MS = 8000;

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

// Using 5m as default for the "lean" because you wanted scalp + positioning.
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

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---- OKX instruments list (Redis cached) ----
async function getOkxSwapInstrumentListCached(reqCache) {
  // request-scope memory cache first
  if (reqCache.swapList) return reqCache.swapList;

  const cacheKey = `okx:instruments:swap:list:v1`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    const list = safeJsonParse(cached);
    if (Array.isArray(list)) {
      reqCache.swapList = list;
      return list;
    }
  }

  const url = "https://www.okx.com/api/v5/public/instruments?instType=SWAP";
  const r = await fetchWithTimeout(url);
  if (!r.ok) return null;

  const j = await r.json();
  const list = Array.isArray(j?.data) ? j.data : null;
  if (!Array.isArray(list)) return null;

  await redis.set(cacheKey, JSON.stringify(list));
  await redis.expire(cacheKey, INST_LIST_TTL_SECONDS);

  reqCache.swapList = list;
  return list;
}

// Resolve real OKX SWAP instId (perps-only mode)
async function resolveOkxSwapInstId(symbol, reqCache) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) return null;

  // request-scope memory cache
  if (reqCache.instMap.has(base)) return reqCache.instMap.get(base);

  const mapKey = `instmap:okx:swap:${base}`;
  const cached = await redis.get(mapKey);
  if (cached) {
    const v = cached === "__NONE__" ? null : String(cached);
    reqCache.instMap.set(base, v);
    return v;
  }

  const list = await getOkxSwapInstrumentListCached(reqCache);

  // If list fetch fails, fall back to guess (do NOT cache it)
  if (!Array.isArray(list)) {
    const guess = `${base}-USDT-SWAP`;
    reqCache.instMap.set(base, guess);
    return guess;
  }

  // Build request-scope lookup map once
  if (!reqCache.swapInstSet) {
    const set = new Set();
    for (const x of list) {
      const id = String(x?.instId || "").toUpperCase();
      if (id) set.add(id);
    }
    reqCache.swapInstSet = set;
  }

  const target = `${base}-USDT-SWAP`.toUpperCase();

  if (reqCache.swapInstSet.has(target)) {
    await redis.set(mapKey, target);
    await redis.expire(mapKey, INST_MAP_TTL_SECONDS);
    reqCache.instMap.set(base, target);
    return target;
  }

  await redis.set(mapKey, "__NONE__");
  await redis.expire(mapKey, INST_MAP_TTL_SECONDS);
  reqCache.instMap.set(base, null);
  return null;
}

async function fetchOkxSwap(instId) {
  const [tickerRes, fundingRes, oiRes] = await Promise.all([
    fetchWithTimeout(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
    fetchWithTimeout(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
    fetchWithTimeout(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`),
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

async function fetchOne(symbol, now, reqCache) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) {
    return { ok: false, symbol, error: "unsupported symbol format (expected like ETHUSDT)" };
  }

  const instId = await resolveOkxSwapInstId(symbol, reqCache);
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

  const raw = await redis.lrange(seriesKey, -13, -1);
  const points = (raw || []).map(safeJsonParse).filter(Boolean);

  const nowPoint = points.length >= 1 ? points[points.length - 1] : null;
  const prevPoint5m = points.length >= 2 ? points[points.length - 2] : null;
  const prevPoint1h = points.length >= 13 ? points[0] : null;

  const price_change_5m_pct = pctChange(nowPoint?.p, prevPoint5m?.p);
  const oi_change_5m_pct = pctChange(nowPoint?.oi, prevPoint5m?.oi);

  const funding_change_5m =
    Number.isFinite(nowPoint?.fr) && Number.isFinite(prevPoint5m?.fr)
      ? nowPoint.fr - prevPoint5m.fr
      : null;

  const oi_change_1h_pct = pctChange(nowPoint?.oi, prevPoint1h?.oi);

  const state = classifyState(price_change_5m_pct, oi_change_5m_pct);
  const { lean, why } = addLeanAndWhy(state, funding_rate);

  const warmup_5m = !(nowPoint && prevPoint5m);
  const warmup_1h = !(nowPoint && prevPoint1h);

  return {
    ok: true,
    symbol,
    instId,
    price,
    funding_rate,
    open_interest_contracts,
    open_interest_usd,

    price_change_5m_pct,
    oi_change_5m_pct,
    funding_change_5m,
    oi_change_1h_pct,

    state,
    lean,
    why,

    warmup_5m,
    warmup_1h,

    source: "okx_swap_public_api+upstash_series",
  };
}

export default async function handler(req, res) {
  try {
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

    // request-scope caches (no Redis writes; just faster execution)
    const reqCache = {
      swapList: null,
      swapInstSet: null,
      instMap: new Map(), // base -> instId|null
    };

    const now = Date.now();
    const results = await Promise.all(symbols.map((sym) => fetchOne(sym, now, reqCache)));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      ts: now,
      symbols,
      results,
      note:
        "OKX perps-only. Rolling 5m series (24h). warmup_5m=false after 2 points; warmup_1h=false after 13 points (~65m).",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}