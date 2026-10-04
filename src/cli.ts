import * as path from "node:path";
import { decode, encode, judge, table, hamming, changedBits } from "./gray.js";
import type { Store } from "./store.js";

async function openStore(dbPath: string): Promise<Store> {
  const { Store } = await import("./store.js");
  return new Store(dbPath);
}

function usage(): never {
  console.log(`用法: node dist/cli.js <命令> [参数]
  encode <bits> <position>            位置 -> 定宽格雷码
  decode <bits> <code>                格雷码 -> 位置
  table <bits> [start] [count]        输出限定区间码表
  judge <bits> <codeA> <codeB>        判定相邻两次采样的转移
  rule-create <bits>                  创建编码规则（锁定位宽）
  sample-add <ruleId> <seq> <code> [idempotencyKey]   追加采样
  transitions <ruleId> [direction]    查询转移记录
  report <ruleId>                     导出核验报告
环境变量 GRAY_DB 指定数据库文件（默认 data/gray.db）。`);
  process.exit(1);
}

function showVerdict(bits: number, a: string, b: string): void {
  const v = judge(a, b, bits);
  console.log(`  ${a} (位置 ${decode(a, bits)}) -> ${b} (位置 ${decode(b, bits)})`);
  console.log(`  汉明距离=${v.hamming} 变化位=[${v.changedBits.join(",")}] 模位置差=${v.delta}`);
  console.log(`  判定=${v.direction}  理由: ${v.reason}`);
}

async function main() {
const args = process.argv.slice(2);
const cmd = args[0];
const dbPath = process.env.GRAY_DB ?? path.join("data", "gray.db");

try {
  switch (cmd) {
    case "encode": {
      const [, bits, pos] = args;
      if (bits == null || pos == null) usage();
      console.log(encode(pos, Number(bits)));
      break;
    }
    case "decode": {
      const [, bits, code] = args;
      if (bits == null || code == null) usage();
      console.log(decode(code, Number(bits)).toString());
      break;
    }
    case "table": {
      const [, bits, start = "0", count = "16"] = args;
      if (bits == null) usage();
      const t = table(Number(bits), start, Number(count));
      for (const e of t.entries) console.log(`${e.position}\t${e.code}`);
      if (t.truncated) console.log(`(已截断至 ${t.count} 条)`);
      break;
    }
    case "judge": {
      const [, bits, a, b] = args;
      if (bits == null || a == null || b == null) usage();
      showVerdict(Number(bits), a, b);
      break;
    }
    case "rule-create": {
      const [, bits] = args;
      if (bits == null) usage();
      const store = await openStore(dbPath);
      console.log(JSON.stringify(store.createRule(Number(bits))));
      store.close();
      break;
    }
    case "sample-add": {
      const [, ruleId, seq, code, key] = args;
      if (ruleId == null || seq == null || code == null) usage();
      const store = await openStore(dbPath);
      const r = store.appendSamples(Number(ruleId), [{ seq: Number(seq), code, idempotencyKey: key }]);
      for (const s of r.inserted) {
        console.log(`已记录 seq=${s.seq} code=${s.code} 位置=${s.position}`);
        if (s.prev_code != null) showVerdict(Number((store.getRule(Number(ruleId))).bits), s.prev_code, s.code);
      }
      for (const d of r.duplicates) console.log(`幂等命中，未重复记录 seq=${d.seq}`);
      store.close();
      break;
    }
    case "transitions": {
      const [, ruleId, direction] = args;
      if (ruleId == null) usage();
      const store = await openStore(dbPath);
      for (const t of store.listTransitions(Number(ruleId), direction)) {
        console.log(`#${t.from_seq}->#${t.to_seq} ${t.from_code}->${t.to_code} 位置 ${t.from_position}->${t.to_position} 汉明=${t.hamming} 判定=${t.direction} ${t.reason}`);
      }
      store.close();
      break;
    }
    case "report": {
      const [, ruleId] = args;
      if (ruleId == null) usage();
      const store = await openStore(dbPath);
      console.log(JSON.stringify(store.report(Number(ruleId)), null, 2));
      store.close();
      break;
    }
    default:
      usage();
  }
} catch (e: any) {
  if (e && e.code) {
    console.error(`错误 [${e.code}] ${e.message}`);
    process.exit(2);
  }
  throw e;
}

}

main();



