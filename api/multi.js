import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function toOkxInstId(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!s.endsWith("USDT")) return null;
  const base = s.slice(0, -4);
  return `${base}-USDT-SWAP`;
}

function pctChange(now, prev) {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return null;
  if (now == null || !Number.isFinite(now)) return null;
  return ((now - prev) / prev) * 100;
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

async function fetchOne(symbol, now) {
  const instId = toOkxInstId(symbol);
  if (!instId) {
    return { ok: false, symbol, error: "unsupported symbol format (expected like ETHUSDT)" };
  }

  // ---- Fetch OKX current values ----
  const [tickerRes, fundingRes, oiRes] = await Promise.all([
    fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
    fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
    fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`),
  ]);

  if (!tickerRes.ok) return { ok: false, symbol, instId, error: "ticker fetch failed" };
  if (!fundingRes.ok) return { ok: false, symbol, instId, error: "funding fetch failed" };
  if (!oiRes.ok) return { ok: false, symbol, instId, error: "oi fetch failed" };

  const tickerJson = await tickerRes.json();
  const fundingJson = await fundingRes.json();
  const oiJson = await oiRes.json();

  const price = Number(tickerJson?.data?.[0]?.last);
  const funding_rate = Number(fundingJson?.data?.[0]?.fundingRate);
  const open_interest_contracts = Number(oiJson?.data?.[0]?.oi);

  const open_interest_usd =
    Number.isFinite(open_interest_contracts) && Number.isFinite(price)
      ? open_interest_contracts * price
      : null;

  // ---- Rolling 5-minute history (24h) ----
  const bucketMs = 5 * 60 * 1000;
  const bucket = Math.floor(now / bucketMs);

  const seriesKey = `series5m:${instId}`;
  const lastBucketKey = `lastBucket:${instId}`;

  const lastBucket = await redis.get(lastBucketKey);

  // Append only once per bucket
  if (lastBucket !== bucket) {
  const point = {
    b: bucket,
    ts: now,
    p: price,
    fr: funding_rate,
    oi: open_interest_contracts,
  };

  try {
    await redis.rpush(seriesKey, JSON.stringify(point));
    await redis.ltrim(seriesKey, -288, -1);
    await redis.set(lastBucketKey, bucket);
    await redis.expire(seriesKey, 60 * 60 * 48);
    await redis.expire(lastBucketKey, 60 * 60 * 48);
  } catch (e) {
    console.error("Redis write failed:", e?.message || e);
  }
}

  // Compute deltas from last two stored buckets
  const lastTwo = await redis.lrange(seriesKey, -2, -1);
  const prevPoint = lastTwo?.[0] || null;
  const nowPoint = lastTwo?.[1] || null;

  const price_change_5m_pct = pctChange(nowPoint?.p, prevPoint?.p);
  const oi_change_5m_pct = pctChange(nowPoint?.oi, prevPoint?.oi);
  const funding_change_5m =
    Number.isFinite(nowPoint?.fr) && Number.isFinite(prevPoint?.fr)
      ? nowPoint.fr - prevPoint.fr
      : null;

  const state = classifyState(price_change_5m_pct, oi_change_5m_pct);
  const warmup = !(prevPoint && nowPoint);

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
    state,
    warmup,
    source: "okx_swap_public_api+upstash_series",
  };
}

export default async function handler(req, res) {
  try {
    const symbolsRaw = String(
      req.query.symbols ||
      process.env.DEFAULT_SYMBOLS ||
      "ETHUSDT,LDOUSDT"
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

    const now = Date.now();
    const results = await Promise.all(
      symbols.map((sym) => fetchOne(sym, now))
    );

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      ok: true,
      ts: now,
      symbols,
      results,
      note: "Rolling 5-minute series (24h). warmup=true until 2 buckets exist.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(err?.message || err),
    });
  }
}