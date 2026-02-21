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
    // Funding: current + previous (limit=2)
    const fundingUrl = `${base}/api/v5/public/funding-rate-history?instId=${encodeURIComponent(instId)}&limit=2`;
    // Open interest: current + previous (we'll sample last 2 points of history if available)
    // OKX has open interest history endpoint:
    const oiHistUrl = `${base}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${encodeURIComponent(instId.split("-")[0])}`;

    const [markResp, fundingResp, oiHistResp] = await Promise.all([
      fetch(markUrl),
      fetch(fundingUrl),
      fetch(oiHistUrl),
    ]);

    const bad = async (r, name) => {
      const text = await r.text();
      return res.status(r.status).json({ ok: false, symbol, instId, error: `${name} fetch failed`, detail: text });
    };

    if (!markResp.ok) return bad(markResp, "mark");
    if (!fundingResp.ok) return bad(fundingResp, "funding_history");
    if (!oiHistResp.ok) return bad(oiHistResp, "oi_history");

    const markJson = await markResp.json();
    const fundingJson = await fundingResp.json();
    const oiHistJson = await oiHistResp.json();

    const price = Number(markJson?.data?.[0]?.markPx);

    // Funding history: newest first
    const fundingNow = fundingJson?.data?.[0]?.fundingRate != null ? Number(fundingJson.data[0].fundingRate) : null;
    const fundingPrev = fundingJson?.data?.[1]?.fundingRate != null ? Number(fundingJson.data[1].fundingRate) : null;
    const funding_change = (fundingNow != null && fundingPrev != null) ? (fundingNow - fundingPrev) : null;

    // OI history via Rubik is aggregated (not perfect but good enough to trend).
    // We'll use last two points if present.
    // Data shape can vary; we'll try common fields.
    const oiArr = oiHistJson?.data ?? [];
    // Try to grab last two values from first series
    let oiNow = null, oiPrev = null;

    // Some responses are like [{ts:"", oi:""}] or nested arrays; handle both lightly
    if (Array.isArray(oiArr) && oiArr.length > 0) {
      const series = oiArr[0]?.data && Array.isArray(oiArr[0].data) ? oiArr[0].data : oiArr;
      const n = Array.isArray(series) ? series.length : 0;
      if (n >= 2) {
        const last = series[n - 1];
        const prev = series[n - 2];
        oiNow = Number(last?.oi ?? last?.openInterest ?? last?.value ?? last?.[1]);
        oiPrev = Number(prev?.oi ?? prev?.openInterest ?? prev?.value ?? prev?.[1]);
      }
    }

    // If Rubik parsing fails, fall back: at least return current OI from public endpoint
    let open_interest_contracts = null;
    if (oiNow != null && Number.isFinite(oiNow)) {
      open_interest_contracts = oiNow;
    } else {
      const oiUrl = `${base}/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`;
      const oiResp = await fetch(oiUrl);
      if (oiResp.ok) {
        const oiJson = await oiResp.json();
        open_interest_contracts = oiJson?.data?.[0]?.oi != null ? Number(oiJson.data[0].oi) : null;
      }
    }

    const open_interest_usd =
      open_interest_contracts != null && Number.isFinite(price)
        ? open_interest_contracts * price
        : null;

    // Trend fields (only if we got history points)
    const price_change_5m_pct = null; // mark-price history is not provided directly here; keep for later if you want candles
    const oi_change_5m_pct = pctChange(oiNow, oiPrev);
    const state = classifyState(price_change_5m_pct, oi_change_5m_pct);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");

    return res.status(200).json({
      ok: true,
      symbol,
      instId,
      ts: Date.now(),
      price,
      funding_rate: fundingNow,
      funding_prev: fundingPrev,
      funding_change,
      open_interest_contracts,
      open_interest_usd,
      oi_prev: oiPrev,
      oi_change_5m_pct,
      price_change_5m_pct,
      state,
      source: "okx_swap_public_api",
      note: "price_change_5m_pct is null until we add candle-based price history",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}