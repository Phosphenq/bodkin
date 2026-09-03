import { parseAbiItem, type Address, type Hex, type Log } from "viem";
import { factoryAbi } from "../abi/pons.js";
import { ADDR, fastClient, publicClient, wsClient } from "../chain.js";
import { envNum } from "../util/env.js";

export interface LaunchEvent {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
  /** Local wall-clock when this process first saw the event. */
  seenAtMs: number;
}

const TOKEN_LAUNCHED = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);

type LaunchedLog = Log<bigint, number, false, typeof TOKEN_LAUNCHED, true>;

function toEvent(l: LaunchedLog): LaunchEvent | null {
  if (!l.transactionHash || l.blockNumber === null || l.logIndex === null) return null;
  const a = l.args;
  if (!a.token || !a.curve || !a.deployer || !a.pairToken) return null;
  return {
    token: a.token,
    curve: a.curve,
    deployer: a.deployer,
    pairToken: a.pairToken,
    launchConfigId: a.launchConfigId ?? 0n,
    graduationThreshold: a.graduationThreshold ?? 0n,
    blockNumber: l.blockNumber,
    txHash: l.transactionHash,
    logIndex: l.logIndex,
    seenAtMs: Date.now(),
  };
}

/**
 * Streams pons v2 launches. WebSocket subscription when RPC_WS_URL is set; otherwise a
 * block-range poll every POLL_MS (default 300 ms, the chain seals a block every ~100 ms).
 * Returns a stop function.
 */
export function watchLaunches(onLaunch: (ev: LaunchEvent) => void, opts: { pollMs?: number } = {}): () => void {
  const seen = new Set<string>();
  const dispatch = (l: LaunchedLog) => {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 20_000) for (const k of seen) { seen.delete(k); if (seen.size <= 10_000) break; }
    const ev = toEvent(l);
    if (ev) onLaunch(ev);
  };

  if (wsClient) {
    return wsClient.watchEvent({
      address: ADDR.ponsFactory,
      event: TOKEN_LAUNCHED,
      onLogs: (logs) => logs.forEach((l) => dispatch(l as LaunchedLog)),
      onError: (err) => console.error("launch subscription error, transport will retry:", err.message),
    });
  }

  const pollMs = opts.pollMs ?? envNum("POLL_MS", 300);
  let last = 0n;
  let stopped = false;
  let inFlight = false;
  let backoff = 0; // grows on 429s, shrinks on success: the poll yields to the endpoint instead of fighting it
  let lastComplaint = 0;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const head = await fastClient.getBlockNumber();
      if (last === 0n) last = head - 1n;
      if (head > last) {
        const from = last + 1n;
        const to = head - from > 2_000n ? from + 2_000n : head; // never let a stall turn into a giant range
        const logs = await fastClient.getLogs({ address: ADDR.ponsFactory, event: TOKEN_LAUNCHED, fromBlock: from, toBlock: to });
        logs.forEach((l) => dispatch(l as LaunchedLog));
        last = to;
      }
      if (backoff > 0) backoff = Math.max(0, backoff - 1);
    } catch (err) {
      // the range is not advanced, so the next tick re-reads it; nothing is lost, only delayed
      backoff = Math.min(6, backoff + 2);
      const msg = (err as { details?: string }).details ?? (err as Error).message;
      if (backoff >= 4 && Date.now() - lastComplaint > 30_000) {
        lastComplaint = Date.now();
        console.error(`poll error: ${msg.split("\n")[0].slice(0, 160)}; polling every ${pollMs * (1 + backoff)} ms until the endpoint recovers`);
      }
    } finally {
      inFlight = false;
      if (!stopped) timer = setTimeout(tick, pollMs * (1 + backoff));
    }
  };
  timer = setTimeout(tick, 0);
  return () => { stopped = true; clearTimeout(timer); };
}

/**
 * Launches in the last `blocks` blocks, chunked so the public RPC never sees a range it dislikes: an unfiltered
 * query returns ~25 launches per 1 000 blocks, so 25k-block chunks keep each answer small; a filtered one is tiny.
 */
export async function recentLaunches(blocks: bigint, filter: { deployer?: Address; token?: Address } = {}): Promise<LaunchEvent[]> {
  const head = await publicClient.getBlockNumber();
  const from = head > blocks ? head - blocks : 0n;
  const step = filter.deployer || filter.token ? 100_000n : 25_000n;
  const out: LaunchEvent[] = [];
  for (let b = from; b <= head; b += step) {
    const to = b + step - 1n > head ? head : b + step - 1n;
    const logs = await publicClient.getLogs({
      address: ADDR.ponsFactory,
      event: TOKEN_LAUNCHED,
      args: { token: filter.token, deployer: filter.deployer },
      fromBlock: b,
      toBlock: to,
    });
    for (const l of logs) { const ev = toEvent(l as LaunchedLog); if (ev) out.push(ev); }
  }
  return out.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
}

/** The launch event for one token, searched backwards in widening windows. */
export async function findLaunch(token: Address): Promise<LaunchEvent | null> {
  const head = await publicClient.getBlockNumber();
  const windows = [500_000n, 2_000_000n, 8_000_000n, 32_000_000n];
  let to = head;
  for (const w of windows) {
    const from = to > w ? to - w : 0n;
    const logs = await publicClient.getLogs({ address: ADDR.ponsFactory, event: TOKEN_LAUNCHED, args: { token }, fromBlock: from, toBlock: to });
    if (logs.length) return toEvent(logs[0] as LaunchedLog);
    if (from === 0n) break;
    to = from - 1n;
  }
  return null;
}

export { factoryAbi };
