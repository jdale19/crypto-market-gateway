// /api/multi.js
// OKX PERP (SWAP) ONLY — rolling 5m series + multi-timeframe deltas (5m/15m/30m/1h/4h)
//
// UPDATED: supports SNAPSHOT-ONLY mode (NO OKX HTTP calls)
// - Set env MULTI_DATA_SOURCE=snapshot  (or add ?source=snapshot / ?snapshot=1)
// - In snapshot mode, this endpoint will ONLY read snapshots from Upstash and update the rolling 5m series.
// - Debug counters prove whether any OKX calls happened.
//
// Requires env variables:
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
// Optional:
// - DEFAULT_SYMBOLS (comma list like "BTCUSDT,ETHUSDT,LDOUSDT")
// - MULTI_DATA_SOURCE ("okx" | "snapshot") default "okx"
// - SNAPSHOT_KEY_PREFIX (default "snap:okx:swap:")  -> key becomes `${prefix}${instId}`
// - SNAPSHOT_SYMBOL_FALLBACK_PREFIX (default "snap:symbol:") -> `${prefix}${SYMBOL}`
// Snapshot JSON expected (either key):
//   { "ts": 123, "price": 123.45, "high": 123.80, "low": 122.90, "funding_rate": 0.0001, "open_interest_contracts": 123456 }

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BUCKET_MS = 5 * 60 * 1000;
const SERIES_POINTS_CAP = 864; // 72h / 5m (12 points/hour * 72h)
const SERIES_TTL_SECONDS = 60 * 60 * 96; // 96h
const INST_MAP_TTL_SECONDS = 60 * 60 * 24; // 24h
const INST_LIST_TTL_SECONDS = 60 * 60 * 12; // 12h

// Derived from 5m series
const TF_TO_STEPS = {
  "5m": 1,
  "15m": 3,
  "30m": 6,
  "1h": 12,
  "4h": 48,
};

const TF_ORDER = ["5m", "15m", "30m", "1h", "4h"];
const MAX_STEPS = Math.max(...Object.values(TF_TO_STEPS)); // 48
const MAX_NEEDED_POINTS = MAX_STEPS + 1; // 49

const CFG = {
  dataSourceDefault: String(process.env.MULTI_DATA_SOURCE || "okx").toLowerCase(), // "okx" | "snapshot"
  snapshot: {
    keyPrefix: String(process.env.SNAPSHOT_KEY_PREFIX || "snap:okx:swap:"), // + instId
    symbolFallbackPrefix: String(process.env.SNAPSHOT_SYMBOL_FALLBACK_PREFIX || "snap:symbol:"), // + SYMBOL (e.g. BTCUSDT)
  },
};

function pctChange(now, prev) {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return null;
  if (now == null || !Number.isFinite(now)) return null;
  return ((now - prev) / prev) * 100;
}

// ✅ FIX: handle string OR already-parsed object
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

function baseFromSymbolUSDT(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!s.endsWith("USDT")) return null;
  return s.slice(0, -4);
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

function normalizeDriverTf(rawTf) {
  const tf = String(rawTf || "5m").toLowerCase();
  return TF_TO_STEPS[tf] ? tf : "5m";
}

function normalizeDataSource(req) {
  // explicit query overrides env
  const qSource = String(req?.query?.source || "").toLowerCase();
  const snapFlag = String(req?.query?.snapshot || "") === "1";

  if (snapFlag) return "snapshot";
  if (qSource === "snapshot" || qSource === "snap") return "snapshot";
  if (qSource === "okx") return "okx";

  const env = String(CFG.dataSourceDefault || "okx").toLowerCase();
  return env === "snapshot" ? "snapshot" : "okx";
}

// --- OKX instrument list caching (OKX MODE only) ---
async function getOkxSwapInstrumentListCached(counters) {
  const cacheKey = `okx:instruments:swap:list:v1`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    const list = safeJsonParse(cached);
    if (Array.isArray(list)) return list;
  }

  counters.okx_http_calls += 1;
  counters.okx_instrument_list_fetches += 1;

  const url = "https://www.okx.com/api/v5/public/instruments?instType=SWAP";
  const r = await fetch(url);
  if (!r.ok) {
    counters.okx_http_failures += 1;
    return null;
  }

  const j = await r.json().catch(() => null);
  const list = Array.isArray(j?.data) ? j.data : null;
  if (!Array.isArray(list)) return null;

  await redis.set(cacheKey, JSON.stringify(list));
  await redis.expire(cacheKey, INST_LIST_TTL_SECONDS);
  return list;
}

async function resolveOkxSwapInstId(symbol, { dataSource, counters }) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) return null;

  // SNAPSHOT MODE: do NOT touch OKX instrument list; just use the canonical instId
  if (dataSource === "snapshot") {
    return `${base}-USDT-SWAP`;
  }

  const mapKey = `instmap:okx:swap:${base}`;
  const cached = await redis.get(mapKey);
  if (cached) return cached === "__NONE__" ? null : cached;

  const list = await getOkxSwapInstrumentListCached(counters);
  if (!Array.isArray(list)) {
    // If list fetch fails, fall back to guess (do NOT cache it).
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

// --- Snapshot read (SNAPSHOT MODE only) ---
// ✅ UPDATED: read the SAME keys written by /api/snapshot.js
// /api/snapshot.js stores: `snap5m:${instId}:${bucket}`
async function fetchSnapshotForInstId(instId, counters) {
  const now = Date.now();
  const bucket = Math.floor(now / BUCKET_MS);

  const key = `snap5m:${instId}:${bucket}`;
  const raw = await redis.get(key);

  if (raw) {
    const j = safeJsonParse(raw);
    const price = Number(j?.price);
const high = Number(j?.high);
const low = Number(j?.low);
const fr = j?.funding_rate == null ? null : Number(j?.funding_rate);
const oi = Number(j?.open_interest_contracts);

if (Number.isFinite(price) && Number.isFinite(oi) && Number.isFinite(high) && Number.isFinite(low)) {
  counters.snapshot_hits += 1;
  return {
    ok: true,
    price,
    high,
    low,
    funding_rate: Number.isFinite(fr) ? fr : null,
    open_interest_contracts: oi,
    ts: j?.ts ?? null,
    key,
  };
}
  }

  counters.snapshot_misses += 1;
  return { ok: false, error: "snapshot_missing" };
}

// --- OKX fetch (OKX MODE only) ---
async function fetchOkxSwap(instId, counters) {
  // counters prove OKX usage
  counters.okx_http_calls += 3;

  const [tickerRes, fundingRes, oiRes] = await Promise.all([
    fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
    fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
    fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`),
  ]);

  if (!tickerRes.ok) {
    counters.okx_http_failures += 1;
    return { ok: false, error: "ticker fetch failed" };
  }
  if (!fundingRes.ok) {
    counters.okx_http_failures += 1;
    return { ok: false, error: "funding fetch failed" };
  }
  if (!oiRes.ok) {
    counters.okx_http_failures += 1;
    return { ok: false, error: "oi fetch failed" };
  }

  const tickerJson = await tickerRes.json().catch(() => null);
  const fundingJson = await fundingRes.json().catch(() => null);
  const oiJson = await oiRes.json().catch(() => null);

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

function computeTfDeltas(points, tf, funding_rate) {
  const steps = TF_TO_STEPS[tf];
  const needed = steps + 1;

  const nowPoint = points.length >= 1 ? points[points.length - 1] : null;
  const prevPoint = points.length >= needed ? points[points.length - needed] : null;

  const price_change_pct = pctChange(nowPoint?.p, prevPoint?.p);
  const oi_change_pct = pctChange(nowPoint?.oi, prevPoint?.oi);

  const funding_change =
    Number.isFinite(nowPoint?.fr) && Number.isFinite(prevPoint?.fr) ? nowPoint.fr - prevPoint.fr : null;

  const state = classifyState(price_change_pct, oi_change_pct);
  const { lean, why } = addLeanAndWhy(state, funding_rate);

  const warmup = !(nowPoint && prevPoint);

  return {
    tf,
    warmup,
    price_change_pct,
    oi_change_pct,
    funding_change,
    state,
    lean,
    why,
  };
}

function median(nums) {
  const a = (nums || []).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function maxDrawdownPct(prices) {
  const a = (prices || []).filter((x) => Number.isFinite(x));
  if (a.length < 2) return null;
  let peak = a[0];
  let maxDD = 0; // negative
  for (const p of a) {
    if (p > peak) peak = p;
    const dd = ((p - peak) / peak) * 100;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

function pctChangeSimple(now, prev) {
  if (!Number.isFinite(prev) || prev === 0) return null;
  if (!Number.isFinite(now)) return null;
  return ((now - prev) / prev) * 100;
}

function computeBuildRegime(points72) {
  // points are {p, oi, fr}
  const pts = (points72 || []).filter((x) => x && Number.isFinite(x.p));
  const n = pts.length;

  const out = {
    ok: false,
    warmup: true,
    regime: "neutral",
    score: 0,
    inputs: {},
    flags: {},
    reasons: [],
  };

  if (n < 200) return out; // warmup until you have meaningful history

  const W24 = pts.slice(Math.max(0, n - 288));
  const W72 = pts; // expects ~864 if fully warmed

  const p24_0 = W24[0]?.p, p24_1 = W24[W24.length - 1]?.p;
  const p72_0 = W72[0]?.p, p72_1 = W72[W72.length - 1]?.p;

  const oi24_0 = W24[0]?.oi, oi24_1 = W24[W24.length - 1]?.oi;
  const oi72_0 = W72[0]?.oi, oi72_1 = W72[W72.length - 1]?.oi;

  const ret24 = pctChangeSimple(p24_1, p24_0);
  const ret72 = pctChangeSimple(p72_1, p72_0);
  const oiChg24 = pctChangeSimple(oi24_1, oi24_0);
  const oiChg72 = pctChangeSimple(oi72_1, oi72_0);

  const frVals = W72.map((x) => x.fr).filter((x) => Number.isFinite(x));
  const frNow = pts[n - 1]?.fr;
  const frMed = median(frVals);
  const absDevs = frVals.map((x) => Math.abs(x - frMed)).filter((x) => Number.isFinite(x));
  const frMad = median(absDevs);
  const eps = 1e-12;
  const frZ = Number.isFinite(frNow) && Number.isFinite(frMed) && Number.isFinite(frMad)
    ? (frNow - frMed) / (1.4826 * frMad + eps)
    : null;

  const prices72 = W72.map((x) => x.p);
  const maxDD72 = maxDrawdownPct(prices72);

  // Flags
  const waterfallRisk =
    Number.isFinite(ret24) && Number.isFinite(oiChg24) && ret24 <= -1.2 && oiChg24 >= 1.0;

  const accumulationDiv =
    Number.isFinite(ret72) &&
    Number.isFinite(oiChg72) &&
    Number.isFinite(maxDD72) &&
    ret72 <= 0.3 &&
    oiChg72 >= 2.0 &&
    maxDD72 > -6.0;

  // Score
  let score = 0;

  // Trend / stability
  if (Number.isFinite(ret72)) {
    if (ret72 >= 0.5) score += 25;
    else if (ret72 >= -1.0) score += 15;
    else score -= 15;
  }

  if (Number.isFinite(maxDD72)) {
    if (maxDD72 > -6.0) score += 10;
    else if (maxDD72 <= -10.0) score -= 15;
  }

  // OI behavior
  if (Number.isFinite(oiChg72)) {
    if (oiChg72 >= 1.0 && oiChg72 <= 8.0) score += 20;
    else if (oiChg72 > 8.0) score += 10;
  }

  if (accumulationDiv) score += 10;
  if (waterfallRisk) score -= 30;

  // Funding crowding
  if (Number.isFinite(frZ)) {
    if (frZ <= -0.5) score += 20;
    else if (frZ > -0.5 && frZ < 0.5) score += 10;
    else if (frZ >= 0.5) score -= 10;
    if (frZ >= 1.5) score -= 15;
  }

  // Regime mapping
  let regime = "neutral";
  if (score >= 30) regime = "accumulate";
  else if (score <= -30) regime = "avoid";

  // Reasons
  const reasons = [];
  if (accumulationDiv) reasons.push("OI rising 72h while price flat/down (accumulation divergence)");
  if (waterfallRisk) reasons.push("Waterfall risk: price down 24h while OI rising (short pile-in risk)");
  if (Number.isFinite(maxDD72) && maxDD72 > -6.0) reasons.push("72h drawdown contained (<6%)");
  if (Number.isFinite(frZ) && frZ >= 1.5) reasons.push("Funding stretched positive (crowded longs)");
  if (Number.isFinite(frZ) && frZ <= -0.5) reasons.push("Funding below baseline (less crowded)");

  out.ok = true;
  out.warmup = false;
  out.regime = regime;
  out.score = score;
  out.inputs = {
    ret24,
    ret72,
    oiChg24,
    oiChg72,
    fr_now: frNow ?? null,
    fr_med72: frMed ?? null,
    fr_z72: frZ ?? null,
    maxDD72,
    points72: n,
  };
  out.flags = { waterfall_risk: waterfallRisk, accumulation_divergence: accumulationDiv };
  out.reasons = reasons;

  return out;
}

async function fetchOne(symbol, now, driver_tf, debugMode, dataSource, includeRegime, counters) {
  const base = baseFromSymbolUSDT(symbol);
  if (!base) {
    return { ok: false, symbol, error: "unsupported symbol format (expected like ETHUSDT)" };
  }

  const instId = await resolveOkxSwapInstId(symbol, { dataSource, counters });
  if (!instId) {
    return {
      ok: false,
      symbol,
      instId: `${base}-USDT-SWAP`,
      error: "no OKX perp market (perps-only mode)",
    };
  }

  // Get current snapshot (either from OKX or from Upstash snapshot keys)
  let cur;
  if (dataSource === "snapshot") {
    cur = await fetchSnapshotForInstId(instId, counters);
  } else {
    cur = await fetchOkxSwap(instId, counters);
  }

  if (!cur.ok) return { ok: false, symbol, instId, error: cur.error };

  const price = cur.price;
  const high = cur.high;
  const low = cur.low;
  const funding_rate = cur.funding_rate;
  const open_interest_contracts = cur.open_interest_contracts;

  const open_interest_usd =
    Number.isFinite(open_interest_contracts) && Number.isFinite(price) ? open_interest_contracts * price : null;

  // ---- Rolling 5m history append (once per bucket) ----
  const bucket = Math.floor(now / BUCKET_MS);
  const seriesKey = `series5m:${instId}`;
  const lastBucketKey = `lastBucket:${instId}`;

  const lastBucketRaw = await redis.get(lastBucketKey);
  const lastBucketNum = lastBucketRaw == null ? null : Number(lastBucketRaw);

  let wrotePoint = false;

  if (!Number.isFinite(lastBucketNum) || lastBucketNum !== bucket) {
    const point = { b: bucket, ts: now, p: price, h: high, l: low, fr: funding_rate, oi: open_interest_contracts };

    await redis.rpush(seriesKey, JSON.stringify(point));
    wrotePoint = true;

    // Trim using POSITIVE indices (avoid negative-index quirks)
    const lenAfter = await redis.llen(seriesKey);
    if (Number.isFinite(lenAfter) && lenAfter > SERIES_POINTS_CAP) {
      const startKeep = Math.max(0, lenAfter - SERIES_POINTS_CAP);
      await redis.ltrim(seriesKey, startKeep, lenAfter - 1);
    }

    await redis.set(lastBucketKey, String(bucket));

    await redis.expire(seriesKey, SERIES_TTL_SECONDS);
    await redis.expire(lastBucketKey, SERIES_TTL_SECONDS);
  }

  // ---- Read once (max needed) then compute ALL timeframes in-memory ----
  const seriesLen = await redis.llen(seriesKey);
  const endIdx = Math.max(0, (seriesLen || 0) - 1);
  const startIdx = Math.max(0, (seriesLen || 0) - MAX_NEEDED_POINTS);
  const raw = seriesLen > 0 ? await redis.lrange(seriesKey, startIdx, endIdx) : [];

  const points = (raw || []).map(safeJsonParse).filter(Boolean);

  const deltas = {};
  for (const tf of TF_ORDER) {
    deltas[tf] = computeTfDeltas(points, tf, funding_rate);
  }

  let build_regime = null;
if (includeRegime) {
  const seriesLenForRegime = seriesLen;
  const endR = Math.max(0, (seriesLenForRegime || 0) - 1);
  const startR = Math.max(0, (seriesLenForRegime || 0) - SERIES_POINTS_CAP);
  const rawR = seriesLenForRegime > 0 ? await redis.lrange(seriesKey, startR, endR) : [];
  const ptsR = (rawR || []).map(safeJsonParse).filter(Boolean);
  build_regime = computeBuildRegime(ptsR);
}

  // Driver summary
  const driver = deltas[driver_tf] || deltas["5m"];
  const lean = driver?.lean ?? "neutral";
  const why = driver?.why ?? "Not enough change data yet.";
  const state = driver?.state ?? "unknown";

  const out = {
  ok: true,
  symbol,
  instId,

  price,
  funding_rate,
  open_interest_contracts,
  open_interest_usd,

  driver_tf,
  state,
  lean,
  why,
  deltas,
  build_regime,

  source: dataSource === "snapshot" ? "upstash_snapshot+upstash_series" : "okx_swap_public_api+upstash_series",
};

  if (debugMode) {
    out.debug = {
      data_source: dataSource,
      snapshot_key_used: dataSource === "snapshot" ? (cur?.key || null) : null,
      snapshot_ts: dataSource === "snapshot" ? (cur?.ts ?? null) : null,

      bucket_now: bucket,
      last_bucket_stored: Number.isFinite(lastBucketNum) ? lastBucketNum : null,
      wrote_point: wrotePoint,
      series_len: Number.isFinite(seriesLen) ? seriesLen : null,
      read_start: startIdx,
      read_end: endIdx,
      points_parsed: points.length,
      raw_type_sample: raw?.[0] == null ? null : typeof raw[0],
    };
  }

  return out;
}

export default async function handler(req, res) {
  try {
    const driver_tf = normalizeDriverTf(req.query.driver_tf);
    const debugMode = String(req.query.debug || "") === "1";
    const dataSource = normalizeDataSource(req);

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

    // Request-level counters to PROVE OKX usage
    const counters = {
      data_source: dataSource,
      okx_http_calls: 0,
      okx_http_failures: 0,
      okx_instrument_list_fetches: 0,
      snapshot_hits: 0,
      snapshot_misses: 0,
    };

    const now = Date.now();
    const includeRegime = String(req.query.regime || "") === "1";

    const results = await Promise.all(
     symbols.map((sym) =>
      fetchOne(sym, now, driver_tf, debugMode, dataSource, includeRegime, counters)
  )
);
    
    res.setHeader("Cache-Control", "no-store");

    const payload = {
      ok: true,
      ts: now,
      symbols,
      driver_tf,
      timeframes: TF_ORDER,
      results,
      note:
        dataSource === "snapshot"
          ? "SNAPSHOT mode. NO OKX calls. Reads current snapshot from Upstash and updates rolling 5m series; deltas derived from stored points."
          : "OKX perps-only. Rolling 5m series (72h). Each response includes deltas for 5m/15m/30m/1h/4h derived from 5m points.",
      tip: "Add &debug=1 to see per-symbol series_len / wrote_point plus request counters showing OKX calls (or none).",
    };

    if (debugMode) payload.debug = { counters };

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}
