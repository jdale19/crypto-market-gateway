export default async function handler(req, res) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return res.status(500).json({ ok: false, error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" });
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "Test message from Vercel ✅" }),
    });

    const tgJson = await tgRes.json();
    return res.status(200).json({ ok: true, telegram: tgJson });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Telegram test failed", detail: String(err?.message || err) });
  }
}