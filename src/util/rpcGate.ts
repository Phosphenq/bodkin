import { custom, type Transport } from "viem";

/**
 * Every JSON-RPC request bodkin makes goes through this file.
 *
 * Why it exists (measured on 2026-09-03):
 * - the official public RPC answers HTTP 429 above roughly eight concurrent calls, counts every call inside a JSON-RPC
 *   batch array, meters eth_getLogs much more tightly than eth_call, and hands a Cloudflare challenge page to a client
 *   that has been noisy for a while;
 * - publicnode's endpoint is fast and generous for state reads but refuses eth_getLogs without a token.
 *
 * So: a list of endpoints with capabilities, single requests (no batching), bounded concurrency, minimum spacing
 * (tighter for eth_getLogs), a process-wide cooldown after a 429, and a penalty box per endpoint. A request is routed to the
 * first healthy endpoint that supports its method and moves to the next one when it is refused. Set RPC_URL to a
 * comma-separated list to replace the defaults; a private provider can carry everything.
 */

export interface Endpoint { url: string; logs: boolean; badUntil: number; label: string }

export const DEFAULT_ENDPOINTS: { url: string; logs: boolean; label: string }[] = [
  { url: "https://robinhood-rpc.publicnode.com", logs: false, label: "publicnode" },
  { url: "https://rpc.mainnet.chain.robinhood.com", logs: true, label: "robinhood" },
];

function parseEndpoints(): Endpoint[] {
  const raw = process.env.RPC_URL?.trim();
  if (!raw) return DEFAULT_ENDPOINTS.map((e) => ({ ...e, badUntil: 0 }));
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((u) => {
    const noLogs = u.endsWith("#nologs");
    const url = noLogs ? u.slice(0, -"#nologs".length) : u;
    const known = DEFAULT_ENDPOINTS.find((d) => d.url === url);
    return { url, logs: known ? known.logs : !noLogs, badUntil: 0, label: known?.label ?? new URL(url).hostname };
  });
}

export const endpoints: Endpoint[] = parseEndpoints();

const inFlight = Number(process.env.RPC_IN_FLIGHT ?? 3);
const spacingMs = Number(process.env.RPC_SPACING_MS ?? 50);
const logsSpacingMs = Number(process.env.RPC_LOGS_SPACING_MS ?? 400);

let active = 0;
let lastStart = 0;
let lastLogsStart = 0;
let cooldownUntil = 0;
let throttled = 0;
const queue: (() => void)[] = [];

async function acquire(method: string): Promise<void> {
  if (active >= inFlight) await new Promise<void>((r) => queue.push(r));
  active++;
  const cooling = Date.now() < cooldownUntil;
  let wait = lastStart + (cooling ? spacingMs * 5 : spacingMs) - Date.now();
  if (method === "eth_getLogs") wait = Math.max(wait, lastLogsStart + (cooling ? logsSpacingMs * 3 : logsSpacingMs) - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastStart = Date.now();
  if (method === "eth_getLogs") lastLogsStart = lastStart;
}
function release(): void { active--; queue.shift()?.(); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Healthy endpoints that can serve the method, in configured order; if none is healthy, the least-recently-benched one. */
function candidates(method: string): Endpoint[] {
  const able = endpoints.filter((e) => method !== "eth_getLogs" || e.logs);
  const now = Date.now();
  const healthy = able.filter((e) => e.badUntil <= now);
  if (healthy.length) return healthy;
  return able.sort((a, b) => a.badUntil - b.badUntil).slice(0, 1);
}

let nextId = 1;

export function gatedHttp(opts: { timeoutMs?: number; headers?: Record<string, string>; retries?: number } = {}): Transport {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 6;
  const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params ?? [] });
    let lastErr = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      const list = candidates(method);
      if (!list.length) throw new Error(`rpc ${method}: no configured endpoint serves this method (eth_getLogs needs one that allows it; set RPC_URL)`);
      const ep = list[Math.min(attempt, list.length - 1)];
      await acquire(method);
      let res: Response;
      let text: string;
      try {
        res = await fetch(ep.url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
        text = await res.text();
      } catch (e) {
        release();
        lastErr = `${ep.label}: ${(e as Error).message}`;
        ep.badUntil = Date.now() + 5_000;
        await sleep(250 * (attempt + 1));
        continue;
      }
      release();
      if (res.status === 429 || res.status === 503) {
        throttled++;
        cooldownUntil = Date.now() + 3_000;
        ep.badUntil = Date.now() + (list.length > 1 ? 4_000 : 0);
        lastErr = `${ep.label}: HTTP ${res.status}`;
        await sleep(list.length > 1 ? 100 : Math.min(15_000, 400 * 2 ** attempt));
        continue;
      }
      if (res.status === 403 && /just a moment|cloudflare|challenge/i.test(text)) {
        // A browser challenge; no retry solves it. Bench the endpoint for a minute and move on.
        throttled++;
        ep.badUntil = Date.now() + 60_000;
        lastErr = `${ep.label}: bot-protection challenge (Cloudflare) on this IP`;
        if (list.length > 1) continue;
        await sleep(5_000);
        continue;
      }
      let json: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      try { json = JSON.parse(text); } catch { lastErr = `${ep.label}: HTTP ${res.status}, non-JSON body ${text.slice(0, 60)}`; ep.badUntil = Date.now() + 5_000; await sleep(300); continue; }
      if (json.error) {
        if (json.error.code === 429) { throttled++; cooldownUntil = Date.now() + 3_000; ep.badUntil = Date.now() + 4_000; lastErr = `${ep.label}: 429`; await sleep(list.length > 1 ? 100 : Math.min(15_000, 400 * 2 ** attempt)); continue; }
        // viem expects the JSON-RPC error object so it can map reverts and known codes.
        throw Object.assign(new Error(json.error.message), { code: json.error.code, data: json.error.data });
      }
      return json.result;
    }
    throw new Error(`rpc ${method}: gave up after ${retries + 1} tries (${lastErr})`);
  };
  return custom({ request }, { retryCount: 0 });
}

/** For the status line: how busy the gate is and how the endpoints are doing. */
export const gateStats = () => ({
  active, queued: queue.length, inFlight, spacingMs, logsSpacingMs, throttled, coolingDown: Date.now() < cooldownUntil,
  endpoints: endpoints.map((e) => ({ label: e.label, logs: e.logs, benched: e.badUntil > Date.now() })),
});
