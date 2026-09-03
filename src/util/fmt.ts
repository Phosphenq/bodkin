import { formatEther } from "viem";

export const short = (a: string, n = 4): string => (a.length > 2 * n + 2 ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : a);

export function eth(wei: bigint, digits = 4): string {
  const v = Number(formatEther(wei));
  if (v === 0) return "0";
  if (v < 0.0001) return v.toExponential(2);
  return v.toFixed(v < 1 ? digits : 3).replace(/\.?0+$/, "");
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export const pct = (x: number, digits = 1): string => `${(x * 100).toFixed(digits)}%`;
export const bps = (b: bigint | number): string => `${(Number(b) / 100).toFixed(Number(b) % 100 === 0 ? 0 : 2)}%`;

/** Whole tokens (18 decimals) as a compact number: 30.0M, 1.2B. */
export function tokens(amount: bigint): string {
  const v = Number(amount) / 1e18;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function ago(tsSec: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.floor(now - tsSec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m ${d % 60}s`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
  return `${Math.floor(d / 86400)}d ${Math.floor((d % 86400) / 3600)}h`;
}

export const hhmmss = (tsSec = Date.now() / 1000): string =>
  new Date(tsSec * 1000).toISOString().slice(11, 19);

export const iso = (tsSec: number): string => new Date(tsSec * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";

export const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
export const lpad = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);
