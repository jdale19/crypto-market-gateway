import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BUCKET_MS = 5 * 60 * 1000;
const SERIES_POINTS_24H = 288; // 24h / 5m
const SERIES_TTL_SECONDS = 60 * 60 * 48; // 48h

// OKX instrument discovery cache
const INST_MAP_TTL_SECONDS = 60 * 60 * 24; // 24h
const INST_LIST_TTL_SECONDS = 60 * 60 * 12; // 12h (list is big; cache it)

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

function baseFromSymbolUSDT(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!s.endsWith("USDT")) return null;
  return s.slice(0, -4);
}

// Fetch and cache OKX SWAP instruments list (so we don't hammer OKX)
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

// Resolve the real OKX SWAP instId for a symbol like FETUSDT,
// instead of guessing `${base}-USDT-SWAP`.
async function resolveOkxSwapInstId(symbol) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) return null;

  const mapKey = `instmap:okx:swap:${base}`;
  const cached = await redis.get(mapKey);

  // cache may be actual instId string or "__NONE__"
  if (cached) return cached === "__NONE__" ? null : cached;

  const list = await getOkxSwapInstrumentListCached();

  // If list fetch fails, fall back to old guess (don’t poison cache)
  if (!Array.isArray(list)) {
    return `${base}-USDT-SWAP`;
  }

  const target = `${base}-USDT-SWAP`;
  const found = list.find((x) => String(x?.instId || "").toUpperCase() === target);

  if (found?.instId) {
    await redis.set(mapKey, String(found.instId));
    await redis.expire(mapKey, INST_MAP_TTL_SECONDS);
    return String(found.instId);
  }

  // Not found: cache that fact so we don't refetch repeatedly
  await redis.set(mapKey, "__NONE__");
  await redis.expire(mapKey, INST_MAP_TTL_SECONDS);
  return null;
}

async function fetchOkxSwap(instId) {
  const [tickerRes, fundingRes, oiRes] = await Promise.all([
    fetch(
      `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`
    ),
    fetch(
      `https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`
    ),
    fetch(
      `https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(
        instId
      )}`
    ),
  ]);

  if (!tickerRes.ok) return { ok: false, error: "swap ticker fetch failed" };
  if (!fundingRes.ok) return { ok: false, error: "swap funding fetch failed" };
  if (!oiRes.ok) return { ok: false, error: "swap oi fetch failed" };

  const tickerJson = await tickerRes.json();
  const fundingJson = await fundingRes.json();
  const oiJson = await oiRes.json();

  const price = Number(tickerJson?.data?.[0]?.last);
  const funding_rate = Number(fundingJson?.data?.[0]?.fundingRate);
  const open_interest_contracts = Number(oiJson?.data?.[0]?.oi);

  if (!Number.isFinite(price) || !Number.isFinite(open_interest_contracts)) {
    return { ok: false, error: "swap instrument not found or missing data" };
  }

  return {
    ok: true,
    market_type: "swap",
    instId,
    price,
    funding_rate: Number.isFinite(funding_rate) ? funding_rate : null,
    open_interest_contracts,
  };
}

async function fetchOkxSpot(base) {
  // OKX spot uses BASE-USDT
  const spotInstId = `${base}-USDT`;

  const r = await fetch(
    `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(spotInstId)}`
  );
  if (!r.ok) return { ok: false, error: "spot ticker fetch failed" };

  const j = await r.json();
  const price = Number(j?.data?.[0]?.last);

  if (!Number.isFinite(price)) {
    return { ok: false, error: "spot instrument not found or missing data" };
  }

  return {
    ok: true,
    market_type: "spot",
    instId: spotInstId,
    price,
    funding_rate: null,
    open_interest_contracts: null,
  };
}

async function writeAndReadSeries({ seriesKey, lastBucketKey, bucket, now, point }) {
  const lastBucketRaw = await redis.get(lastBucketKey);
  const lastBucketNum = lastBucketRaw == null ? null : Number(lastBucketRaw);

  // Append exactly once per new bucket
  if (!Number.isFinite(lastBucketNum) || lastBucketNum !== bucket) {
    await redis.rpush(seriesKey, JSON.stringify(point));
    await redis.ltrim(seriesKey, -SERIES_POINTS_24H, -1);

    await redis.set(lastBucketKey, String(bucket));

    await redis.expire(seriesKey, SERIES_TTL_SECONDS);
    await redis.expire(lastBucketKey, SERIES_TTL_SECONDS);
  }

  // Pull last 13 points so we can do 5m and ~1h deltas
  const raw = await redis.lrange(seriesKey, -13, -1);
  const points = (raw || []).map(safeJsonParse).filter(Boolean);

  const nowPoint = points.length >= 1 ? points[points.length - 1] : null;
  const prevPoint5m = points.length >= 2 ? points[points.length - 2] : null;
  const prevPoint1h = points.length >= 13 ? points[0] : null;

  return { points, nowPoint, prevPoint5m, prevPoint1h };
}

async function fetchOne(symbol, now) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) {
    return {
      ok: false,
      symbol,
      error: "unsupported symbol format (expected like ETHUSDT)",
    };
  }

  // 1) Try SWAP (perps) first
  const swapInstId = await resolveOkxSwapInstId(symbol);
  let market;
  let source;

  if (swapInstId) {
    const swap = await fetchOkxSwap(swapInstId);
    if (swap.ok) {
      market = swap;
      source = "okx_swap_public_api+upstash_series";
    } else {
      // If SWAP lookup gave us an instId but it fails, fall back to spot.
      const spot = await fetchOkxSpot(base);
      if (!spot.ok) {
        return { ok: false, symbol, instId: swapInstId, error: swap.error };
      }
      market = spot;
      source = "okx_spot_public_api+upstash_series";
    }
  } else {
    // 2) No SWAP market found -> spot fallback
    const spot = await fetchOkxSpot(base);
    if (!spot.ok) {
      return {
        ok: false,
        symbol,
        instId: `${base}-USDT-SWAP`,
        error: "no OKX USDT swap market found; spot also unavailable",
        detail: spot.error,
      };
    }
    market = spot;
    source = "okx_spot_public_api+upstash_series";
  }

  const instId = market.instId;
  const price = market.price;
  const funding_rate = market.funding_rate;
  const open_interest_contracts = market.open_interest_contracts;

  const open_interest_usd =
    Number.isFinite(open_interest_contracts) && Number.isFinite(price)
      ? open_interest_contracts * price
      : null;

  const bucket = Math.floor(now / BUCKET_MS);

  // Keep series keys unique across market types so spot & swap don't collide
  const instKey = `${market.market_type}:${instId}`;
  const seriesKey = `series5m:${instKey}`;
  const lastBucketKey = `lastBucket:${instKey}`;

  const point = {
    b: bucket,
    ts: now,
    p: price,
    fr: funding_rate,
    oi: open_interest_contracts,
  };

  const { nowPoint, prevPoint5m, prevPoint1h } = await writeAndReadSeries({
    seriesKey,
    lastBucketKey,
    bucket,
    now,
    point,
  });

  const price_change_5m_pct = pctChange(nowPoint?.p, prevPoint5m?.p);
  const oi_change_5m_pct = pctChange(nowPoint?.oi, prevPoint5m?.oi);

  const funding_change_5m =
    Number.isFinite(nowPoint?.fr) && Number.isFinite(prevPoint5m?.fr)
      ? nowPoint.fr - prevPoint5m.fr
      : null;

  const oi_change_1h_pct = pctChange(nowPoint?.oi, prevPoint1h?.oi);

  const state = classifyState(price_change_5m_pct, oi_change_5m_pct);

  const warmup_5m = !(nowPoint && prevPoint5m);
  const warmup_1h = !(nowPoint && prevPoint1h);

  return {
    ok: true,
    symbol,
    instId,
    market_type: market.market_type,

    price,
    funding_rate,
    open_interest_contracts,
    open_interest_usd,

    price_change_5m_pct,
    oi_change_5m_pct,
    funding_change_5m,
    oi_change_1h_pct,

    // state only really makes sense when oi exists; spot will usually be "unknown"
    state,
    warmup_5m,
    warmup_1h,

    source,
    note:
      market.market_type === "spot"
        ? "No OKX perp swap market for this symbol; returning spot price (no funding/OI)."
        : undefined,
  };
}

export default async function handler(req, res) {
  try {
    const symbolsRaw = String(
      req.query.symbols || process.env.DEFAULT_SYMBOLS || "ETHUSDT,LDOUSDT"
    );

    const symbols = symbolsRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (symbols.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No symbols provided. Use ?symbols=ETHUSDT,LDOUSDT",
      });
    }

    if (symbols.length > 50) {
      return res.status(400).json({
        ok: false,
        error: "Too many symbols (max 50).",
      });
    }

    const now = Date.now();
    const results = await Promise.all(symbols.map((sym) => fetchOne(sym, now)));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      ts: now,
      symbols,
      results,
      note:
        "Rolling 5-minute series (24h). warmup_5m=false after 2 points. warmup_1h=false after 13 points (~65m window). OKX SWAP instId is discovered/cached (24h) instead of guessed. Spot fallback enabled when SWAP not available.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(err?.message || err),
    });
  }
}