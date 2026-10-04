import * as fs from "node:fs";
import { openDb } from "./db";
import { Service } from "./service";
import { encode, decode, reflectSequence, hammingDistance, changedBits, judge } from "./gray";
import { startServer } from "./api";

const svc = () => new Service(openDb());

function fmtTransition(t: any): string {
  const bits = (t.changedBits as number[]).join(",");
  return `seq=${t.seq} ${t.fromCode} -> ${t.toCode} | 汉明距离=${t.hamming} 变化位=[${bits}] | 模差=${t.delta} | ${t.kind}/${t.direction} | ${t.reason}`;
}

function printTransitions(ts: any[]) {
  if (ts.length === 0) { console.log("（无转移记录）"); return; }
  for (const t of ts) console.log(fmtTransition(t));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "encode": {
      const [n, pos] = args;
      console.log(encode(BigInt(pos), Number(n)));
      break;
    }
    case "decode": {
      const [n, code] = args;
      console.log(decode(code, Number(n)).toString());
      break;
    }
    case "table": {
      // table <n> [from to]  —— 小位宽可省略区间输出完整循环
      const n = Number(args[0]);
      const from = args[1] !== undefined ? BigInt(args[1]) : 0n;
      const to = args[2] !== undefined ? BigInt(args[2]) : (1n << BigInt(n)) - 1n;
      if (to - from + 1n > 65536n) throw new Error("区间过大，请限定 from/to");
      for (let p = from; p <= to; p++) console.log(`${p.toString().padStart(3)}  ${encode(p, n)}`);
      break;
    }
    case "rule": {
      // rule create <name> <width>
      if (args[0] === "create") console.log(svc().createRule(args[1], Number(args[2])));
      else console.log(svc().listRules());
      break;
    }
    case "import": {
      // import <ruleId> <jsonFile> <idempotencyKey>  文件为 [{seq, code}, ...]
      const [ruleId, file, key] = args;
      const samples = JSON.parse(fs.readFileSync(file, "utf8"));
      const r = svc().appendSamples(Number(ruleId), samples, key, { explicitSeq: true });
      console.log(`accepted=${r.accepted} seq ${r.fromSeq}..${r.toSeq} idempotent=${r.idempotent}`);
      printTransitions(r.transitions);
      break;
    }
    case "append": {
      // append <ruleId> <idempotencyKey> <code...>
      const [ruleId, key, ...codes] = args;
      const r = svc().appendSamples(Number(ruleId), codes.map((code) => ({ code })), key, { explicitSeq: false });
      console.log(`accepted=${r.accepted} seq ${r.fromSeq}..${r.toSeq} idempotent=${r.idempotent}`);
      printTransitions(r.transitions);
      break;
    }
    case "jumps": {
      printTransitions(svc().listTransitions(Number(args[0]), true));
      break;
    }
    case "report": {
      const r = svc().report(Number(args[0]));
      console.log(`规则 #${r.rule.id} "${r.rule.name}" 位宽=${r.rule.width} 采样数=${r.sampleCount}`);
      console.log(`汇总: 静止=${r.summary.still} 正向=${r.summary.stepForward} 反向=${r.summary.stepBackward} 方向不定=${r.summary.stepAmbiguous} 跳变=${r.summary.jump}`);
      printTransitions(r.transitions);
      break;
    }
    case "serve": {
      await startServer(args[0] ? Number(args[0]) : undefined as any);
      break;
    }
    case "demo": {
      demo();
      break;
    }
    default:
      console.log(`用法：
  encode <n> <pos>            位置 -> 格雷码
  decode <n> <code>           格雷码 -> 位置
  table <n> [from to]         打印码表（默认完整区间，超大区间需限定）
  rule create <name> <width>  创建编码规则（位宽锁定）
  rule list                   列出规则
  import <ruleId> <file> <k>  导入采样 JSON [{seq,code}]，k 为幂等键
  append <ruleId> <k> <码...> 追加采样（自动连续编号）
  jumps <ruleId>              查询跳变
  report <ruleId>             导出报告
  serve [port]                启动 API（默认空闲端口）
  demo                        三位码表演示`);
  }
}

function demo() {
  console.log("== 三位反射格雷码完整首尾循环 ==");
  const seq = reflectSequence(3);
  seq.forEach((c, i) => {
    const next = seq[(i + 1) % seq.length];
    console.log(`${i}  ${c}  (与下一码字 ${next} 汉明距离=${hammingDistance(c, next)})`);
  });
  console.log("\n== 样例判定（位宽 3） ==");
  const cases: [string, string][] = [
    ["010", "010"], // 静止 3->3
    ["001", "011"], // 正向一步 1->2
    ["011", "001"], // 反向一步 2->1
    ["100", "000"], // 回绕 7->0 正向一步
    ["000", "010"], // 单比特但非相邻 0->2 跳变
  ];
  for (const [a, b] of cases) {
    const pa = decode(a, 3), pb = decode(b, 3);
    const v = judge(pa, pb, 3);
    console.log(`${a}(${pa}) -> ${b}(${pb}) 汉明距离=${hammingDistance(a, b)} 变化位=[${changedBits(a, b)}] => ${v.kind}/${v.direction}：${v.reason}`);
  }
}

main().catch((e) => { console.error(`错误 [${e.code ?? "ERROR"}] ${e.message}`); process.exit(1); });
