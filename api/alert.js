// /api/alert.js
// Pulls /api/multi and sends a Telegram DM summary.
// Env vars required:
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID
// Optional:
// - DEFAULT_SYMBOLS (same as multi.js)

function normalizeSymbols(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { ok: false, error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) {
    return { ok: false, error: "Telegram send failed", detail: j || null };
  }
  return { ok: true };
}

function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  const s = x.toFixed(3);
  return `${s}%`;
}

export default async function handler(req, res) {
  try {
    const symbols =
      normalizeSymbols(req.query.symbols) ||
      normalizeSymbols(process.env.DEFAULT_SYMBOLS) ||
      ["BTCUSDT", "ETHUSDT", "LDOUSDT"];

    const driver_tf = String(req.query.driver_tf || "5m").toLowerCase();
    const debug = String(req.query.debug || "") === "1";

    // Call your own /api/multi on the same host
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();

    const multiUrl =
      `${proto}://${host}/api/multi` +
      `?symbols=${encodeURIComponent(symbols.join(","))}` +
      `&driver_tf=${encodeURIComponent(driver_tf)}` +
      (debug ? `&debug=1` : ``);

    const r = await fetch(multiUrl, { headers: { "Cache-Control": "no-store" } });
    const j = await r.json();

    if (!r.ok || !j?.ok) {
      return res.status(500).json({ ok: false, error: "multi fetch failed", detail: j || null });
    }

    // Build a tight DM
    const lines = [];
    lines.push(`⚡️ OKX perps snapshot (${driver_tf})`);
    lines.push(new Date(j.ts).toISOString());

    for (const item of j.results || []) {
      if (!item?.ok) {
        lines.push(`${item?.symbol || "?"}: error (${item?.error || "unknown"})`);
        continue;
      }

      const d5 = item.deltas?.["5m"];
      const d15 = item.deltas?.["15m"];
      const d1h = item.deltas?.["1h"];

      lines.push(
        [
          `${item.symbol} $${item.price}`,
          `driver=${item.state}/${item.lean}`,
          `5m p=${fmtPct(d5?.price_change_pct)} oi=${fmtPct(d5?.oi_change_pct)}`,
          `15m p=${fmtPct(d15?.price_change_pct)} oi=${fmtPct(d15?.oi_change_pct)}`,
          `1h p=${fmtPct(d1h?.price_change_pct)} oi=${fmtPct(d1h?.oi_change_pct)}`,
        ].join(" | ")
      );
    }

    lines.push("");
    lines.push(multiUrl);

    const text = lines.join("\n");
    const tg = await sendTelegram(text);

    if (!tg.ok) {
      return res.status(500).json({ ok: false, error: tg.error, detail: tg.detail || null });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, sent: true, symbols, driver_tf, multiUrl });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}