/** The public RPC answers bursts with opaque errors. Three tries, short backoff, then give up loudly. */
export async function retry<T>(fn: () => Promise<T>, tries = 3, baseMs = 400): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = (e as Error).message ?? "";
      const transient = /unknown RPC error|429|rate|timeout|ECONNRESET|fetch failed|503|502/i.test(msg);
      if (!transient || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}
