import { parseAbiItem, type Address } from "viem";
import { ADDR, publicClient } from "../chain.js";
import { recentLaunches, type LaunchEvent } from "./launches.js";

/**
 * Who launched what, kept in memory. Built once from one chunked getLogs over the window, then fed by the
 * live launch stream and a one-per-minute graduation sweep. Replaces a 400k-block getLogs per launch, which
 * is what made the public RPC start answering "unknown RPC error" during bursts.
 */
export class DeployerIndex {
  private launches = new Map<string, { block: bigint; token: string }[]>(); // deployer → launches
  private tokenDeployer = new Map<string, string>();
  private graduatedTokens = new Set<string>();
  private lastGradBlock = 0n;
  ready = false;
  windowBlocks: bigint;

  constructor(windowBlocks = 400_000n) { this.windowBlocks = windowBlocks; }

  async build(): Promise<{ launches: number; graduations: number }> {
    const head = await publicClient.getBlockNumber();
    const evs = await recentLaunches(this.windowBlocks);
    for (const ev of evs) this.note(ev);
    const from = head > this.windowBlocks ? head - this.windowBlocks : 0n;
    await this.sweepGraduations(from, head);
    this.ready = true;
    return { launches: evs.length, graduations: this.graduatedTokens.size };
  }

  /**
   * Build in the background and keep trying: the public RPC sometimes refuses the startup log query outright, and a
   * feed without deployer history is better than no feed. Live launches are noted meanwhile, so nothing is lost.
   */
  start(onReady: (b: { launches: number; graduations: number }) => void, onFail: (err: Error, retryInSec: number) => void, retryMs = 120_000): void {
    const attempt = () => {
      this.build().then(onReady).catch((e: Error) => { onFail(e, retryMs / 1000); setTimeout(attempt, retryMs).unref(); });
    };
    attempt();
  }

  note(ev: LaunchEvent): void {
    const d = ev.deployer.toLowerCase();
    const t = ev.token.toLowerCase();
    if (this.tokenDeployer.has(t)) return;
    this.tokenDeployer.set(t, d);
    const list = this.launches.get(d) ?? [];
    list.push({ block: ev.blockNumber, token: t });
    this.launches.set(d, list);
  }

  /** PoolGraduated logs since the last sweep; chunked, so a long gap never becomes one giant range. */
  async sweepGraduations(from?: bigint, to?: bigint): Promise<number> {
    const head = to ?? (await publicClient.getBlockNumber());
    let b = from ?? (this.lastGradBlock ? this.lastGradBlock + 1n : head - 2_000n);
    let added = 0;
    while (b <= head) {
      const end = b + 99_999n > head ? head : b + 99_999n;
      const logs = await publicClient.getLogs({ address: ADDR.ponsFactory, event: GRADUATED, fromBlock: b, toBlock: end });
      for (const l of logs) if (l.args.token) { const t = l.args.token.toLowerCase(); if (!this.graduatedTokens.has(t)) { this.graduatedTokens.add(t); added++; } }
      b = end + 1n;
    }
    this.lastGradBlock = head;
    return added;
  }

  /** Launches by this deployer before `beforeBlock` inside the window, and how many of them graduated. */
  quick(deployer: Address, beforeBlock: bigint): { prior: number; graduated: number } | null {
    if (!this.ready) return null;
    const list = (this.launches.get(deployer.toLowerCase()) ?? []).filter((l) => l.block < beforeBlock);
    return { prior: list.length, graduated: list.filter((l) => this.graduatedTokens.has(l.token)).length };
  }

  get size(): { deployers: number; tokens: number; graduated: number } {
    return { deployers: this.launches.size, tokens: this.tokenDeployer.size, graduated: this.graduatedTokens.size };
  }
}

const GRADUATED = parseAbiItem("event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)");

/** Small semaphore: the enrichment of a burst of launches runs `n` at a time, the rest queue. */
export function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const next = () => { active--; waiting.shift()?.(); };
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { next(); }
  };
}
