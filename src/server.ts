import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { GrayError, decode, encode, table, MAX_TABLE_ENTRIES, MIN_BITS, MAX_BITS } from "./gray.js";
import { Store } from "./store.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GrayError("E_JSON", "请求体不是合法 JSON");
  }
}

export async function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(preferred, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

export async function startServer(dbPath: string, port?: number): Promise<{ server: http.Server; port: number; store: Store }> {
  const store = new Store(dbPath);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // GET /meta
      if (req.method === "GET" && url.pathname === "/meta") {
        return json(res, 200, { minBits: MIN_BITS, maxBits: MAX_BITS, maxTableEntries: MAX_TABLE_ENTRIES });
      }
      // POST /rules { bits }
      if (req.method === "POST" && url.pathname === "/rules") {
        const body = await readBody(req);
        return json(res, 201, store.createRule(Number(body.bits)));
      }
      // GET /rules
      if (req.method === "GET" && url.pathname === "/rules") {
        return json(res, 200, store.listRules());
      }
      // POST /encode { bits, position }
      if (req.method === "POST" && url.pathname === "/encode") {
        const body = await readBody(req);
        const bits = Number(body.bits);
        return json(res, 200, { bits, position: String(body.position), code: encode(body.position, bits) });
      }
      // POST /decode { bits, code }
      if (req.method === "POST" && url.pathname === "/decode") {
        const body = await readBody(req);
        const bits = Number(body.bits);
        return json(res, 200, { bits, code: body.code, position: decode(body.code, bits).toString() });
      }
      // GET /table?bits=&start=&count=
      if (req.method === "GET" && url.pathname === "/table") {
        const bits = Number(url.searchParams.get("bits"));
        const start = url.searchParams.get("start") ?? "0";
        const count = Number(url.searchParams.get("count") ?? "16");
        return json(res, 200, table(bits, start, count));
      }
      // /rules/:id/...
      if (parts[0] === "rules" && parts.length >= 2) {
        const ruleId = Number(parts[1]);
        if (!Number.isInteger(ruleId)) throw new GrayError("E_RULE", "规则 id 非法");
        if (req.method === "GET" && parts.length === 2) return json(res, 200, store.getRule(ruleId));
        // POST /rules/:id/samples  { samples: [{seq, code, idempotencyKey?}] } 或单条 {seq, code}
        if (req.method === "POST" && parts[2] === "samples" && parts.length === 3) {
          const body = await readBody(req);
          const items = Array.isArray(body.samples) ? body.samples : [body];
          return json(res, 201, store.appendSamples(ruleId, items));
        }
        if (req.method === "GET" && parts[2] === "samples" && parts.length === 3) {
          return json(res, 200, store.listSamples(ruleId));
        }
        if (req.method === "GET" && parts[2] === "transitions" && parts.length === 3) {
          return json(res, 200, store.listTransitions(ruleId, url.searchParams.get("direction") ?? undefined));
        }
        if (req.method === "GET" && parts[2] === "report" && parts.length === 3) {
          return json(res, 200, store.report(ruleId));
        }
      }
      return json(res, 404, { error: { code: "E_NOT_FOUND", message: "路由不存在" } });
    } catch (e) {
      if (e instanceof GrayError) return json(res, 400, { error: { code: e.code, message: e.message } });
      return json(res, 500, { error: { code: "E_INTERNAL", message: String(e) } });
    }
  });
  const p = port ?? (await findFreePort());
  await new Promise<void>((resolve) => server.listen(p, "127.0.0.1", resolve));
  return { server, port: p, store };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("server.js")) {
  const dbPath = process.env.GRAY_DB ?? path.join("data", "gray.db");
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  startServer(dbPath, port).then(({ port }) => {
    console.log(`格雷码服务已启动: http://127.0.0.1:${port} (数据库: ${dbPath})`);
  });
}
