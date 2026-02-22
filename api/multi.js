// /api/multi.js
// OKX PERP (SWAP) ONLY — rolling 5m series + multi-timeframe deltas (5m/15m/30m/1h/4h)
// Always returns ALL timeframes each call, so you don't need different URLs.
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
    if (funding_rate > 0)
      return { lean: "neutral", why: "Not enough change data yet; funding slightly positive." };
    if (funding_rate < 0)
      return { lean: "neutral", why: "Not enough change data yet; funding slightly negative." };
  }
  return { lean: "neutral", why: "Not enough change data yet." };
}

function normalizeDriverTf(rawTf) {
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

async function fetchOne(symbol, now, driver_tf, debug) {
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
    Number.isFinite(open_interest_contracts) && Number.isFinite(price) ? open_interest_contracts * price : null;

  // ---- Rolling 5m history append (once per bucket) ----
  const bucket = Math.floor(now / BUCKET_MS);
  const seriesKey = `series5m:${instId}`;
  const lastBucketKey = `lastBucket:${instId}`;

  const lastBucketRaw = await redis.get(lastBucketKey);
  const lastBucketNum = lastBucketRaw == null ? null : Number(lastBucketRaw);

  let did_append_this_call = false;

  if (!Number.isFinite(lastBucketNum) || lastBucketNum !== bucket) {
    const point = { b: bucket, ts: now, p: price, fr: funding_rate, oi: open_interest_contracts };

    await redis.rpush(seriesKey, JSON.stringify(point));
    await redis.ltrim(seriesKey, -SERIES_POINTS_24H, -1);

    await redis.set(lastBucketKey, String(bucket));

    await redis.expire(seriesKey, SERIES_TTL_SECONDS);
    await redis.expire(lastBucketKey, SERIES_TTL_SECONDS);

    did_append_this_call = true;
  }

  // ---- Read once (max needed) then compute ALL timeframes in-memory ----
  const raw = await redis.lrange(seriesKey, -MAX_NEEDED_POINTS, -1);
  const points = (raw || []).map(safeJsonParse).filter(Boolean);

  const deltas = {};
  for (const tf of TF_ORDER) {
    deltas[tf] = computeTfDeltas(points, tf, funding_rate);
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

    // current values
    price,
    funding_rate,
    open_interest_contracts,
    open_interest_usd,

    // multi-timeframe package
    driver_tf,
    state,
    lean,
    why,
    deltas,

    source: "okx_swap_public_api+upstash_series",
  };

  if (debug) {
    const series_len = await redis.llen(seriesKey);
    out.debug = {
      bucket_now: bucket,
      lastBucket_stored_raw: lastBucketRaw ?? null,
      lastBucket_stored_num: Number.isFinite(lastBucketNum) ? lastBucketNum : null,
      did_append_this_call,
      series_len: Number.isFinite(series_len) ? series_len : series_len ?? null,
      points_read: points.length,
      last_point: points.length ? points[points.length - 1] : null,
      first_point: points.length ? points[0] : null,
      keys: { seriesKey, lastBucketKey },
    };
  }

  return out;
}

function wantsHtml(req) {
  return String(req.query.view || "").toLowerCase() === "html";
}

function wantsDebug(req) {
  return String(req.query.debug || "").toLowerCase() === "1";
}

export default async function handler(req, res) {
  try {
    const driver_tf = normalizeDriverTf(req.query.driver_tf);
    const debug = wantsDebug(req);

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
    const results = await Promise.all(symbols.map((sym) => fetchOne(sym, now, driver_tf, debug)));

    // iPhone-friendly HTML view (auto-refresh)
    if (wantsHtml(req)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");

      const qs = new URLSearchParams(req.query);
      // Ensure HTML view loads JSON view from same endpoint but without view=html
      qs.delete("view");
      const jsonUrl = `/api/multi?${qs.toString()}`;

      return res.status(200).send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>crypto-market-gateway</title>
  <style>
    body { font-family: -apple-system, system-ui, Arial; margin: 12px; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; }
    .row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    button { padding: 8px 10px; font-size: 14px; }
    input { width: 80px; padding: 6px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="row">
    <button onclick="load()">Refresh</button>
    <span>Auto:</span>
    <input id="sec" type="number" value="10" min="3" />
    <button onclick="toggle()">Start/Stop</button>
    <span id="status">stopped</span>
  </div>
  <div><strong>JSON:</strong> ${jsonUrl}</div>
  <pre id="out">Loading...</pre>
<script>
  let t = null;
  async function load() {
    const r = await fetch("${jsonUrl}", { cache: "no-store" });
    const j = await r.json();
    document.getElementById("out").textContent = JSON.stringify(j, null, 2);
  }
  function toggle() {
    const s = document.getElementById("status");
    if (t) { clearInterval(t); t = null; s.textContent = "stopped"; return; }
    const sec = Math.max(3, Number(document.getElementById("sec").value || 10));
    t = setInterval(load, sec * 1000);
    s.textContent = "running";
  }
  load();
</script>
</body>
</html>`);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      ts: now,
      symbols,
      driver_tf,
      timeframes: TF_ORDER,
      results,
      note:
        "OKX perps-only. Rolling 5m series (24h). Each response includes deltas for 5m/15m/30m/1h/4h derived from 5m points. warmup per timeframe goes false once enough points exist.",
      tip: "Set driver_tf=4h when you want the top-level lean/why to reflect longer-term positioning.",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}