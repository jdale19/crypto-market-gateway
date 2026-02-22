// /api/debug-env.js
export default async function handler(req, res) {
  // Optional simple protection
  const secret = process.env.DEBUG_SECRET;
  if (secret && req.query.key !== secret) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const hasToken = !!token;

  let telegramStatus = null;

  if (hasToken) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const j = await r.json();
      telegramStatus = {
        ok: j?.ok === true,
        username: j?.result?.username || null,
        id: j?.result?.id || null,
      };
    } catch (e) {
      telegramStatus = {
        ok: false,
        error: "telegram_fetch_failed",
      };
    }
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    has_token: hasToken,
    telegram: telegramStatus,
  });
}