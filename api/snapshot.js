import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function toOkxInstId(symbol) {
  // "ETHUSDT" -> "ETH-USDT-SWAP"
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

export default async function handler(req, res) {
  try {
    const symbol = String(req.query.symbol || "ETHUSDT").toUpperCase();
    const instId = toOkxInstId(symbol);
    if (!instId) {
      return res.status(400).json({ ok: false, symbol, error: "unsupported symbol format (expected like ETHUSDT)" });
    }

    // Fetch OKX data (simple + reliable)
    const [tickerRes, fundingRes, oiRes] = await Promise.all([
      fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
      fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
      fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`),
    ]);

    if (!tickerRes.ok) return res.status(502).json({ ok: false, symbol, error: "ticker fetch failed" });
    if (!fundingRes.ok) return res.status(502).json({ ok: false, symbol, error: "funding fetch failed" });
    if (!oiRes.ok) return res.status(502).json({ ok: false, symbol, error: "oi fetch failed" });

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

    // Load previous snapshot from Redis
    const key = `snapshot:${instId}`;
    const prev = await redis.get(key);

    const price_change_pct = pctChange(price, prev?.price);
    const oi_change_pct = pctChange(open_interest_contracts, prev?.open_interest_contracts);
    const funding_change = (Number.isFinite(funding_rate) && Number.isFinite(prev?.funding_rate))
      ? (funding_rate - prev.funding_rate)
      : null;

    const state = classifyState(price_change_pct, oi_change_pct);

    // Store current snapshot for next call
    const snapshot = {
      price,
      funding_rate,
      open_interest_contracts,
      ts: Date.now(),
    };
    await redis.set(key, snapshot);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      symbol,
      instId,
      ts: snapshot.ts,
      price,
      funding_rate,
      funding_change,
      open_interest_contracts,
      open_interest_usd,
      price_change_pct,
      oi_change_pct,
      state,
      source: "okx_swap_public_api+upstash_state",
      note: "price_change_pct/oi_change_pct are since the last time you called this endpoint for the symbol",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}