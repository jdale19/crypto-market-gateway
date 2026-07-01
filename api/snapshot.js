// /api/snapshot.js
// OKX PERP (SWAP) ONLY —  strict 5m bucket snapshots + 5m deltas + state
// Supports batch mode: ?symbols=BTCUSDT,ETHUSDT,...

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BUCKET_MS = 5 * 60 * 1000;
const SNAP_TTL_SECONDS = 60 * 60 * 72;
const INST_MAP_TTL_SECONDS = 60 * 60 * 24;
const INST_LIST_TTL_SECONDS = 60 * 60 * 12;
const FETCH_TIMEOUT_MS = 8000;

function pctChange(now, prev) {
  if (!Number.isFinite(prev) || prev === 0) return null;
  if (!Number.isFinite(now)) return null;
  return ((now - prev) / prev) * 100;
}

function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
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
  process.env.DEFAULT_SYMBOLS ||
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

function numOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safePctChange(now, prev) {
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return null;
  return ((now - prev) / prev) * 100;
}

function spotInstIdFromSymbol(symbol) {
  const base = baseFromSymbolUSDT(symbol);
  return base ? `${base}-USDT` : null;
}

function candleClose(row) {
  const n = Number(row?.[4]);
  return Number.isFinite(n) ? n : null;
}

function pctFromCandles(candles, stepsBack) {
  const rows = Array.isArray(candles) ? candles : [];
  const now = candleClose(rows[0]);
  const prev = candleClose(rows[stepsBack]);
  return safePctChange(now, prev);
}

function computeSpotPerpDivergence({ swapCandles, spotCandles }) {
  const swap15 = pctFromCandles(swapCandles, 3);
  const spot15 = pctFromCandles(spotCandles, 3);
  const swap1h = pctFromCandles(swapCandles, 12);
  const spot1h = pctFromCandles(spotCandles, 12);
  return {
    spot_return_15m_pct: spot15,
    perp_return_15m_pct: swap15,
    spot_vs_perp_15m_pct: Number.isFinite(spot15) && Number.isFinite(swap15) ? spot15 - swap15 : null,
    spot_return_1h_pct: spot1h,
    perp_return_1h_pct: swap1h,
    spot_vs_perp_1h_pct: Number.isFinite(spot1h) && Number.isFinite(swap1h) ? spot1h - swap1h : null,
  };
}

function computeBookMetrics(bookJson, price, ctVal = 1, ctValCcy = "") {
  const data = bookJson?.data?.[0] || {};
  const bids = Array.isArray(data?.bids) ? data.bids : [];
  const asks = Array.isArray(data?.asks) ? data.asks : [];
  const bestBid = numOrNull(bids?.[0]?.[0]);
  const bestAsk = numOrNull(asks?.[0]?.[0]);
  const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : price;
  const spreadBps = Number.isFinite(bestBid) && Number.isFinite(bestAsk) && mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : null;

  const ctv = Number.isFinite(Number(ctVal)) && Number(ctVal) > 0 ? Number(ctVal) : 1;
  const ccy = String(ctValCcy || "").toUpperCase();
  const toUsd = (px, sz) => {
    const p = numOrNull(px);
    const q = numOrNull(sz);
    if (!Number.isFinite(p) || !Number.isFinite(q)) return 0;
    return ccy === "USDT" || ccy === "USD" ? q * ctv : q * ctv * p;
  };

  const bidDepth = bids.reduce((sum, row) => sum + toUsd(row?.[0], row?.[1]), 0);
  const askDepth = asks.reduce((sum, row) => sum + toUsd(row?.[0], row?.[1]), 0);
  const denom = bidDepth + askDepth;
  const imbalance = denom > 0 ? (bidDepth - askDepth) / denom : null;

  return {
    spread_bps: Number.isFinite(spreadBps) ? spreadBps : null,
    book_bid_depth_20_usd: Number.isFinite(bidDepth) ? bidDepth : null,
    book_ask_depth_20_usd: Number.isFinite(askDepth) ? askDepth : null,
    book_imbalance_20: Number.isFinite(imbalance) ? imbalance : null,
    thin_book_flag: Number.isFinite(spreadBps) ? spreadBps > Number(process.env.SNAPSHOT_THIN_BOOK_SPREAD_BPS || 8) : null,
  };
}

function marketStructureStatus({ spotEnabled, bookEnabled, spotInstId, spotCandles, book, divergence, bookMetrics }) {
  const spotOk = !spotEnabled || !spotInstId || (
    Number.isFinite(divergence?.spot_vs_perp_15m_pct) || Number.isFinite(divergence?.spot_vs_perp_1h_pct)
  );
  const bookOk = !bookEnabled || (
    Number.isFinite(bookMetrics?.spread_bps) &&
    Number.isFinite(bookMetrics?.book_bid_depth_20_usd) &&
    Number.isFinite(bookMetrics?.book_ask_depth_20_usd)
  );

  const reasons = [];
  if (spotEnabled && spotInstId && !spotCandles) reasons.push("spot_fetch_failed");
  if (spotEnabled && spotInstId && spotCandles && !spotOk) reasons.push("spot_candles_insufficient");
  if (bookEnabled && !book) reasons.push("book_fetch_failed");
  if (bookEnabled && book && !bookOk) reasons.push("book_invalid_or_empty");

  return {
    market_structure_ok: spotOk && bookOk,
    market_structure_reason: reasons.length ? reasons.join(",") : "ok",
  };
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

async function resolveOkxSwapMeta(symbol, reqCache) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) return null;
  if (reqCache.metaMap?.has(base)) return reqCache.metaMap.get(base);

  const list = await getOkxSwapInstrumentListCached(reqCache);
  const target = `${base}-USDT-SWAP`.toUpperCase();
  const row = Array.isArray(list) ? list.find((x) => String(x?.instId || "").toUpperCase() === target) : null;
  const meta = row ? { ctVal: numOrNull(row?.ctVal), ctValCcy: String(row?.ctValCcy || "") } : { ctVal: 1, ctValCcy: "" };
  if (!reqCache.metaMap) reqCache.metaMap = new Map();
  reqCache.metaMap.set(base, meta);
  return meta;
}

async function fetchOkxSwap(instId, symbol, swapMeta = null) {
  const spotEnabled = String(process.env.SNAPSHOT_SPOT_DIVERGENCE_ENABLED || "1") !== "0";
  const bookEnabled = String(process.env.SNAPSHOT_ORDER_BOOK_ENABLED || "1") !== "0";
  const spotInstId = spotInstIdFromSymbol(symbol);
  const bookDepth = Math.max(1, Math.min(100, Number(process.env.SNAPSHOT_ORDER_BOOK_DEPTH || 20)));

  const requests = [
    fetchWithTimeout(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`),
    fetchWithTimeout(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
    fetchWithTimeout(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
    fetchWithTimeout(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=5m&limit=13`),
  ];

  if (spotEnabled && spotInstId) {
    requests.push(fetchWithTimeout(`https://www.okx.com/api/v5/market/candles?instId=${spotInstId}&bar=5m&limit=13`));
  } else {
    requests.push(Promise.resolve(null));
  }

  if (bookEnabled) {
    requests.push(fetchWithTimeout(`https://www.okx.com/api/v5/market/books?instId=${instId}&sz=${bookDepth}`));
  } else {
    requests.push(Promise.resolve(null));
  }

  const [tickerRes, fundingRes, oiRes, candlesRes, spotCandlesRes, bookRes] = await Promise.all(requests);

  if (!tickerRes.ok || !fundingRes.ok || !oiRes.ok || !candlesRes.ok) {
    return { ok: false, error: "okx fetch failed" };
  }

  const ticker = await tickerRes.json();
  const funding = await fundingRes.json();
  const oi = await oiRes.json();
  const candles = await candlesRes.json();
  const spotCandles = spotCandlesRes?.ok ? await spotCandlesRes.json().catch(() => null) : null;
  const book = bookRes?.ok ? await bookRes.json().catch(() => null) : null;

  const swapRows = Array.isArray(candles?.data) ? candles.data : [];
  const c = swapRows?.[0] || null;

  const price = Number(ticker?.data?.[0]?.last);
  const funding_rate = Number(funding?.data?.[0]?.fundingRate);
  const open_interest_contracts = Number(oi?.data?.[0]?.oi);
  const open = Number(c?.[1]);
  const high = Number(c?.[2]);
  const low = Number(c?.[3]);

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(open_interest_contracts) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low)
  ) {
    return { ok: false, error: "instrument missing data" };
  }

  const spotRows = Array.isArray(spotCandles?.data) ? spotCandles.data : [];
  const divergence = computeSpotPerpDivergence({
    swapCandles: swapRows,
    spotCandles: spotRows,
  });
  const bookMetrics = book ? computeBookMetrics(book, price, swapMeta?.ctVal ?? 1, swapMeta?.ctValCcy || "") : {};
  const structureStatus = marketStructureStatus({
    spotEnabled,
    bookEnabled,
    spotInstId,
    spotCandles,
    book,
    divergence,
    bookMetrics,
  });

  return {
    ok: true,
    price,
    open,
    high,
    low,
    funding_rate,
    open_interest_contracts,
    spot_inst_id: spotInstId || "",
    ...divergence,
    ...bookMetrics,
    ...structureStatus,
  };
}


async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await fn(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return out;
}

async function processOne(symbol, reqCache) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) return { ok: false, symbol, error: "bad symbol format" };

  const instId = await resolveOkxSwapInstId(symbol, reqCache);
  if (!instId) return { ok: false, symbol, error: "no perp market" };

  const swapMeta = await resolveOkxSwapMeta(symbol, reqCache);
  const okx = await fetchOkxSwap(instId, symbol, swapMeta);
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
      inst_id: instId,
      price: okx.price,
      open: okx.open,
      high: okx.high,
      low: okx.low,
      funding_rate: okx.funding_rate,
      open_interest_contracts: okx.open_interest_contracts,
      spot_inst_id: okx.spot_inst_id || "",
      spot_return_15m_pct: okx.spot_return_15m_pct,
      perp_return_15m_pct: okx.perp_return_15m_pct,
      spot_vs_perp_15m_pct: okx.spot_vs_perp_15m_pct,
      spot_return_1h_pct: okx.spot_return_1h_pct,
      perp_return_1h_pct: okx.perp_return_1h_pct,
      spot_vs_perp_1h_pct: okx.spot_vs_perp_1h_pct,
      spread_bps: okx.spread_bps,
      book_bid_depth_20_usd: okx.book_bid_depth_20_usd,
      book_ask_depth_20_usd: okx.book_ask_depth_20_usd,
      book_imbalance_20: okx.book_imbalance_20,
      thin_book_flag: okx.thin_book_flag,
      market_structure_ok: okx.market_structure_ok,
      market_structure_reason: okx.market_structure_reason,
      ts: now,
    };
    await redis.set(keyNow, JSON.stringify(snapNow));
    await redis.expire(keyNow, SNAP_TTL_SECONDS);
  } else {
    snapNow = {
      ...snapNow,
      inst_id: instId,
      open: Number.isFinite(Number(snapNow?.open)) ? snapNow.open : okx.open,
      high: Number.isFinite(Number(snapNow?.high)) ? snapNow.high : okx.high,
      low: Number.isFinite(Number(snapNow?.low)) ? snapNow.low : okx.low,
      spot_inst_id: okx.spot_inst_id || snapNow?.spot_inst_id || "",
      spot_return_15m_pct: okx.spot_return_15m_pct,
      perp_return_15m_pct: okx.perp_return_15m_pct,
      spot_vs_perp_15m_pct: okx.spot_vs_perp_15m_pct,
      spot_return_1h_pct: okx.spot_return_1h_pct,
      perp_return_1h_pct: okx.perp_return_1h_pct,
      spot_vs_perp_1h_pct: okx.spot_vs_perp_1h_pct,
      spread_bps: okx.spread_bps,
      book_bid_depth_20_usd: okx.book_bid_depth_20_usd,
      book_ask_depth_20_usd: okx.book_ask_depth_20_usd,
      book_imbalance_20: okx.book_imbalance_20,
      thin_book_flag: okx.thin_book_flag,
      market_structure_ok: okx.market_structure_ok,
      market_structure_reason: okx.market_structure_reason,
      ts: snapNow?.ts ?? now,
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
    open: okx.open,
    funding_rate: okx.funding_rate,
    open_interest_contracts: okx.open_interest_contracts,
    open_interest_usd: okx.open_interest_contracts * okx.price,
    price_change_5m_pct,
    oi_change_5m_pct,
    funding_change_5m,
    spot_inst_id: snapNow?.spot_inst_id || "",
    spot_return_15m_pct: snapNow?.spot_return_15m_pct ?? null,
    perp_return_15m_pct: snapNow?.perp_return_15m_pct ?? null,
    spot_vs_perp_15m_pct: snapNow?.spot_vs_perp_15m_pct ?? null,
    spot_return_1h_pct: snapNow?.spot_return_1h_pct ?? null,
    perp_return_1h_pct: snapNow?.perp_return_1h_pct ?? null,
    spot_vs_perp_1h_pct: snapNow?.spot_vs_perp_1h_pct ?? null,
    spread_bps: snapNow?.spread_bps ?? null,
    book_bid_depth_20_usd: snapNow?.book_bid_depth_20_usd ?? null,
    book_ask_depth_20_usd: snapNow?.book_ask_depth_20_usd ?? null,
    book_imbalance_20: snapNow?.book_imbalance_20 ?? null,
    thin_book_flag: snapNow?.thin_book_flag ?? null,
    market_structure_ok: snapNow?.market_structure_ok ?? false,
    market_structure_reason: snapNow?.market_structure_reason || "missing_from_snapshot",
    state: classifyState(price_change_5m_pct, oi_change_5m_pct),
    warmup_5m: !(snapNow && snapPrev),
    source: "okx_swap_public_api+upstash_state",
  };
}

export default async function handler(req, res) {
  try {
    const symbols = normalizeSymbolsQuery(req);
    const reqCache = { swapList: null, instMap: new Map(), metaMap: new Map() };

    const maxConcurrency = Number(process.env.SNAPSHOT_MAX_CONCURRENCY || 5);
    const results = await mapWithConcurrency(symbols, maxConcurrency, (s) => processOne(s, reqCache));

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
