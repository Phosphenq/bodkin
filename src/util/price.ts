/** ETH/USD for display only. CoinGecko free endpoint, cached 60 s, null when offline. */
let cached: { value: number; at: number } | null = null;

export async function ethUsd(): Promise<number | null> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(t);
    if (!r.ok) return cached?.value ?? null;
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    const v = j.ethereum?.usd;
    if (typeof v === "number" && v > 0) {
      cached = { value: v, at: Date.now() };
      return v;
    }
  } catch {
    /* offline or rate-limited: keep the last value */
  }
  return cached?.value ?? null;
}

export const toUsd = (ethAmount: number, price: number | null): number | null => (price === null ? null : ethAmount * price);
