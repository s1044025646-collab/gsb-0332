import * as http from "node:http";
import { openDb } from "./db";
import { Service } from "./service";
import { GrayError, encode, decode, assertWidth } from "./gray";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new GrayError("VALIDATION", "请求体不是合法 JSON"); }
}

export function createServer(dbPath?: string): http.Server {
  const svc = new Service(openDb(dbPath));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /rules {name, width, bitOrder?}
      if (req.method === "POST" && url.pathname === "/rules") {
        const b = await readBody(req);
        return send(res, 201, svc.createRule(b.name, Number(b.width), b.bitOrder));
      }
      // GET /rules
      if (req.method === "GET" && url.pathname === "/rules") {
        return send(res, 200, svc.listRules());
      }
      // POST /encode {width, position} 位置为十进制字符串
      if (req.method === "POST" && url.pathname === "/encode") {
        const b = await readBody(req);
        const width = Number(b.width);
        assertWidth(width);
        return send(res, 200, { width, position: String(b.position), code: encode(BigInt(b.position), width) });
      }
      // POST /decode {width, code}
      if (req.method === "POST" && url.pathname === "/decode") {
        const b = await readBody(req);
        const width = Number(b.width);
        return send(res, 200, { width, code: String(b.code), position: decode(String(b.code), width).toString() });
      }
      if (parts[0] === "rules" && parts.length >= 2) {
        const ruleId = Number(parts[1]);
        // GET /rules/:id
        if (req.method === "GET" && parts.length === 2) return send(res, 200, svc.getRule(ruleId));
        // GET /rules/:id/table?from=&to=&limit=
        if (req.method === "GET" && parts[2] === "table") {
          const from = url.searchParams.get("from") ?? "0";
          const to = url.searchParams.get("to") ?? "0";
          const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
          return send(res, 200, svc.table(ruleId, BigInt(from), BigInt(to), limit));
        }
        // POST /rules/:id/samples/import {samples:[{seq,code}], idempotencyKey}
        if (req.method === "POST" && parts[2] === "samples" && parts[3] === "import") {
          const b = await readBody(req);
          return send(res, 200, svc.appendSamples(ruleId, b.samples, String(b.idempotencyKey ?? ""), { explicitSeq: true }));
        }
        // POST /rules/:id/samples/append {samples:[{code}], idempotencyKey}
        if (req.method === "POST" && parts[2] === "samples" && parts[3] === "append") {
          const b = await readBody(req);
          return send(res, 200, svc.appendSamples(ruleId, b.samples, String(b.idempotencyKey ?? ""), { explicitSeq: false }));
        }
        // GET /rules/:id/samples
        if (req.method === "GET" && parts[2] === "samples") return send(res, 200, svc.listSamples(ruleId));
        // GET /rules/:id/jumps
        if (req.method === "GET" && parts[2] === "jumps") return send(res, 200, svc.listTransitions(ruleId, true));
        // GET /rules/:id/transitions
        if (req.method === "GET" && parts[2] === "transitions") return send(res, 200, svc.listTransitions(ruleId));
        // GET /rules/:id/report
        if (req.method === "GET" && parts[2] === "report") return send(res, 200, svc.report(ruleId));
      }
      return send(res, 404, { error: "NOT_FOUND", message: "未知路由" });
    } catch (e) {
      if (e instanceof GrayError) return send(res, 400, { error: e.code, message: e.message });
      return send(res, 500, { error: "INTERNAL", message: String(e) });
    }
  });
}

/** 默认端口 0：由系统分配空闲端口；可用 PORT 环境变量或参数指定。 */
export function startServer(port: number = Number(process.env.PORT ?? 0), dbPath?: string): Promise<{ server: http.Server; port: number }> {
  const server = createServer(dbPath);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      console.log(`graycode-api listening on http://127.0.0.1:${p}`);
      resolve({ server, port: p });
    });
  });
}

if (require.main === module) {
  startServer();
}
