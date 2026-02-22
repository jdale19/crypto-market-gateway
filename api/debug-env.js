export default function handler(req, res) {
  const t = process.env.TELEGRAM_BOT_TOKEN || "";
  const c = process.env.TELEGRAM_CHAT_ID || "";
  res.status(200).json({
    ok: true,
    has_token: t.length > 0,
    token_len: t.length,
    token_prefix: t.slice(0, 4),
    has_chat_id: c.length > 0,
    chat_id_len: c.length,
  });
}