import { parseEventLogs, type Address, type Hex } from "viem";
import { curveAbi, tokenAbi } from "../abi/pons.js";
import { ZERO, fastClient, publicClient } from "../chain.js";
import { minOutFromRate, quoteBuy, quoteSell, readCurveState, type CurveState } from "../pons/curve.js";
import { requireAccount, walletClient } from "./wallet.js";

/**
 * Pre-graduation venue: the bonding curve itself. Quote first, then either report (dry run) or sign and send.
 * Nothing here retries a send; a failed transaction is a decision for the caller.
 */

export interface BuyResult { dryRun: boolean; venue: "curve" | "pool"; ethIn: bigint; tokensQuoted: bigint; minOut: bigint; tokensOut?: bigint; hash?: Hex; gasUsed?: bigint }
export interface SellResult { dryRun: boolean; venue: "curve" | "pool"; tokensIn: bigint; ethQuoted: bigint; minOut: bigint; ethOut?: bigint; hash?: Hex; gasUsed?: bigint }

export async function buyOnCurve(curve: Address, ethIn: bigint, slippageBps: number, dryRun: boolean, state?: CurveState): Promise<BuyResult> {
  const recipient = dryRun ? ZERO : requireAccount().address;
  const s = state ?? (await readCurveState(curve, recipient === ZERO ? undefined : recipient, fastClient));
  const q = quoteBuy(s, ethIn);
  const minOut = minOutFromRate(q.tokensOut, slippageBps);
  const base: BuyResult = { dryRun, venue: "curve", ethIn, tokensQuoted: q.tokensOut, minOut };
  if (dryRun) return base;
  const hash = await walletClient().writeContract({ address: curve, abi: curveAbi, functionName: "buy", args: [ethIn, minOut, recipient], value: ethIn });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`buy reverted: ${hash}`);
  const buys = parseEventLogs({ abi: curveAbi, logs: rc.logs, eventName: "CurveBuy" });
  return { ...base, tokensOut: buys.reduce((a, b) => a + b.args.tokensOut, 0n), hash, gasUsed: rc.gasUsed };
}

export async function ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<Hex | null> {
  const owner = requireAccount().address;
  const current = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [owner, spender] });
  if (current >= amount) return null;
  const hash = await walletClient().writeContract({ address: token, abi: tokenAbi, functionName: "approve", args: [spender, (1n << 256n) - 1n] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function sellOnCurve(curve: Address, token: Address, tokensIn: bigint, slippageBps: number, dryRun: boolean): Promise<SellResult> {
  const s = await readCurveState(curve, undefined, fastClient);
  if (s.graduated || s.readyToGraduate) throw new Error("curve is closed (graduated or ready to graduate); sell on the pool instead");
  const ethQuoted = quoteSell(s, tokensIn);
  const minOut = minOutFromRate(ethQuoted, slippageBps);
  const base: SellResult = { dryRun, venue: "curve", tokensIn, ethQuoted, minOut };
  if (dryRun) return base;
  await ensureAllowance(token, curve, tokensIn);
  const hash = await walletClient().writeContract({ address: curve, abi: curveAbi, functionName: "sell", args: [tokensIn, minOut, requireAccount().address] });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`sell reverted: ${hash}`);
  const sells = parseEventLogs({ abi: curveAbi, logs: rc.logs, eventName: "CurveSell" });
  return { ...base, ethOut: sells.reduce((a, b) => a + b.args.quoteOut, 0n), hash, gasUsed: rc.gasUsed };
}
