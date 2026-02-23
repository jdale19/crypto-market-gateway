// /api/alert.js
// Alert Criteria v1
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
  const allowed = new Set(["5m", "15m", "30m", "1h", "4h"]);
  const tf = String(raw || "5m").toLowerCase();
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
    return { ok: false, error: "Telegram send failed", detail: j };
  }

  return { ok: true };
}

export default async function handler(req, res) {
  try {
    const force = String(req.query.force || "") === "1";
    const driver_tf = normalizeDriverTf(req.query.driver_tf);

    const querySymbols = normalizeSymbols(req.query.symbols);
    const envSymbols = normalizeSymbols(process.env.DEFAULT_SYMBOLS);
    const symbols =
      querySymbols.length > 0
        ? querySymbols
        : envSymbols.length > 0
        ? envSymbols
        : ["BTCUSDT", "ETHUSDT", "LDOUSDT"];

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https")
      .split(",")[0]
      .trim();

    const multiUrl =
      `${proto}://${host}/api/multi` +
      `?symbols=${encodeURIComponent(symbols.join(","))}` +
      `&driver_tf=${driver_tf}`;

    const r = await fetch(multiUrl, { headers: { "Cache-Control": "no-store" } });
    const j = await r.json().catch(() => null);

    if (!r.ok || !j?.ok) {
      return res.status(500).json({ ok: false, error: "multi fetch failed", detail: j });
    }

    const now = Date.now();
    const triggered = [];

    for (const item of j.results || []) {
      if (!item?.ok) continue;

      const sym = item.symbol;
      const d5 = item.deltas?.["5m"];
      const d15 = item.deltas?.["15m"];

      if (!d5 || !d15) continue;

      let shouldAlert = false;
      let reason = "";

      // 1️⃣ Setup Flip (15m state change)
      const stateKey = `alert:last15mState:${sym}`;
      const prevState = await redis.get(stateKey);
      if (prevState && prevState !== d15.state) {
        shouldAlert = true;
        reason = `15m flip ${prevState} → ${d15.state}`;
      }

      // 2️⃣ Momentum Confirmation
      if (
        !shouldAlert &&
        d5.lean === d15.lean &&
        Math.abs(d5.price_change_pct || 0) >= 0.10
      ) {
        shouldAlert = true;
        reason = "5m + 15m momentum alignment";
      }

      // 3️⃣ Positioning Shock
      if (
        !shouldAlert &&
        Math.abs(d15.oi_change_pct || 0) >= 0.5 &&
        Math.abs(d15.price_change_pct || 0) >= 0.2
      ) {
        shouldAlert = true;
        reason = "15m positioning expansion";
      }

      // 4️⃣ Cooldown
      const lastSentKey = `alert:lastSent:${sym}`;
      const lastSentRaw = await redis.get(lastSentKey);
      const lastSent = lastSentRaw ? Number(lastSentRaw) : 0;

      if (!force && shouldAlert && now - lastSent < COOLDOWN_MS) {
        shouldAlert = false;
      }

      if (force) {
        shouldAlert = true;
        reason = "manual override";
      }

      if (shouldAlert) {
        await redis.set(stateKey, d15.state);
        await redis.set(lastSentKey, String(now));

        triggered.push({
          symbol: sym,
          price: item.price,
          reason,
          d5,
          d15,
        });
      }
    }

    if (triggered.length === 0) {
      return res.status(200).json({
        ok: true,
        sent: false,
        message: "No triggers",
      });
    }

    // Build DM
    const lines = [];
    lines.push(`ALERT (${driver_tf})`);
    lines.push(new Date(j.ts).toISOString());
    lines.push("");

    for (const t of triggered) {
      lines.push(
        [
          `${t.symbol} $${t.price}`,
          t.reason,
          `5m p=${fmtPct(t.d5.price_change_pct)} oi=${fmtPct(t.d5.oi_change_pct)}`,
          `15m p=${fmtPct(t.d15.price_change_pct)} oi=${fmtPct(t.d15.oi_change_pct)}`,
        ].join(" | ")
      );
    }

    const text = lines.join("\n");
    const tg = await sendTelegram(text);

    if (!tg.ok) {
      return res.status(500).json({ ok: false, error: tg.error, detail: tg.detail });
    }

    return res.status(200).json({
      ok: true,
      sent: true,
      triggered: triggered.map((t) => t.symbol),
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(err?.message || err),
    });
  }
}