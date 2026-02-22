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

export default async function handler(req, res) {
  try {
    const symbol = String(req.query.symbol || "ETHUSDT").toUpperCase();
    const instId = toOkxInstId(symbol);
    if (!instId) {
      return res.status(400).json({
        ok: false,
        symbol,
        error: "unsupported symbol format (expected like ETHUSDT)",
      });
    }

    // ---- Fetch OKX current values ----
    const [tickerRes, fundingRes, oiRes] = await Promise.all([
      fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
      fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
      fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`),
    ]);

    if (!tickerRes.ok)
      return res.status(502).json({ ok: false, symbol, error: "ticker fetch failed" });
    if (!fundingRes.ok)
      return res.status(502).json({ ok: false, symbol, error: "funding fetch failed" });
    if (!oiRes.ok)
      return res.status(502).json({ ok: false, symbol, error: "oi fetch failed" });

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

    // ---- Strict 5-minute bucketing ----
    const bucketMs = 5 * 60 * 1000; // 300,000 ms
    const now = Date.now();
    const bucket = Math.floor(now / bucketMs);

    const keyNow = `snap5m:${instId}:${bucket}`;
    const keyPrev = `snap5m:${instId}:${bucket - 1}`;

    // Get anchor snapshots
    let snapNow = await redis.get(keyNow);
    const snapPrev = await redis.get(keyPrev);

    // Anchor current 5-min bucket once
    if (!snapNow) {
      snapNow = {
        price,
        funding_rate,
        open_interest_contracts,
        ts: now,
      };
      await redis.set(keyNow, snapNow);
      // keep bucket keys for 24h so history doesn't grow forever
      await redis.expire(keyNow, 60 * 60 * 24);
    }

    const price_change_5m_pct = pctChange(snapNow.price, snapPrev?.price);
    const oi_change_5m_pct = pctChange(
      snapNow.open_interest_contracts,
      snapPrev?.open_interest_contracts
    );
    const funding_change_5m =
      Number.isFinite(snapNow.funding_rate) && Number.isFinite(snapPrev?.funding_rate)
        ? snapNow.funding_rate - snapPrev.funding_rate
        : null;

    const state = classifyState(price_change_5m_pct, oi_change_5m_pct);

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

      source: "okx_swap_public_api+upstash_state",
      note: "Strict 5-minute deltas compare current 5m bucket vs previous 5m bucket. If previous bucket not stored yet, deltas are null until next bucket exists.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(err?.message || err),
    });
  }
}