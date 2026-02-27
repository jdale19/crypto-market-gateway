// /api/snapshot.js
// OKX PERP (SWAP) ONLY — strict 5m bucket snapshots + 5m deltas + state
// Supports batch mode: ?symbols=BTCUSDT,ETHUSDT,...

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BUCKET_MS = 5 * 60 * 1000;
const SNAP_TTL_SECONDS = 60 * 60 * 24;
const INST_MAP_TTL_SECONDS = 60 * 60 * 24;
const INST_LIST_TTL_SECONDS = 60 * 60 * 12;
const FETCH_TIMEOUT_MS = 8000;

function pctChange(now, prev) {
  if (!Number.isFinite(prev) || prev === 0) return null;
  if (!Number.isFinite(now)) return null;
  return ((now - prev) / prev) * 100;
}

function safeJsonParse(v) {
  try { return JSON.parse(v); } catch { return null; }
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

function normalizeSymbolsQuery(req) {
  const raw =
    (req?.query?.symbols != null ? String(req.query.symbols) : "") ||
    (req?.query?.symbol != null ? String(req.query.symbol) : "") ||
    "ETHUSDT";

  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
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

async function getOkxSwapInstrumentListCached(reqCache) {
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

  const r = await fetchWithTimeout(
    "https://www.okx.com/api/v5/public/instruments?instType=SWAP"
  );
  if (!r.ok) return null;

  const j = await r.json();
  const list = Array.isArray(j?.data) ? j.data : null;
  if (!Array.isArray(list)) return null;

  await redis.set(cacheKey, JSON.stringify(list));
  await redis.expire(cacheKey, INST_LIST_TTL_SECONDS);

  reqCache.swapList = list;
  return list;
}

async function resolveOkxSwapInstId(symbol, reqCache) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) return null;

  if (reqCache.instMap.has(base)) return reqCache.instMap.get(base);

  const mapKey = `instmap:okx:swap:${base}`;
  const cached = await redis.get(mapKey);
  if (cached) {
    const v = cached === "__NONE__" ? null : String(cached);
    reqCache.instMap.set(base, v);
    return v;
  }

  const list = await getOkxSwapInstrumentListCached(reqCache);
  if (!Array.isArray(list)) {
    const guess = `${base}-USDT-SWAP`;
    reqCache.instMap.set(base, guess);
    return guess;
  }

  const target = `${base}-USDT-SWAP`.toUpperCase();
  const exists = list.some((x) => String(x?.instId).toUpperCase() === target);

  if (exists) {
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
    fetchWithTimeout(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`),
    fetchWithTimeout(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
    fetchWithTimeout(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
  ]);

  if (!tickerRes.ok || !fundingRes.ok || !oiRes.ok)
    return { ok: false, error: "okx fetch failed" };

  const ticker = await tickerRes.json();
  const funding = await fundingRes.json();
  const oi = await oiRes.json();

  const price = Number(ticker?.data?.[0]?.last);
  const funding_rate = Number(funding?.data?.[0]?.fundingRate);
  const open_interest_contracts = Number(oi?.data?.[0]?.oi);

  if (!Number.isFinite(price) || !Number.isFinite(open_interest_contracts))
    return { ok: false, error: "instrument missing data" };

  return { ok: true, price, funding_rate, open_interest_contracts };
}

async function processOne(symbol, reqCache) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) return { ok: false, symbol, error: "bad symbol format" };

  const instId = await resolveOkxSwapInstId(symbol, reqCache);
  if (!instId) return { ok: false, symbol, error: "no perp market" };

  const okx = await fetchOkxSwap(instId);
  if (!okx.ok) return { ok: false, symbol, error: okx.error };

  const now = Date.now();
  const bucket = Math.floor(now / BUCKET_MS);

  const keyNow = `snap5m:${instId}:${bucket}`;
  const keyPrev = `snap5m:${instId}:${bucket - 1}`;

  const snapNowRaw = await redis.get(keyNow);
  const snapPrevRaw = await redis.get(keyPrev);

  let snapNow = safeJsonParse(snapNowRaw);
  const snapPrev = safeJsonParse(snapPrevRaw);

  if (!snapNow) {
    snapNow = {
      price: okx.price,
      funding_rate: okx.funding_rate,
      open_interest_contracts: okx.open_interest_contracts,
      ts: now,
    };
    await redis.set(keyNow, JSON.stringify(snapNow));
    await redis.expire(keyNow, SNAP_TTL_SECONDS);
  }

  const price_change_5m_pct = pctChange(snapNow?.price, snapPrev?.price);
  const oi_change_5m_pct = pctChange(
    snapNow?.open_interest_contracts,
    snapPrev?.open_interest_contracts
  );

  const funding_change_5m =
    Number.isFinite(snapNow?.funding_rate) &&
    Number.isFinite(snapPrev?.funding_rate)
      ? snapNow.funding_rate - snapPrev.funding_rate
      : null;

  return {
    ok: true,
    symbol,
    instId,
    ts: now,
    price: okx.price,
    funding_rate: okx.funding_rate,
    open_interest_contracts: okx.open_interest_contracts,
    open_interest_usd: okx.open_interest_contracts * okx.price,
    price_change_5m_pct,
    oi_change_5m_pct,
    funding_change_5m,
    state: classifyState(price_change_5m_pct, oi_change_5m_pct),
    warmup_5m: !(snapNow && snapPrev),
    source: "okx_swap_public_api+upstash_state",
  };
}

export default async function handler(req, res) {
  try {
    const symbols = normalizeSymbolsQuery(req);
    const reqCache = { swapList: null, instMap: new Map() };

    const results = await Promise.all(
      symbols.map((s) => processOne(s, reqCache))
    );

    res.setHeader("Cache-Control", "no-store");

    if (results.length === 1) {
      return res.status(results[0].ok ? 200 : 502).json(results[0]);
    }

    return res.status(200).json({
      ok: true,
      ts: Date.now(),
      symbols,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
}