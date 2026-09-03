import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine, type SnipeRules } from "../snipe.js";
import { loadPositions } from "../trade/positions.js";
import { ethUsd } from "../util/price.js";
import { c } from "../util/log.js";

/**
 * The board. Binds 127.0.0.1 only. GET serves the page, the event stream and a state snapshot; POST reaches
 * exactly four verbs on the in-process engine: pause, resume, close a position, and edit a numeric rule.
 * Nothing here can buy: firing is the engine's decision under the rules on screen, and `--live` is a launch
 * flag, not a button.
 */

export interface BoardOpts { port: number; live: boolean; rules: SnipeRules }

const here = dirname(fileURLToPath(import.meta.url));

/** Rules the page may edit at runtime, with the bounds it must respect. */
const EDITABLE: Record<string, { min: number; max: number }> = {
  minScore: { min: 0, max: 100 },
  maxOpenPositions: { min: 0, max: 20 },
  maxOpeningTaxBps: { min: 0, max: 2000 },
  maxDevSharePct: { min: 0, max: 100 },
  maxExemptWallets: { min: 0, max: 50 },
};

function positionsView() {
  return loadPositions()
    .filter((p) => p.status === "open" || (p.exits.at(-1)?.at ?? 0) * 1000 > Date.now() - 900_000)
    .map((p) => {
      const entry = BigInt(p.entryEth);
      const last = p.status === "open" ? BigInt(p.lastEth) : BigInt(p.exits.at(-1)?.ethOut ?? p.lastEth);
      const pnl = entry > 0n ? Number(((last - entry) * 10_000n) / entry) / 100 : 0;
      return { id: p.id, token: p.token, symbol: p.symbol, ethIn: p.entryEth, status: p.status, pnl, dryRun: p.dryRun, openedAt: p.openedAt * 1000, reason: p.exits.at(-1)?.reason, closedAt: (p.exits.at(-1)?.at ?? 0) * 1000 };
    });
}

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => { let b = ""; req.on("data", (d) => { b += d; if (b.length > 4096) req.destroy(); }); req.on("end", () => resolve(b)); });
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); };

export async function startBoard(opts: BoardOpts): Promise<void> {
  const html = readFileSync(join(here, "index.html"), "utf8");
  const clients = new Set<ServerResponse>();
  const recent: Record<string, unknown>[] = [];
  const startedAt = Date.now();
  let fired = 0;
  let seen = 0;
  const push = (e: Record<string, unknown>) => {
    if (e.kind === "fire") fired++;
    if (e.kind === "launch") seen++;
    recent.push(e);
    if (recent.length > 400) recent.shift();
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(line);
  };

  const engine = startEngine({ live: opts.live, rules: opts.rules, onEvent: push });

  const rulesView = () => ({
    ethPerBuy: engine.rules.ethPerBuy.toString(),
    minScore: engine.rules.minScore,
    maxOpeningTaxBps: engine.rules.maxOpeningTaxBps,
    maxDevSharePct: engine.rules.maxDevSharePct,
    maxCreatorTaxBps: engine.rules.maxCreatorTaxBps,
    requireSocials: engine.rules.requireSocials,
    maxExemptWallets: engine.rules.maxExemptWallets,
    ethPairsOnly: engine.rules.ethPairsOnly,
    keyword: engine.rules.keyword?.source ?? null,
    maxOpenPositions: engine.rules.maxOpenPositions,
    exits: engine.rules.exits,
    editable: Object.keys(EDITABLE),
  });
  const hello = () => ({ kind: "hello", live: opts.live, paused: engine.paused(), rules: rulesView(), startedAt, seen, fired, positions: positionsView() });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET") {
        if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); return; }
        if (url.pathname === "/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(`data: ${JSON.stringify(hello())}\n\n`);
          for (const e of recent.filter((e) => e.kind === "launch").slice(-60)) res.write(`data: ${JSON.stringify(e)}\n\n`);
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        if (url.pathname === "/api/state") { json(res, 200, { ...hello(), ethUsd: await ethUsd(), recent: recent.slice(-100) }); return; }
        json(res, 404, { error: "not found" });
        return;
      }
      if (req.method === "POST") {
        if (url.pathname === "/api/pause") { engine.pause(); json(res, 200, { paused: true }); return; }
        if (url.pathname === "/api/resume") { engine.resume(); json(res, 200, { paused: false }); return; }
        if (url.pathname.startsWith("/api/close/")) {
          const id = decodeURIComponent(url.pathname.slice("/api/close/".length));
          const r = await engine.close(id);
          json(res, 200, r);
          return;
        }
        if (url.pathname === "/api/rules") {
          const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
          const changed: Record<string, number> = {};
          for (const [k, v] of Object.entries(body)) {
            const bound = EDITABLE[k];
            const n = Number(v);
            if (!bound || !Number.isFinite(n)) continue;
            const clamped = Math.max(bound.min, Math.min(bound.max, Math.round(n)));
            (engine.rules as unknown as Record<string, number>)[k] = clamped;
            changed[k] = clamped;
          }
          push({ kind: "rules", rules: rulesView(), changed });
          json(res, 200, { changed, rules: rulesView() });
          return;
        }
        json(res, 404, { error: "not found" });
        return;
      }
      res.writeHead(405).end();
    } catch (e) {
      json(res, 400, { error: (e as Error).message.split("\n")[0] });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  console.log(`${c.neon("bodkin")} ${c.muted("board")}  http://127.0.0.1:${opts.port}  ${opts.live ? c.onNeon(" LIVE ") : c.muted("dry run")}`);
  process.on("SIGINT", () => { engine.stop(); server.close(); process.exit(0); });
}
