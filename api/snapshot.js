export default async function handler(req, res) {
  try {
    const symbol = String(req.query.symbol || "ETHUSDT").toUpperCase();

    // Binance USDT-M Futures base URL
    const base = "https://fapi.binance.com";

    // 1) Price (mark price is good for perps context)
    const markUrl = `${base}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`;

    // 2) Funding rate (same endpoint returns lastFundingRate)
    // 3) Open interest (contracts)
    const oiUrl = `${base}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=1`;

    const [markResp, oiResp] = await Promise.all([
      fetch(markUrl),
      fetch(oiUrl),
    ]);

    if (!markResp.ok) {
      const text = await markResp.text();
      return res.status(markResp.status).json({ ok: false, symbol, error: "mark/funding fetch failed", detail: text });
    }
    if (!oiResp.ok) {
      const text = await oiResp.text();
      return res.status(oiResp.status).json({ ok: false, symbol, error: "open interest fetch failed", detail: text });
    }

    const markData = await markResp.json();
    const oiHist = await oiResp.json();

    // markData fields include: markPrice, lastFundingRate (strings)
    const price = Number(markData.markPrice);
    const funding_rate = Number(markData.lastFundingRate);

    // openInterestHist returns array like [{ openInterest: "...", timestamp: ... }]
    const open_interest_contracts = oiHist?.[0]?.openInterest != null ? Number(oiHist[0].openInterest) : null;

    const open_interest_usd =
      open_interest_contracts != null && Number.isFinite(price) ? open_interest_contracts * price : null;

    // Basic caching: allow very short cache to reduce rate limits
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");

    return res.status(200).json({
      ok: true,
      symbol,
      ts: Date.now(),
      price,
      funding_rate,
      open_interest_contracts,
      open_interest_usd,
      source: "binance_usdtm_futures",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(err?.message || err),
    });
  }
}