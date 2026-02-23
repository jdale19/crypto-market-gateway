// /api/alert.js
// Alert Engine v1
// Evaluates signal rules and sends Telegram DM only when triggered.
// Requires:
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
// Optional:
// - DEFAULT_SYMBOLS

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

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

function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x.toFixed(3)}%`;
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

export default async function handler(req, res) {
  try {
    const force = String(req.query.force || "") === "1";

    const querySymbols = normalizeSymbols(req.query.symbols);
    const envSymbols = normalizeSymbols(process.env.DEFAULT_SYMBOLS);
    const symbols =
      querySymbols.length > 0
        ? querySymbols
        : envSymbols.length > 0
        ? envSymbols
        : ["BTCUSDT", "ETHUSDT", "LDOUSDT"];

    const driver_tf = normalizeDriverTf(req.query.driver_tf);

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();

    const multiUrl =
      `${proto}://${host}/api/multi?symbols=${encodeURIComponent(symbols.join(","))}` +
      `&driver_tf=${driver_tf}&debug=1`;

    const r = await fetch(multiUrl, { headers: { "Cache-Control": "no-store" } });
    const j = await r.json();

    if (!r.ok || !j?.ok) {
      return res.status(500).json({ ok: false, error: "multi fetch failed", detail: j || null });
    }

    const now = Date.now();
    const triggered = [];

    for (const item of j.results || []) {
      if (!item?.ok) continue;

      const symbol = item.symbol;
      const d5 = item.deltas?.["5m"];
      const d15 = item.deltas?.["15m"];

      if (!d5 || !d15) continue;

      const stateKey = `alert:last15mState:${symbol}`;
      const cooldownKey = `alert:lastSent:${symbol}`;

      const prevState = await redis.get(stateKey);
      const lastSentRaw = await redis.get(cooldownKey);
      const lastSent = lastSentRaw ? Number(lastSentRaw) : 0;

      const cooldownActive = now - lastSent < COOLDOWN_MS;

      let fire = false;
      let reason = null;

      // 1) Setup flip (15m state change)
      if (!force && prevState && prevState !== d15.state) {
        fire = true;
        reason = "Setup flip (15m state changed)";
      }

      // 2) Momentum confirmation
      if (
        !force &&
        !fire &&
        d5.lean === d15.lean &&
        Math.abs(d5.price_change_pct || 0) >= 0.1
      ) {
        fire = true;
        reason = "Momentum confirmation";
      }

      // 3) Positioning shock
      if (
        !force &&
        !fire &&
        Math.abs(d15.oi_change_pct || 0) >= 0.5 &&
        Math.abs(d15.price_change_pct || 0) >= 0.2
      ) {
        fire = true;
        reason = "Positioning shock";
      }

      // Apply cooldown unless forced
      if (fire && !force && cooldownActive) {
        fire = false;
      }

      if (fire || force) {
        triggered.push({
          symbol,
          price: item.price,
          state: item.state,
          lean: item.lean,
          reason: force ? "Manual override" : reason,
          d5,
          d15,
        });

        await redis.set(stateKey, d15.state);
        await redis.set(cooldownKey, String(now));
      } else {
        // Update state without triggering
        await redis.set(stateKey, d15.state);
      }
    }

    if (!force && triggered.length === 0) {
      return res.status(200).json({
        ok: true,
        sent: false,
        message: "No alert criteria met.",
      });
    }

    const lines = [];
    lines.push(`ALERT ENGINE V1 (${driver_tf})`);
    lines.push(new Date(j.ts).toISOString());
    lines.push("");

    for (const t of triggered) {
      lines.push(
        [
          `${t.symbol} $${t.price}`,
          `driver=${t.state}/${t.lean}`,
          `5m p=${fmtPct(t.d5.price_change_pct)} oi=${fmtPct(t.d5.oi_change_pct)}`,
          `15m p=${fmtPct(t.d15.price_change_pct)} oi=${fmtPct(t.d15.oi_change_pct)}`,
          `reason=${t.reason}`,
        ].join(" | ")
      );
    }

    lines.push("");
    lines.push(multiUrl);

    const tg = await sendTelegram(lines.join("\n"));

    if (!tg.ok) {
      return res.status(500).json({ ok: false, error: tg.error });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      sent: true,
      triggered: triggered.map((t) => t.symbol),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}