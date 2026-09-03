/** Optional Telegram alerts through the Bot API. Silent when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset. */
export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Formats engine events the way a phone wants them: one line, numbers first. */
export async function notify(e: Record<string, unknown>): Promise<void> {
  if (e.kind === "fire") {
    const ethIn = Number(BigInt(String(e.ethIn))) / 1e18;
    await sendTelegram(`bodkin ${e.live ? "FIRE" : "fire (dry)"} ${e.symbol}: ${ethIn} ETH at tax ${Number(e.taxBps) / 100}% after ${e.waitedMs} ms\nhttps://robinhoodchain.blockscout.com/token/${e.token}`);
  } else if (e.kind === "exit") {
    const out = Number(BigInt(String(e.ethOut))) / 1e18;
    await sendTelegram(`bodkin exit ${e.symbol}: ${out.toFixed(4)} ETH (${Number(e.pnlPct) >= 0 ? "+" : ""}${Number(e.pnlPct).toFixed(1)}%) on ${e.venue}, ${e.reason}`);
  }
}
