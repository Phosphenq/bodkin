import type { Address } from "viem";
import { factoryAbi, PHASE_NAME } from "../abi/pons.js";
import { ADDR, publicClient } from "../chain.js";
import { recentLaunches, type LaunchEvent } from "./launches.js";

export interface DeployerLaunch extends LaunchEvent { phase: number; phaseName: string }

export interface DeployerHistory {
  deployer: Address;
  windowBlocks: bigint;
  launches: DeployerLaunch[];
  graduated: number;
  onCurve: number;
}

/**
 * Everything one deployer address launched inside the window (default ~3 days at 100 ms blocks),
 * with each token's graduation phase. Phases are read for the newest `phaseCap` launches only.
 */
export async function deployerHistory(deployer: Address, windowBlocks = 2_600_000n, phaseCap = 25): Promise<DeployerHistory> {
  const evs = await recentLaunches(windowBlocks, { deployer });
  const newest = evs.slice(-phaseCap);
  const phases = await Promise.all(
    newest.map((e) => publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [e.token] })
      .then((r) => Number(r.phase)).catch(() => -1)),
  );
  const launches: DeployerLaunch[] = evs.map((e) => ({ ...e, phase: -1, phaseName: "?" }));
  newest.forEach((e, i) => {
    const idx = launches.findIndex((l) => l.token === e.token);
    if (idx >= 0) { launches[idx].phase = phases[i]; launches[idx].phaseName = PHASE_NAME[phases[i] as 0 | 1 | 2 | 3] ?? "?"; }
  });
  const graduated = launches.filter((l) => l.phase === 2).length;
  const onCurve = launches.filter((l) => l.phase === 0).length;
  return { deployer, windowBlocks, launches, graduated, onCurve };
}
