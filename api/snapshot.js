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
      return res.status(400).json({ ok: false, symbol, error: "unsupported symbol format (expected like ETHUSDT)" });
    }

    const base = "https://www.okx.com";

    // Current mark price
    const markUrl = `${base}/api/v5/public/mark-price?instType=SWAP&instId=${encodeURIComponent(instId)}`;
    // Funding: current + previous
    const fundingUrl = `${base}/api/v5/public/funding-rate-history?instId=${encodeURIComponent(instId)}&limit=2`;
    // OI (instrument-specific, correct units)
    const oiUrl = `${base}/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`;
    // Candles (5m) for price change
    const candlesUrl = `${base}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=2`;

    const [markResp, fundingResp, oiResp, candlesResp] = await Promise.all([
      fetch(markUrl),
      fetch(fundingUrl),
      fetch(oiUrl),
      fetch(candlesUrl),
    ]);

    const bad = async (r, name) => {
      const text = await r.text();
      return res.status(r.status).json({ ok: false, symbol, instId, error: `${name} fetch failed`, detail: text });
    };

    if (!markResp.ok) return bad(markResp, "mark");
    if (!fundingResp.ok) return bad(fundingResp, "funding_history");
    if (!oiResp.ok) return bad(oiResp, "open_interest");
    if (!candlesResp.ok) return bad(candlesResp, "candles");

    const markJson = await markResp.json();
    const fundingJson = await fundingResp.json();
    const oiJson = await oiResp.json();
    const candlesJson = await candlesResp.json();

    const price = Number(markJson?.data?.[0]?.markPx);

    const funding_rate = fundingJson?.data?.[0]?.fundingRate != null ? Number(fundingJson.data[0].fundingRate) : null;
    const funding_prev = fundingJson?.data?.[1]?.fundingRate != null ? Number(fundingJson.data[1].fundingRate) : null;
    const funding_change = (funding_rate != null && funding_prev != null) ? (funding_rate - funding_prev) : null;

    const open_interest_contracts =
      oiJson?.data?.[0]?.oi != null ? Number(oiJson.data[0].oi) : null;

    const open_interest_usd =
      open_interest_contracts != null && Number.isFinite(price)
        ? open_interest_contracts * price
        : null;

    // OKX candles: array of arrays (strings), newest first.
    // Format: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
    const c0 = candlesJson?.data?.[0];
    const c1 = candlesJson?.data?.[1];
    const close_now = c0 ? Number(c0[4]) : null;
    const close_prev = c1 ? Number(c1[4]) : null;
    const price_change_5m_pct = pctChange(close_now, close_prev);

    // We do not have a reliable instrument-specific OI history endpoint in this minimal version,
    // so we leave oi_change_5m_pct null for now.
    const oi_change_5m_pct = null;

    const state = classifyState(price_change_5m_pct, oi_change_5m_pct);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");

    return res.status(200).json({
      ok: true,
      symbol,
      instId,
      ts: Date.now(),
      price,
      close_now,
      close_prev,
      price_change_5m_pct,
      funding_rate,
      funding_prev,
      funding_change,
      open_interest_contracts,
      open_interest_usd,
      oi_change_5m_pct,
      state,
      source: "okx_swap_public_api",
      note: "OI change is null until we add a small store or a dedicated OI history source (CoinGlass later).",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}