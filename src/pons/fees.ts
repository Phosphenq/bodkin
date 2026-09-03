import { parseAbiItem, type Address } from "viem";
import { escrowAbi } from "../abi/pons.js";
import { ADDR, publicClient } from "../chain.js";

const CREDITED = parseAbiItem("event Credited(address indexed recipient, address indexed depositor, uint256 amount)");
const CLAIMED = parseAbiItem("event Claimed(address indexed recipient, uint256 amount)");

export interface Claim { amount: bigint; block: bigint; timestamp: number; tx: `0x${string}` }

export interface FeeForensics {
  recipient: Address;
  /** Credits whose depositor is this token's curve (pre-graduation trading). */
  curveCredited: bigint;
  curveCredits: number;
  /** Credits from the shared v4 hook: every graduated pool of this recipient, not only this token. */
  poolCredited: bigint;
  poolCredits: number;
  totalCredited: bigint;
  claims: Claim[];
  totalClaimed: bigint;
  pending: bigint;
  firstCreditBlock: bigint | null;
  lastCreditBlock: bigint | null;
}

/** Who gets paid for a token and what they have taken out. All from the escrow's own event log. */
export async function feeForensics(recipient: Address, curve: Address, fromBlock: bigint): Promise<FeeForensics> {
  const head = await publicClient.getBlockNumber();
  const step = 1_000_000n;
  const out: FeeForensics = {
    recipient, curveCredited: 0n, curveCredits: 0, poolCredited: 0n, poolCredits: 0, totalCredited: 0n,
    claims: [], totalClaimed: 0n, pending: 0n, firstCreditBlock: null, lastCreditBlock: null,
  };
  const curveLc = curve.toLowerCase();
  for (let b = fromBlock; b <= head; b += step) {
    const to = b + step - 1n > head ? head : b + step - 1n;
    const [credits, claims] = await Promise.all([
      publicClient.getLogs({ address: ADDR.ponsEscrow, event: CREDITED, args: { recipient }, fromBlock: b, toBlock: to }),
      publicClient.getLogs({ address: ADDR.ponsEscrow, event: CLAIMED, args: { recipient }, fromBlock: b, toBlock: to }),
    ]);
    for (const l of credits) {
      const amt = l.args.amount ?? 0n;
      const dep = (l.args.depositor ?? "").toLowerCase();
      if (dep === curveLc) { out.curveCredited += amt; out.curveCredits++; } else { out.poolCredited += amt; out.poolCredits++; }
      out.totalCredited += amt;
      if (l.blockNumber !== null) {
        if (out.firstCreditBlock === null || l.blockNumber < out.firstCreditBlock) out.firstCreditBlock = l.blockNumber;
        if (out.lastCreditBlock === null || l.blockNumber > out.lastCreditBlock) out.lastCreditBlock = l.blockNumber;
      }
    }
    for (const l of claims) {
      if (l.blockNumber === null || !l.transactionHash) continue;
      out.claims.push({ amount: l.args.amount ?? 0n, block: l.blockNumber, timestamp: 0, tx: l.transactionHash });
      out.totalClaimed += l.args.amount ?? 0n;
    }
  }
  // timestamps for the claims (batched reads; cap so a busy recipient does not cost hundreds of calls)
  const stamped = out.claims.slice(0, 60);
  const blocks = await Promise.all(stamped.map((c) => publicClient.getBlock({ blockNumber: c.block })));
  blocks.forEach((blk, i) => { stamped[i].timestamp = Number(blk.timestamp); });
  out.pending = await publicClient.readContract({ address: ADDR.ponsEscrow, abi: escrowAbi, functionName: "balanceOf", args: [recipient] });
  return out;
}
