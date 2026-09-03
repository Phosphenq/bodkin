import { createWalletClient, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhood } from "../chain.js";
import { gatedHttp } from "../util/rpcGate.js";

/**
 * The signer lives only in the user's own .env on the user's own machine.
 * Nothing here is ever printed, logged, or sent anywhere except as a transaction signature to the RPC.
 */
export function getAccount(): PrivateKeyAccount | null {
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) return null;
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

export function requireAccount(): PrivateKeyAccount {
  const a = getAccount();
  if (!a) throw new Error("PRIVATE_KEY is not set in .env; live trades need a signer (dry-run does not)");
  return a;
}

export function walletClient() {
  return createWalletClient({
    account: requireAccount(),
    chain: robinhood,
    transport: gatedHttp({ headers: { "user-agent": "bodkin/0.1" }, retries: 8 }),
  });
}
