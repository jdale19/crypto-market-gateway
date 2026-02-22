import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  try {
    const symbol = "ETHUSDT";

    // ---- Fetch OKX swap data ----
    const instId = "ETH-USDT-SWAP";

    const tickerRes = await fetch(
      `https://www.okx.com/api/v5/market/ticker?instId=${instId}`
    );
    const tickerJson = await tickerRes.json();
    const price = parseFloat(tickerJson.data[0].last);

    const fundingRes = await fetch(
      `https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`
    );
    const fundingJson = await fundingRes.json();
    const funding_rate = parseFloat(fundingJson.data[0].fundingRate);

    const oiRes = await fetch(
      `https://www.okx.com/api/v5/public/open-interest?instId=${instId}`
    );
    const oiJson = await oiRes.json();
    const open_interest_contracts = parseFloat(oiJson.data[0].oi);

    // ---- Load previous snapshot from Redis ----
    const prev = await redis.get(`snapshot:${symbol}`);

    let oi_change_5m_pct = null;

    if (prev?.open_interest_contracts) {
      oi_change_5m_pct =
        ((open_interest_contracts - prev.open_interest_contracts) /
          prev.open_interest_contracts) *
        100;
    }

    // ---- Store new snapshot ----
    const snapshot = {
      price,
      funding_rate,
      open_interest_contracts,
      ts: Date.now(),
    };

    await redis.set(`snapshot:${symbol}`, snapshot);

    res.status(200).json({
      ok: true,
      symbol,
      price,
      funding_rate,
      open_interest_contracts,
      oi_change_5m_pct,
      source: "okx_swap_public_api",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}