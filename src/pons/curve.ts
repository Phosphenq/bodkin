import type { Address, PublicClient } from "viem";
import { curveAbi, BPS } from "../abi/pons.js";
import { publicClient } from "../chain.js";

/**
 * Curve pricing in the protocol's integer order. Fees come off the input on a buy
 * and off the output on a sell; the opening tax only ever applies to buys.
 * Mirrors PonsV2BondingCurve.buy/sell (contractsV2/src/v2/PonsV2BondingCurve.sol).
 */

export const amountOut = (inAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint =>
  (inAmount * reserveOut) / (reserveIn + inAmount);

export const amountIn = (outAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint =>
  (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface CurveState {
  quoteReserve: bigint; // includes the phantom reserve
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  sellableTokens: bigint;
  reservedTokens: bigint;
  graduationThreshold: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  openingTaxBps: bigint;
  graduated: boolean;
  readyToGraduate: boolean;
  launchedAt: number;
  readAtMs: number;
}

export async function readCurveState(
  curve: Address,
  recipient: Address = "0x000000000000000000000000000000000000dEaD",
  client: PublicClient = publicClient,
): Promise<CurveState> {
  const c = { address: curve, abi: curveAbi } as const;
  const [reserves, real, sellable, reserved, threshold, feeBps, creatorTaxBps, opening, graduated, ready, launchedAt] =
    await Promise.all([
      client.readContract({ ...c, functionName: "getReserves" }),
      client.readContract({ ...c, functionName: "realQuoteReserve" }),
      client.readContract({ ...c, functionName: "sellableTokens" }),
      client.readContract({ ...c, functionName: "reservedTokens" }),
      client.readContract({ ...c, functionName: "graduationThreshold" }),
      client.readContract({ ...c, functionName: "feeBps" }),
      client.readContract({ ...c, functionName: "creatorTaxBps" }),
      client.readContract({ ...c, functionName: "currentSnipeTaxBps", args: [recipient] }).catch(() => 0n),
      client.readContract({ ...c, functionName: "graduated" }),
      client.readContract({ ...c, functionName: "readyToGraduate" }),
      client.readContract({ ...c, functionName: "launchedAt" }).catch(() => 0n),
    ]);
  return {
    quoteReserve: reserves[0],
    tokenReserve: reserves[1],
    realQuoteReserve: real,
    sellableTokens: sellable,
    reservedTokens: reserved,
    graduationThreshold: threshold,
    feeBps,
    creatorTaxBps,
    openingTaxBps: opening,
    graduated,
    readyToGraduate: ready,
    launchedAt: Number(launchedAt),
    readAtMs: Date.now(),
  };
}

/** The opening tax is capped so a buyer always nets at least 1% of the spend. */
export function effectiveOpeningBps(s: Pick<CurveState, "openingTaxBps" | "feeBps" | "creatorTaxBps">): bigint {
  if (s.openingTaxBps <= 0n) return 0n;
  const max = BPS - s.feeBps - s.creatorTaxBps - 100n;
  return s.openingTaxBps > max ? max : s.openingTaxBps;
}

export interface BuyQuote {
  tokensOut: bigint;
  spent: bigint;
  refund: bigint;
  totalInputBps: bigint;
  clamped: boolean;
}

export function quoteBuy(s: CurveState, quoteIn: bigint): BuyQuote {
  const openBps = effectiveOpeningBps(s);
  let spent = quoteIn;
  const fee = (spent * s.feeBps) / BPS;
  const tax = (spent * s.creatorTaxBps) / BPS;
  const opening = (spent * openBps) / BPS;
  let tokensOut = amountOut(spent - fee - tax - opening, s.quoteReserve, s.tokenReserve);
  let clamped = false;
  if (tokensOut > s.sellableTokens) {
    clamped = true;
    tokensOut = s.sellableTokens;
    const net = amountIn(s.sellableTokens, s.quoteReserve, s.tokenReserve);
    const grossed = ceilDiv(net * BPS, BPS - s.feeBps - s.creatorTaxBps - openBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
  }
  return { tokensOut, spent, refund: quoteIn - spent, totalInputBps: s.feeBps + s.creatorTaxBps + openBps, clamped };
}

export function quoteSell(
  s: Pick<CurveState, "quoteReserve" | "tokenReserve" | "feeBps" | "creatorTaxBps">,
  tokensIn: bigint,
): bigint {
  const gross = amountOut(tokensIn, s.tokenReserve, s.quoteReserve);
  const fee = (gross * s.feeBps) / BPS;
  const tax = (gross * s.creatorTaxBps) / BPS;
  return gross - fee - tax;
}

/** minTokensOut bounds the rate, not the quantity: a clamped fill at the accepted rate still settles. */
export function minOutFromRate(quote: bigint, slippageBps: number): bigint {
  return (quote * (BPS - BigInt(slippageBps))) / BPS;
}

/** Marginal price of one whole token in quote units (float, display only). */
export function spotPrice(s: Pick<CurveState, "quoteReserve" | "tokenReserve">): number {
  if (s.tokenReserve === 0n) return 0;
  return Number(s.quoteReserve) / Number(s.tokenReserve);
}

/** Fully diluted value in quote units for the launch supply at the marginal price. */
export function fdvQuote(s: Pick<CurveState, "quoteReserve" | "tokenReserve">, supply = 1_000_000_000n * 10n ** 18n): number {
  return spotPrice(s) * (Number(supply) / 1e18);
}

/** 0..1 progress along the curve toward graduation. */
export function progress(s: Pick<CurveState, "realQuoteReserve" | "graduationThreshold">): number {
  if (s.graduationThreshold === 0n) return 0;
  const p = Number(s.realQuoteReserve) / Number(s.graduationThreshold);
  return p > 1 ? 1 : p;
}
