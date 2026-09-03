import type { LaunchIntel } from "./enrich.js";

/**
 * Launch farms: runs of launches from brand-new wallets that share one fingerprint, the same dev-buy wei,
 * the same creator tax, the same set of links, minutes apart. Each one looks fine on its own; together they are
 * one operator printing tokens. Keyed on what the launch calldata fixed, kept in memory for `windowMs`.
 */
export class FarmDetector {
  private seen = new Map<string, { t: number; deployer: string }[]>();
  constructor(private windowMs = 30 * 60_000) {}

  static key(intel: LaunchIntel): string | null {
    if (!intel.tx || !intel.record) return null;
    const s = intel.meta?.socials;
    const links = `${s?.twitter ? 1 : 0}${s?.website ? 1 : 0}${s?.telegram ? 1 : 0}`;
    return `${intel.tx.devBuyWei}|${intel.record.creatorTaxBps}|${links}|${intel.tx.exemptions.length}`;
  }

  /** Records the launch and returns how many earlier launches in the window carried the same fingerprint from another deployer. */
  note(intel: LaunchIntel, now = Date.now()): { twins: number; key: string | null } {
    const key = FarmDetector.key(intel);
    if (!key) return { twins: 0, key: null };
    const list = (this.seen.get(key) ?? []).filter((x) => x.t > now - this.windowMs);
    const me = intel.ev.deployer.toLowerCase();
    const twins = list.filter((x) => x.deployer !== me).length;
    list.push({ t: now, deployer: me });
    this.seen.set(key, list);
    if (this.seen.size > 5_000) for (const [k, v] of this.seen) { if (!v.some((x) => x.t > now - this.windowMs)) this.seen.delete(k); }
    return { twins, key };
  }
}
