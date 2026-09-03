import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";

export interface Exit { at: number; tokens: string; ethOut: string; reason: string; tx?: Hex; dryRun: boolean }

export interface Position {
  id: string;
  token: Address;
  curve: Address;
  symbol: string;
  name: string;
  openedAt: number;
  entryTx?: Hex;
  dryRun: boolean;
  /** ETH spent (wei, as decimal string for JSON). */
  entryEth: string;
  /** Tokens held (wei). */
  tokens: string;
  /** Highest ETH valuation seen (wei). */
  peakEth: string;
  lastEth: string;
  lastAt: number;
  status: "open" | "closed";
  exits: Exit[];
}

const FILE = resolve(process.cwd(), "data", "positions.json");

export function loadPositions(): Position[] {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, "utf8")) as Position[]; } catch { return []; }
}

export function savePositions(list: Position[]): void {
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

export function openPosition(p: Omit<Position, "id" | "status" | "exits" | "peakEth" | "lastEth" | "lastAt">): Position {
  const list = loadPositions();
  const pos: Position = { ...p, id: `${p.token.toLowerCase()}-${p.openedAt}`, status: "open", exits: [], peakEth: p.entryEth, lastEth: p.entryEth, lastAt: p.openedAt };
  list.push(pos);
  savePositions(list);
  return pos;
}

export function updatePosition(id: string, patch: Partial<Position>): Position | null {
  const list = loadPositions();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  savePositions(list);
  return list[i];
}

export const openPositions = (): Position[] => loadPositions().filter((p) => p.status === "open");

export interface ExitRules { takeProfitPct: number; stopLossPct: number; trailingPct: number; maxHoldMin: number }

/** Why a position should close now, or null to keep holding. Pure function; the caller supplies the live valuation. */
export function exitReason(pos: Position, valueEth: bigint, rules: ExitRules, nowSec = Math.floor(Date.now() / 1000)): string | null {
  const entry = BigInt(pos.entryEth);
  if (entry === 0n) return null;
  const peak = BigInt(pos.peakEth) > valueEth ? BigInt(pos.peakEth) : valueEth;
  const pct = (a: bigint, b: bigint) => Number((a * 10_000n) / b) / 100;
  const gain = pct(valueEth, entry) - 100;
  if (gain >= rules.takeProfitPct) return `take profit ${gain.toFixed(1)}% ≥ ${rules.takeProfitPct}%`;
  if (gain <= -rules.stopLossPct) return `stop loss ${gain.toFixed(1)}% ≤ -${rules.stopLossPct}%`;
  if (peak > entry) {
    const fromPeak = 100 - pct(valueEth, peak);
    if (fromPeak >= rules.trailingPct) return `trailing stop, ${fromPeak.toFixed(1)}% below peak (${(pct(peak, entry) - 100).toFixed(1)}% high)`;
  }
  if (nowSec - pos.openedAt >= rules.maxHoldMin * 60) return `max hold ${rules.maxHoldMin} min reached at ${gain.toFixed(1)}%`;
  return null;
}
