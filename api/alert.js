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

function normalizeDriverTf(raw) {
  const tf = String(raw || "5m").toLowerCase();
  const allowed = new Set(["5m", "15m", "30m", "1h", "4h"]);
  return allowed.has(tf) ? tf : "5m";
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
  return `${x.toFixed(3)}%`;
}

export default async function handler(req, res) {
  try {
    // ✅ FIX: [] is truthy. Must check .length and handle "symbols=" explicitly.
    const querySymbols = normalizeSymbols(req.query.symbols);
    const envSymbols = normalizeSymbols(process.env.DEFAULT_SYMBOLS);
    const symbols =
      querySymbols.length > 0 ? querySymbols : envSymbols.length > 0 ? envSymbols : ["BTCUSDT", "ETHUSDT", "LDOUSDT"];

    const driver_tf = normalizeDriverTf(req.query.driver_tf);
    const debug = String(req.query.debug || "") === "1";

    // Call your own /api/multi on the same host
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();

    // ✅ FIX: never send symbols= (blank). Only include symbols param if non-empty.
    const qs = new URLSearchParams();
    qs.set("symbols", symbols.join(","));
    qs.set("driver_tf", driver_tf);
    if (debug) qs.set("debug", "1");

    const multiUrl = `${proto}://${host}/api/multi?${qs.toString()}`;

    const r = await fetch(multiUrl, { headers: { "Cache-Control": "no-store" } });
    const j = await r.json().catch(() => null);

    if (!r.ok || !j?.ok) {
      return res.status(500).json({
        ok: false,
        error: "multi fetch failed",
        detail: j || null,
        multiUrl,
        symbols,
        driver_tf,
      });
    }

    // Build DM
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
      return res.status(500).json({
        ok: false,
        error: tg.error,
        detail: tg.detail || null,
        symbols,
        driver_tf,
        multiUrl,
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      sent: true,
      symbols,
      driver_tf,
      multiUrl,
      meta: {
        query_symbols_len: querySymbols.length,
        env_symbols_len: envSymbols.length,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}