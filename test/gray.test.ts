import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  encode, decode, judge, hamming, reflectSequence, table, maxPosition, GrayError,
} from "../src/gray.js";
import { Store } from "../src/store.js";

function tmpDb(): string {
  const p = path.join("data", `test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  fs.mkdirSync("data", { recursive: true });
  return p;
}

test("三位码表完整首尾循环", () => {
  const seq = reflectSequence(3);
  assert.deepEqual(seq, ["000", "001", "011", "010", "110", "111", "101", "100"]);
  // 递归序列与公式编码一致，且位置一一对应
  for (let i = 0; i < seq.length; i++) {
    assert.equal(encode(i, 3), seq[i]);
    assert.equal(decode(seq[i], 3), BigInt(i));
  }
  // 相邻（含首尾回绕）汉明距离均为 1
  for (let i = 0; i < seq.length; i++) {
    assert.equal(hamming(seq[i], seq[(i + 1) % seq.length]), 1);
  }
});

test("小位宽递归反射法核对全部编解码与相邻汉明距离", () => {
  for (let bits = 1; bits <= 6; bits++) {
    const seq = reflectSequence(bits);
    assert.equal(seq.length, 2 ** bits);
    for (let i = 0; i < seq.length; i++) {
      assert.equal(encode(i, bits), seq[i]);
      assert.equal(decode(seq[i], bits), BigInt(i));
      assert.equal(hamming(seq[i], seq[(i + 1) % seq.length]), 1);
    }
  }
});

test("大于 32 位的高位值、全零与最大位置", () => {
  const bits = 64;
  const max = maxPosition(bits); // 2^64 - 1
  assert.equal(encode(0n, bits), "0".repeat(64));
  assert.equal(decode("0".repeat(64), bits), 0n);
  const maxCode = encode(max, bits);
  assert.equal(maxCode.length, 64);
  assert.equal(decode(maxCode, bits), max);
  // 超过安全整数的十进制字符串
  const big = "18446744073709551615";
  assert.equal(decode(encode(big, bits), bits).toString(), big);
  // 高位模式：位置 2^63
  const p = 1n << 63n;
  assert.equal(decode(encode(p, bits), bits), p);
  // 33 位位宽不截断
  assert.equal(decode(encode(2n ** 32n, 33), 33), 2n ** 32n);
});

test("前导零保留与非法输入报错", () => {
  assert.equal(encode(1, 4), "0001");
  assert.throws(() => decode("001", 4), (e: GrayError) => e.code === "E_CODEWORD");
  assert.throws(() => decode("00x1", 4), (e: GrayError) => e.code === "E_CODEWORD");
  assert.throws(() => encode(-1, 4), (e: GrayError) => e.code === "E_POSITION");
  assert.throws(() => encode(16, 4), (e: GrayError) => e.code === "E_POSITION");
  assert.throws(() => encode(1, 0), (e: GrayError) => e.code === "E_BITS");
  assert.throws(() => encode(1, 129), (e: GrayError) => e.code === "E_BITS");
});

test("静止、正反一步、回绕与跳变判定", () => {
  assert.equal(judge("000", "000", 3).direction, "stationary");
  assert.equal(judge("000", "001", 3).direction, "forward");   // 0 -> 1
  assert.equal(judge("001", "000", 3).direction, "reverse");   // 1 -> 0
  assert.equal(judge("100", "000", 3).direction, "forward");   // 7 -> 0 回绕
  assert.equal(judge("000", "100", 3).direction, "reverse");   // 0 -> 7 回绕
  // 单比特但非相邻：000 -> 010 解码为 0 -> 3，是跳变
  const v = judge("000", "010", 3);
  assert.equal(v.direction, "jump");
  assert.equal(v.hamming, 1);
  assert.equal(v.delta, "3");
});

test("位宽为 1 时方向不确定", () => {
  assert.equal(judge("0", "1", 1).direction, "ambiguous");
  assert.equal(judge("1", "0", 1).direction, "ambiguous");
  assert.equal(judge("0", "0", 1).direction, "stationary");
});

test("码表区间与上限", () => {
  const t = table(3, 6, 10);
  assert.equal(t.count, 2); // 只剩 6,7
  assert.equal(t.truncated, true);
  assert.throws(() => table(3, 0, 5000), (e: GrayError) => e.code === "E_RANGE");
});

test("分批追加与一次导入结果一致", () => {
  const codes = reflectSequence(3);
  const run = (batches: string[][]) => {
    const store = new Store(tmpDb());
    const rule = store.createRule(3);
    let seq = 1;
    for (const batch of batches) {
      store.appendSamples(rule.id, batch.map((code) => ({ seq: seq++, code })));
    }
    const report = store.report(rule.id);
    store.close();
    return report;
  };
  const once = run([codes]);
  const split = run([codes.slice(0, 3), codes.slice(3, 5), codes.slice(5)]);
  assert.deepEqual(split.transitions, once.transitions);
  assert.deepEqual(split.samples.map((s: any) => [s.seq, s.code]), once.samples.map((s: any) => [s.seq, s.code]));
});

test("幂等键重复提交不产生重复记录，冲突则报错", () => {
  const store = new Store(tmpDb());
  const rule = store.createRule(3);
  store.appendSamples(rule.id, [{ seq: 1, code: "000", idempotencyKey: "k1" }]);
  const again = store.appendSamples(rule.id, [{ seq: 1, code: "000", idempotencyKey: "k1" }]);
  assert.equal(again.inserted.length, 0);
  assert.equal(again.duplicates.length, 1);
  assert.equal(store.listSamples(rule.id).length, 1);
  assert.throws(
    () => store.appendSamples(rule.id, [{ seq: 2, code: "001", idempotencyKey: "k1" }]),
    (e: GrayError) => e.code === "E_IDEMPOTENCY",
  );
  store.close();
});

test("顺序缺口报错且导入错误不留半批数据", () => {
  const store = new Store(tmpDb());
  const rule = store.createRule(3);
  store.appendSamples(rule.id, [{ seq: 1, code: "000" }]);
  assert.throws(
    () => store.appendSamples(rule.id, [{ seq: 3, code: "001" }]),
    (e: GrayError) => e.code === "E_SEQ",
  );
  // 批次中途失败 -> 整批回滚
  assert.throws(
    () => store.appendSamples(rule.id, [{ seq: 2, code: "001" }, { seq: 3, code: "bad!" }]),
    (e: GrayError) => e.code === "E_CODEWORD",
  );
  assert.equal(store.listSamples(rule.id).length, 1);
  assert.equal(store.listTransitions(rule.id).length, 0);
  store.close();
});

test("重启后继续核验与不中断一致", () => {
  const db = tmpDb();
  const codes = reflectSequence(3);
  let ruleId: number;
  {
    const store = new Store(db);
    ruleId = store.createRule(3).id;
    store.appendSamples(ruleId, codes.slice(0, 4).map((code, i) => ({ seq: i + 1, code })));
    store.close();
  }
  // 模拟重启
  const store = new Store(db);
  store.appendSamples(ruleId, codes.slice(4).map((code, i) => ({ seq: i + 5, code })));
  const report = store.report(ruleId);
  store.close();
  assert.equal(report.sampleCount, 8);
  assert.equal(report.transitionCount, 7);
  assert.equal(report.counts.forward, 7);
});

test("新规则独立会话，不同位宽互不影响", () => {
  const store = new Store(tmpDb());
  const r3 = store.createRule(3);
  const r4 = store.createRule(4);
  store.appendSamples(r3.id, [{ seq: 1, code: "000" }, { seq: 2, code: "001" }]);
  // 4 位规则拒绝 3 位码字
  assert.throws(
    () => store.appendSamples(r4.id, [{ seq: 1, code: "001" }]),
    (e: GrayError) => e.code === "E_CODEWORD",
  );
  assert.equal(store.listSamples(r4.id).length, 0);
  store.close();
});
