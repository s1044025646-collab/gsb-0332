// 演示：三位码表完整循环 + 静止/正反一步/单比特非相邻样例 + 采样核验流程
import { startServer } from "../dist/server.js";

const dbPath = process.env.GRAY_DB ?? "data/demo.db";
const { server, port } = await startServer(dbPath);
const base = `http://127.0.0.1:${port}`;

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

console.log("== 三位反射格雷码完整循环（首尾相连） ==");
const t = await call("GET", "/table?bits=3&start=0&count=8");
for (const e of t.entries) console.log(`  位置 ${e.position} -> ${e.code}`);

console.log("\n== 转移判定样例 ==");
const rule = await call("POST", "/rules", { bits: 3 });
const seq = ["000", "000", "001", "000", "100", "000", "010"];
// 000->000 静止; 000->001 正向一步; 001->000 反向一步;
// 000->100 反向一步(0->7 回绕); 100->000 正向一步(7->0 回绕); 000->010 单比特但非相邻(跳变)
for (let i = 0; i < seq.length; i++) {
  await call("POST", `/rules/${rule.id}/samples`, { seq: i + 1, code: seq[i], idempotencyKey: `demo-${i + 1}` });
}
const tr = await call("GET", `/rules/${rule.id}/transitions`);
for (const x of tr) {
  console.log(`  #${x.from_seq}->#${x.to_seq} ${x.from_code}->${x.to_code} 位置 ${x.from_position}->${x.to_position} 汉明=${x.hamming} 判定=${x.direction}`);
  console.log(`    ${x.reason}`);
}

console.log("\n== 报告统计 ==");
const report = await call("GET", `/rules/${rule.id}/report`);
console.log(`  采样 ${report.sampleCount} 条, 转移 ${report.transitionCount} 条, 统计: ${JSON.stringify(report.counts)}`);

server.close();
