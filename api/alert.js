// /api/alert.js
// Pulls /api/multi and (optionally) sends a Telegram DM summary.
//
// Env vars required:
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
// Optional:
// - DEFAULT_SYMBOLS (same as multi.js)
//
// Behavior:
// - Default: ONLY sends when "hits" meet alert rules.
// - Manual override: add &force=1 to always send.
// - Cooldown: prevents repeat sends within COOLDOWN_SECONDS (even with force=1).

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---- EASY KNOBS (edit later) ----
const COOLDOWN_SECONDS = 5 * 60; // 5 minutes
const ALLOWED_TFS = new Set(["5m", "15m", "30m", "1h", "4h"]);

// Alert rule (simple + modifiable):
// Fire when driver timeframe is NOT warmup AND state is opening AND both |price%| and |oi%| >= thresholds.
const RULES = {
  min_abs_price_pct: 0.08, // 0.08% (tune later)
  min_abs_oi_pct: 0.08,    // 0.08% (tune later)
  allowed_states: new Set(["longs opening", "shorts opening"]),
};
// ---------------------------------

function normalizeSymbols(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeDriverTf(raw) {
  const tf = String(raw || "5m").toLowerCase();
  return ALLOWED_TFS.has(tf) ? tf : "5m";
}

function absNum(x) {
  return x == null || !Number.isFinite(x) ? null : Math.abs(x);
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

function pickHits(results, driver_tf) {
  const hits = [];
  for (const item of results || []) {
    if (!item?.ok) continue;

    const d = item.deltas?.[driver_tf];
    if (!d || d.warmup) continue;

    const ap = absNum(d.price_change_pct);
    const ao = absNum(d.oi_change_pct);

    if (!RULES.allowed_states.has(d.state)) continue;
    if (ap == null || ao == null) continue;
    if (ap < RULES.min_abs_price_pct) continue;
    if (ao < RULES.min_abs_oi_pct) continue;

    hits.push(item);
  }
  return hits;
}

export default async function handler(req, res) {
  try {
    // ---- symbols fallback (fixed: [] truthy) ----
    const querySymbols = normalizeSymbols(req.query.symbols);
    const envSymbols = normalizeSymbols(process.env.DEFAULT_SYMBOLS);
    const symbols =
      querySymbols.length > 0 ? querySymbols : envSymbols.length > 0 ? envSymbols : ["BTCUSDT", "ETHUSDT", "LDOUSDT"];

    const driver_tf = normalizeDriverTf(req.query.driver_tf);
    const debug = String(req.query.debug || "") === "1";
    const force = String(req.query.force || "") === "1";

    // ---- cooldown gate (this is what you expected) ----
    const chatId = process.env.TELEGRAM_CHAT_ID || "nochat";
    const cooldownKey = `alert:lastSent:${chatId}:${driver_tf}`;
    const now = Date.now();

    const lastRaw = await redis.get(cooldownKey);
    const last = lastRaw == null ? null : Number(lastRaw);
    if (Number.isFinite(last)) {
      const ageSec = (now - last) / 1000;
      if (ageSec < COOLDOWN_SECONDS) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({
          ok: true,
          sent: false,
          reason: "cooldown",
          cooldown_seconds: COOLDOWN_SECONDS,
          seconds_since_last: Number(ageSec.toFixed(1)),
          symbols,
          driver_tf,
        });
      }
    }

    // ---- build /api/multi URL ----
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();

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

    const hits = pickHits(j.results, driver_tf);

    // If not forced and no hits, don't send.
    if (!force && hits.length === 0) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        sent: false,
        reason: "no_hits",
        symbols,
        driver_tf,
        multiUrl,
        rule: {
          min_abs_price_pct: RULES.min_abs_price_pct,
          min_abs_oi_pct: RULES.min_abs_oi_pct,
          allowed_states: Array.from(RULES.allowed_states),
        },
      });
    }

    // ---- send DM (only hits unless forced) ----
    const lines = [];
    lines.push(`OKX perps alert (${driver_tf})`);
    lines.push(new Date(j.ts).toISOString());
    lines.push("");

    const list = hits.length > 0 ? hits : j.results || [];
    for (const item of list) {
      if (!item?.ok) {
        lines.push(`${item?.symbol || "?"}: error (${item?.error || "unknown"})`);
        continue;
      }

      const d = item.deltas?.[driver_tf];
      lines.push(
        [
          `${item.symbol} $${item.price}`,
          `state=${d?.state || item.state}/${d?.lean || item.lean}`,
          `${driver_tf} p=${fmtPct(d?.price_change_pct)} oi=${fmtPct(d?.oi_change_pct)}`,
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
        sent: false,
        error: tg.error,
        detail: tg.detail || null,
        symbols,
        driver_tf,
        multiUrl,
      });
    }

    // Record cooldown *after* successful send
    await redis.set(cooldownKey, String(now));
    await redis.expire(cooldownKey, COOLDOWN_SECONDS * 2);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      sent: true,
      reason: force ? "forced" : "hits",
      hits: hits.map((x) => x.symbol),
      symbols,
      driver_tf,
      multiUrl,
      cooldown_seconds: COOLDOWN_SECONDS,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(err?.message || err) });
  }
}