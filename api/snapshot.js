function toOkxInstId(symbol) {
  // "ETHUSDT" -> "ETH-USDT-SWAP"
  const s = String(symbol || "").toUpperCase();
  if (!s.endsWith("USDT")) return null;
  const base = s.slice(0, -4);
  return `${base}-USDT-SWAP`;
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

    const base = "https://www.okx.com";

    const markUrl = `${base}/api/v5/public/mark-price?instType=SWAP&instId=${encodeURIComponent(instId)}`;
    const fundingUrl = `${base}/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`;
    const oiUrl = `${base}/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`;

    const [markResp, fundingResp, oiResp] = await Promise.all([
      fetch(markUrl),
      fetch(fundingUrl),
      fetch(oiUrl),
    ]);

    const bad = async (r, name) => {
      const text = await r.text();
      return res.status(r.status).json({
        ok: false,
        symbol,
        instId,
        error: `${name} fetch failed`,
        detail: text,
      });
    };

    if (!markResp.ok) return bad(markResp, "mark");
    if (!fundingResp.ok) return bad(fundingResp, "funding");
    if (!oiResp.ok) return bad(oiResp, "open_interest");

    const markJson = await markResp.json();
    const fundingJson = await fundingResp.json();
    const oiJson = await oiResp.json();

    const price = Number(markJson?.data?.[0]?.markPx);
    const funding_rate = Number(fundingJson?.data?.[0]?.fundingRate);

    const open_interest_contracts =
      oiJson?.data?.[0]?.oi != null ? Number(oiJson.data[0].oi) : null;

    const open_interest_usd =
      open_interest_contracts != null && Number.isFinite(price)
        ? open_interest_contracts * price
        : null;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");

    return res.status(200).json({
      ok: true,
      symbol,
      instId,
      ts: Date.now(),
      price,
      funding_rate,
      open_interest_contracts,
      open_interest_usd,
      source: "okx_swap_public_api",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(err?.message || err),
    });
  }
}