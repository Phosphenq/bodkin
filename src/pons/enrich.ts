import { decodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import { curveAbi, factoryAbi, routerAbi, tokenAbi, SELECTOR, SUPPLY, TOPIC } from "../abi/pons.js";
import { ADDR, ZERO, publicClient } from "../chain.js";
import type { CurveState } from "./curve.js";
import type { LaunchEvent } from "./launches.js";

export interface TokenMeta {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
}

export interface LaunchRecord {
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  phase: number; // 0 curve, 1 swept, 2 pool, 3 rescued
  poolFee: number;
  tickSpacing: number;
  buybackEnabled: boolean;
}

export interface LaunchTx {
  from: Address;
  to: Address;
  valueWei: bigint;
  /** Quote asset the launcher spent on its own first buy (0 when launched without a buy). */
  devBuyWei: bigint;
  /** Tokens the launcher received in the launch transaction. */
  devTokens: bigint;
  /** Addresses declared exempt from the opening tax at launch (the declared bundle). */
  exemptions: Address[];
  recipient: Address;
  timestamp: number;
}

export interface PairInfo { address: Address; symbol: string; decimals: number; /** 1 for stables, null when unknown */ usdPerUnit: number | null }

export interface LaunchIntel {
  ev: LaunchEvent;
  meta: TokenMeta | null;
  record: LaunchRecord | null;
  tx: LaunchTx | null;
  curve: CurveState | null;
  pair: PairInfo;
  errors: string[];
}

const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const ETH_PAIR: PairInfo = { address: ZERO, symbol: "ETH", decimals: 18, usdPerUnit: null };
const pairCache = new Map<string, PairInfo>();
const STABLES = new Set(["USDG", "USDC", "USDT", "USDC.E", "DAI"]);

/** Symbol and decimals of the asset a curve trades in. ETH is the common case; stables and stock tokens exist. */
export async function readPairInfo(pairToken: Address): Promise<PairInfo> {
  if (pairToken === ZERO) return ETH_PAIR;
  const k = pairToken.toLowerCase();
  const hit = pairCache.get(k);
  if (hit) return hit;
  const t = { address: pairToken, abi: tokenAbi } as const;
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ ...t, functionName: "symbol" }).catch(() => "?"),
    publicClient.readContract({ ...t, functionName: "decimals" }).catch(() => 18),
  ]);
  const info: PairInfo = { address: pairToken, symbol, decimals: Number(decimals), usdPerUnit: STABLES.has(symbol.toUpperCase()) ? 1 : null };
  pairCache.set(k, info);
  return info;
}

/**
 * Token metadata + factory record + curve state in ONE eth_call through Multicall3.
 * Each field degrades to null on its own so one reverting getter never hides the rest.
 */
export async function readLaunchBundle(ev: LaunchEvent, recipient: Address = DEAD): Promise<{ meta: TokenMeta | null; record: LaunchRecord | null; curve: CurveState | null; errors: string[] }> {
  const t = { address: ev.token, abi: tokenAbi } as const;
  const c = { address: ev.curve, abi: curveAbi } as const;
  const r = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { ...t, functionName: "name" },
      { ...t, functionName: "symbol" },
      { ...t, functionName: "getTokenInfo" },
      { address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [ev.token] },
      { ...c, functionName: "getReserves" },
      { ...c, functionName: "realQuoteReserve" },
      { ...c, functionName: "sellableTokens" },
      { ...c, functionName: "reservedTokens" },
      { ...c, functionName: "graduationThreshold" },
      { ...c, functionName: "feeBps" },
      { ...c, functionName: "creatorTaxBps" },
      { ...c, functionName: "currentSnipeTaxBps", args: [recipient] },
      { ...c, functionName: "graduated" },
      { ...c, functionName: "readyToGraduate" },
      { ...c, functionName: "launchedAt" },
    ],
  });
  const errors: string[] = [];
  const ok = <T,>(i: number): T | null => (r[i].status === "success" ? (r[i].result as T) : null);

  let meta: TokenMeta | null = null;
  const name = ok<string>(0), symbol = ok<string>(1), info = ok<readonly [Address, string, string, TokenMeta["socials"]]>(2);
  if (name !== null && symbol !== null && info) meta = { name, symbol, logo: info[1], description: info[2], socials: { ...info[3] } };
  else errors.push("token metadata unreadable");

  let record: LaunchRecord | null = null;
  const rec = ok<{ creatorFeeRecipient: Address; creatorTaxBps: number; phase: number; poolFee: number; tickSpacing: number; buybackEnabled: boolean; exists: boolean }>(3);
  if (rec?.exists) record = { creatorFeeRecipient: rec.creatorFeeRecipient, creatorTaxBps: Number(rec.creatorTaxBps), phase: Number(rec.phase), poolFee: Number(rec.poolFee), tickSpacing: Number(rec.tickSpacing), buybackEnabled: rec.buybackEnabled };
  else errors.push("factory record unreadable");

  let curve: CurveState | null = null;
  const reserves = ok<readonly [bigint, bigint]>(4);
  if (reserves && r[6].status === "success" && r[9].status === "success") {
    curve = {
      quoteReserve: reserves[0],
      tokenReserve: reserves[1],
      realQuoteReserve: ok<bigint>(5) ?? 0n,
      sellableTokens: ok<bigint>(6) ?? 0n,
      reservedTokens: ok<bigint>(7) ?? 0n,
      graduationThreshold: ok<bigint>(8) ?? ev.graduationThreshold,
      feeBps: ok<bigint>(9) ?? 100n,
      creatorTaxBps: ok<bigint>(10) ?? 0n,
      openingTaxBps: ok<bigint>(11) ?? 0n,
      graduated: ok<boolean>(12) ?? false,
      readyToGraduate: ok<boolean>(13) ?? false,
      launchedAt: Number(ok<bigint>(14) ?? 0n),
      readAtMs: Date.now(),
    };
  } else errors.push("curve state unreadable");
  return { meta, record, curve, errors };
}

export async function readTokenMeta(token: Address): Promise<TokenMeta> {
  const t = { address: token, abi: tokenAbi } as const;
  const [name, symbol, info] = await Promise.all([
    publicClient.readContract({ ...t, functionName: "name" }),
    publicClient.readContract({ ...t, functionName: "symbol" }),
    publicClient.readContract({ ...t, functionName: "getTokenInfo" }),
  ]);
  const [, logo, description, socials] = info;
  return { name, symbol, logo, description, socials: { ...socials } };
}

export async function readLaunchRecord(token: Address): Promise<LaunchRecord | null> {
  const r = await publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!r.exists) return null;
  return { creatorFeeRecipient: r.creatorFeeRecipient, creatorTaxBps: Number(r.creatorTaxBps), phase: Number(r.phase), poolFee: Number(r.poolFee), tickSpacing: Number(r.tickSpacing), buybackEnabled: r.buybackEnabled };
}

/** What the launcher did in the launch transaction: how much it bought, for whom, which wallets it exempted. */
export async function readLaunchTx(ev: LaunchEvent): Promise<LaunchTx> {
  const [tx, receipt, block] = await Promise.all([
    publicClient.getTransaction({ hash: ev.txHash }),
    publicClient.getTransactionReceipt({ hash: ev.txHash }),
    publicClient.getBlock({ blockNumber: ev.blockNumber }),
  ]);
  let devBuyWei = 0n;
  let exemptions: Address[] = [];
  let recipient: Address = tx.from;
  if (tx.input.startsWith(SELECTOR.launchAndBuy)) {
    try {
      const d = decodeFunctionData({ abi: routerAbi, data: tx.input });
      if (d.functionName === "launchAndBuy") {
        const [, , , quoteIn, , rcpt, ex] = d.args;
        devBuyWei = quoteIn;
        recipient = rcpt;
        exemptions = [...ex];
      }
    } catch { /* unknown encoding: fall through to the event-derived numbers */ }
  }
  // The curve's own CurveBuy events in the launch transaction are the ground truth for what the
  // launcher bought and paid, whichever contract path (router, factory, bundler) created the token.
  let devTokens = 0n;
  let spentInTx = 0n;
  const buys = parseEventLogs({ abi: curveAbi, logs: receipt.logs, eventName: "CurveBuy" });
  for (const b of buys) if (b.address.toLowerCase() === ev.curve.toLowerCase()) { devTokens += b.args.tokensOut; spentInTx += b.args.quoteIn; }
  if (devBuyWei === 0n) devBuyWei = spentInTx;
  return { from: tx.from, to: (tx.to ?? ZERO) as Address, valueWei: tx.value, devBuyWei, devTokens, exemptions, recipient, timestamp: Number(block.timestamp) };
}

export interface CurveActivity {
  buys: number;
  sells: number;
  uniqueBuyers: number;
  taxedBuys: number;
  quoteIn: bigint;
  quoteOut: bigint;
  lastBlock: bigint;
}

/** Trades on a curve since `fromBlock`: who bought, who paid the opening tax, net flow. */
export async function curveActivity(curve: Address, fromBlock: bigint, toBlock: bigint | "latest" = "latest"): Promise<CurveActivity> {
  const logs = await publicClient.getLogs({ address: curve, fromBlock, toBlock });
  const out: CurveActivity = { buys: 0, sells: 0, uniqueBuyers: 0, taxedBuys: 0, quoteIn: 0n, quoteOut: 0n, lastBlock: fromBlock };
  const buyers = new Set<string>();
  const decoded = parseEventLogs({ abi: curveAbi, logs });
  for (const l of decoded) {
    if (l.blockNumber && l.blockNumber > out.lastBlock) out.lastBlock = l.blockNumber;
    if (l.eventName === "CurveBuy") { out.buys++; buyers.add(l.args.recipient.toLowerCase()); out.quoteIn += l.args.quoteIn; }
    else if (l.eventName === "CurveSell") { out.sells++; out.quoteOut += l.args.quoteOut; }
  }
  for (const l of logs) if (l.topics[0] === TOPIC.snipeTaxCharged) out.taxedBuys++;
  out.uniqueBuyers = buyers.size;
  return out;
}

/** One multicall plus three transaction reads. Every field degrades independently. */
export async function enrichLaunch(ev: LaunchEvent, recipient: Address = DEAD): Promise<LaunchIntel> {
  const errors: string[] = [];
  const guard = async <T,>(label: string, p: Promise<T>): Promise<T | null> => {
    try { return await p; } catch (e) { errors.push(`${label}: ${(e as Error).message.split("\n")[0]}`); return null; }
  };
  const [bundle, tx, pair] = await Promise.all([
    guard("bundle", readLaunchBundle(ev, recipient)),
    guard("tx", readLaunchTx(ev)),
    readPairInfo(ev.pairToken),
  ]);
  if (bundle) errors.push(...bundle.errors);
  return { ev, meta: bundle?.meta ?? null, record: bundle?.record ?? null, tx, curve: bundle?.curve ?? null, pair, errors };
}

export const devSharePct = (tx: LaunchTx | null): number => (tx ? (Number(tx.devTokens) / Number(SUPPLY)) * 100 : 0);

export function hasSocials(meta: TokenMeta | null): { twitter: boolean; website: boolean; telegram: boolean; any: boolean } {
  const s = meta?.socials;
  const twitter = !!s?.twitter?.trim();
  const website = !!s?.website?.trim();
  const telegram = !!s?.telegram?.trim();
  return { twitter, website, telegram, any: twitter || website || telegram };
}

/** Browser-safe view of an IPFS logo reference. */
export function logoUrl(logo: string): string {
  if (!logo) return "";
  if (logo.startsWith("ipfs://")) return `https://www.ponsfamily.com/api/ipfs/content/${logo.slice(7)}?variant=card`;
  return logo;
}

export type { Hex };
