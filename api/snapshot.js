// /api/snapshot.js
// OKX PERP (SWAP) ONLY — strict 5m bucket snapshots + 5m deltas + state
// Requires env vars:
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BUCKET_MS = 5 * 60 * 1000; // 300,000 ms
const SNAP_TTL_SECONDS = 60 * 60 * 24; // 24h

// OKX instrument discovery cache
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

  // If list fetch fails, fall back to guess (don’t cache it)
  if (!Array.isArray(list)) {
    const guess = `${base}-USDT-SWAP`;
    reqCache.instMap.set(base, guess);
    return guess;
  }

  const target = `${base}-USDT-SWAP`.toUpperCase();

  // Build request-scope set once
  if (!reqCache.swapInstSet) {
    const set = new Set();
    for (const x of list) {
      const id = String(x?.instId || "").toUpperCase();
      if (id) set.add(id);
    }
    reqCache.swapInstSet = set;
  }

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

export default async function handler(req, res) {
  try {
    const symbol = String(req.query.symbol || "ETHUSDT").toUpperCase();
    const base = baseFromSymbolUSDT(symbol);

    if (!base) {
      return res.status(400).json({
        ok: false,
        symbol,
        error: "unsupported symbol format (expected like ETHUSDT)",
      });
    }

    const reqCache = { swapList: null, swapInstSet: null, instMap: new Map() };
    const instId = await resolveOkxSwapInstId(symbol, reqCache);

    if (!instId) {
      return res.status(404).json({
        ok: false,
        symbol,
        instId: `${base}-USDT-SWAP`,
        error: "no OKX perp market (perps-only mode)",
      });
    }

    // ---- Fetch OKX current values ----
    const okx = await fetchOkxSwap(instId);
    if (!okx.ok) {
      return res.status(502).json({ ok: false, symbol, instId, error: okx.error });
    }

    const now = Date.now();
    const price = okx.price;
    const funding_rate = okx.funding_rate;
    const open_interest_contracts = okx.open_interest_contracts;

    const open_interest_usd =
      Number.isFinite(open_interest_contracts) && Number.isFinite(price)
        ? open_interest_contracts * price
        : null;

    // ---- Strict 5-minute bucketing ----
    const bucket = Math.floor(now / BUCKET_MS);
    const keyNow = `snap5m:${instId}:${bucket}`;
    const keyPrev = `snap5m:${instId}:${bucket - 1}`;

    const snapNowRaw = await redis.get(keyNow);
    const snapPrevRaw = await redis.get(keyPrev);

    let snapNow = safeJsonParse(snapNowRaw);
    const snapPrev = safeJsonParse(snapPrevRaw);

    // Anchor the bucket once (store JSON string)
    if (!snapNow) {
      snapNow = {
        price,
        funding_rate,
        open_interest_contracts,
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
      Number.isFinite(snapNow?.funding_rate) && Number.isFinite(snapPrev?.funding_rate)
        ? snapNow.funding_rate - snapPrev.funding_rate
        : null;

    const state = classifyState(price_change_5m_pct, oi_change_5m_pct);
    const warmup_5m = !(snapNow && snapPrev);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      symbol,
      instId,
      ts: now,

      // Current values (live)
      price,
      funding_rate,
      open_interest_contracts,
      open_interest_usd,

      // Strict 5m deltas (bucket anchored)
      price_change_5m_pct,
      oi_change_5m_pct,
      funding_change_5m,
      state,
      warmup_5m,

      source: "okx_swap_public_api+upstash_state",
      note:
        "Strict 5-minute deltas compare current 5m bucket vs previous 5m bucket. warmup_5m=true until previous bucket exists.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(err?.message || err),
    });
  }
}