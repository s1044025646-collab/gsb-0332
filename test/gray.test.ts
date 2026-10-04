import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encode, decode, reflectSequence, hammingDistance, judge, GrayError } from "../src/gray";
import { openDb } from "../src/db";
import { Service } from "../src/service";

test("小位宽递归反射序列与公式编码一致，相邻汉明距离为 1（含首尾回绕）", () => {
  for (let n = 1; n <= 6; n++) {
    const seq = reflectSequence(n);
    assert.equal(seq.length, 2 ** n);
    seq.forEach((code, i) => {
      assert.equal(encode(BigInt(i), n), code);
      assert.equal(decode(code, n), BigInt(i));
      const next = seq[(i + 1) % seq.length];
      assert.equal(hammingDistance(code, next), 1);
    });
  }
});

test("全零与最大位置", () => {
  assert.equal(encode(0n, 4), "0000");
  assert.equal(decode("0000", 4), 0n);
  assert.equal(encode(15n, 4), "1000");
  assert.equal(decode("1000", 4), 15n);
});

test("大于 32 位的高位值不被截断", () => {
  const n = 40;
  const pos = (1n << 39n) + 12345n;
  const code = encode(pos, n);
  assert.equal(code.length, 40);
  assert.equal(decode(code, n), pos);
  // 前导零保留
  assert.equal(encode(1n, 8), "00000001");
});

test("回绕：末位置到 0 判定为正向一步", () => {
  const v = judge(7n, 0n, 3);
  assert.equal(v.kind, "step");
  assert.equal(v.direction, "forward");
});

test("位宽 1 时方向不确定", () => {
  const v = judge(0n, 1n, 1);
  assert.equal(v.kind, "step");
  assert.equal(v.direction, "ambiguous");
});

test("单比特变化但非相邻：000 -> 010 为跳变", () => {
  const v = judge(decode("000", 3), decode("010", 3), 3);
  assert.equal(hammingDistance("000", "010"), 1);
  assert.equal(v.kind, "jump");
});

test("参数校验错误码", () => {
  assert.throws(() => encode(-1n, 3), (e: any) => e.code === "POSITION_OUT_OF_RANGE");
  assert.throws(() => encode(8n, 3), (e: any) => e.code === "POSITION_OUT_OF_RANGE");
  assert.throws(() => encode(0n, 0), (e: any) => e.code === "INVALID_WIDTH");
  assert.throws(() => decode("00", 3), (e: any) => e.code === "INVALID_CODE");
  assert.throws(() => decode("0a0", 3), (e: any) => e.code === "INVALID_CODE");
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gray-test-"));
  return path.join(dir, "t.db");
}

test("分批追加与一次导入结果一致", () => {
  const codes = ["000", "001", "011", "010", "110", "111", "101", "100", "000"];
  const db1 = tempDb();
  const s1 = new Service(openDb(db1));
  const r1 = s1.createRule("once", 3);
  s1.appendSamples(r1.id, codes.map((code, i) => ({ seq: i + 1, code })), "k1", { explicitSeq: true });

  const db2 = tempDb();
  const s2 = new Service(openDb(db2));
  const r2 = s2.createRule("batches", 3);
  s2.appendSamples(r2.id, codes.slice(0, 4).map((code, i) => ({ seq: i + 1, code })), "b1", { explicitSeq: true });
  s2.appendSamples(r2.id, codes.slice(4).map((code, i) => ({ seq: i + 5, code })), "b2", { explicitSeq: true });

  assert.deepEqual(s1.listTransitions(r1.id), s2.listTransitions(r2.id));
  assert.deepEqual(s1.listSamples(r1.id).map((s: any) => [s.seq, s.code]), s2.listSamples(r2.id).map((s: any) => [s.seq, s.code]));
});

test("幂等键重复提交不产生重复记录", () => {
  const s = new Service(openDb(tempDb()));
  const r = s.createRule("idem", 3);
  const batch = [{ seq: 1, code: "000" }, { seq: 2, code: "001" }];
  const a = s.appendSamples(r.id, batch, "key-x", { explicitSeq: true });
  const b = s.appendSamples(r.id, batch, "key-x", { explicitSeq: true });
  assert.equal(a.accepted, 2);
  assert.equal(b.accepted, 0);
  assert.equal(b.idempotent, true);
  assert.equal(s.listSamples(r.id).length, 2);
});

test("顺序缺口报错且不留半批数据", () => {
  const s = new Service(openDb(tempDb()));
  const r = s.createRule("gap", 3);
  assert.throws(
    () => s.appendSamples(r.id, [{ seq: 1, code: "000" }, { seq: 3, code: "001" }], "g1", { explicitSeq: true }),
    (e: any) => e.code === "SEQ_GAP"
  );
  assert.equal(s.listSamples(r.id).length, 0);
  // 非法码字批次同样整体回滚
  assert.throws(
    () => s.appendSamples(r.id, [{ seq: 1, code: "000" }, { seq: 2, code: "0x1" }], "g2", { explicitSeq: true }),
    (e: any) => e.code === "INVALID_CODE"
  );
  assert.equal(s.listSamples(r.id).length, 0);
});

test("重启后继续核验与不中断一致", () => {
  const db = tempDb();
  const codes = ["000", "001", "011", "111", "000"];
  const s1 = new Service(openDb(db));
  const r = s1.createRule("resume", 3);
  s1.appendSamples(r.id, codes.slice(0, 2).map((code, i) => ({ seq: i + 1, code })), "p1", { explicitSeq: true });
  // 模拟重启：重新打开数据库
  const s2 = new Service(openDb(db));
  s2.appendSamples(r.id, codes.slice(2).map((code, i) => ({ seq: i + 3, code })), "p2", { explicitSeq: true });

  const s3 = new Service(openDb(tempDb()));
  const r3 = s3.createRule("oneshot", 3);
  s3.appendSamples(r3.id, codes.map((code, i) => ({ seq: i + 1, code })), "all", { explicitSeq: true });
  assert.deepEqual(s2.listTransitions(r.id), s3.listTransitions(r3.id));
});

test("码表区间与上限", () => {
  const s = new Service(openDb(tempDb()));
  const r = s.createRule("tbl", 10);
  const t = s.table(r.id, 0n, 9n);
  assert.equal(t.count, 10);
  assert.throws(() => s.table(r.id, 0n, 1023n, 100), (e: any) => e.code === "LIMIT_EXCEEDED");
  assert.throws(() => s.table(r.id, 0n, 1024n), (e: any) => e.code === "POSITION_OUT_OF_RANGE");
});
