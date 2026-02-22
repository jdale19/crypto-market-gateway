export default async function handler(req, res) {
  const t = process.env.TELEGRAM_BOT_TOKEN || "";
  const url = t ? `https://api.telegram.org/bot${t}/getMe` : null;

  let tg = null;
  if (url) {
    try {
      const r = await fetch(url);
      tg = await r.json();
    } catch (e) {
      tg = { ok: false, error: "fetch_failed", detail: String(e?.message || e) };
    }
  }

  res.status(200).json({
    ok: true,
    has_token: t.length > 0,
    token_len: t.length,
    token_prefix: t.slice(0, 8), // still safe-ish; doesn't reveal full token
    telegram_getMe: tg,
  });
}