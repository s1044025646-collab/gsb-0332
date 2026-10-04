import { DatabaseSync } from "node:sqlite";
import {
  GrayError, assertWidth, decode, encode, hammingDistance, changedBits, judge, maxPosition,
} from "./gray";

export const TABLE_LIMIT_DEFAULT = 1024;
export const TABLE_LIMIT_MAX = 65536;

export interface SampleInput { seq?: number; code: string }

export class Service {
  constructor(private db: DatabaseSync) {}

  createRule(name: string, width: number, bitOrder: string = "msb-first") {
    if (!name || typeof name !== "string") throw new GrayError("VALIDATION", "规则名称不能为空");
    assertWidth(width);
    if (bitOrder !== "msb-first") throw new GrayError("VALIDATION", "当前仅支持 msb-first 位序");
    const r = this.db.prepare("INSERT INTO rules (name, width, bit_order) VALUES (?, ?, ?)").run(name, width, bitOrder);
    return this.getRule(Number(r.lastInsertRowid));
  }

  getRule(id: number) {
    const row = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as any;
    if (!row) throw new GrayError("RULE_NOT_FOUND", `规则 ${id} 不存在`);
    return { id: row.id, name: row.name, width: row.width, bitOrder: row.bit_order, createdAt: row.created_at };
  }

  listRules() {
    return (this.db.prepare("SELECT * FROM rules ORDER BY id").all() as any[]).map((r) => ({
      id: r.id, name: r.name, width: r.width, bitOrder: r.bit_order, createdAt: r.created_at,
    }));
  }

  private widthOf(ruleId: number): number {
    return this.getRule(ruleId).width;
  }

  /** 生成 [from, to] 闭区间的码表，数量受 limit 限制，绝不枚举巨大完整码表。 */
  table(ruleId: number, from: bigint, to: bigint, limit: number = TABLE_LIMIT_DEFAULT) {
    const width = this.widthOf(ruleId);
    if (!Number.isInteger(limit) || limit < 1 || limit > TABLE_LIMIT_MAX) {
      throw new GrayError("LIMIT_EXCEEDED", `返回数量上限为 ${TABLE_LIMIT_MAX}`);
    }
    if (from < 0n || to > maxPosition(width) || from > to) {
      throw new GrayError("POSITION_OUT_OF_RANGE", `区间须满足 0 <= from <= to <= ${maxPosition(width)}`);
    }
    const count = to - from + 1n;
    if (count > BigInt(limit)) {
      throw new GrayError("LIMIT_EXCEEDED", `区间含 ${count} 项，超过上限 ${limit}；请缩小区间或调整 limit`);
    }
    const rows: { position: string; code: string }[] = [];
    for (let p = from; p <= to; p++) rows.push({ position: p.toString(), code: encode(p, width) });
    return { ruleId, width, from: from.toString(), to: to.toString(), count: rows.length, rows };
  }

  /** 追加一批采样（导入与追加共用同一事务路径）。幂等键重复时返回已有结果，不产生重复记录。 */
  appendSamples(ruleId: number, samples: SampleInput[], idempotencyKey: string, opts: { explicitSeq: boolean }) {
    const width = this.widthOf(ruleId);
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new GrayError("VALIDATION", "必须提供非空幂等键 idempotencyKey");
    }
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new GrayError("VALIDATION", "采样批次不能为空");
    }
    const existing = this.db.prepare("SELECT * FROM batches WHERE rule_id = ? AND idempotency_key = ?").get(ruleId, idempotencyKey) as any;
    if (existing) {
      return { ruleId, idempotent: true, fromSeq: existing.from_seq, toSeq: existing.to_seq, accepted: 0, transitions: [] as any[] };
    }
    const state = this.db.prepare("SELECT * FROM state WHERE rule_id = ?").get(ruleId) as any;
    let nextSeq = state ? Number(state.last_seq) + 1 : 1;

    // 先整体校验，再入事务，保证导入错误不留下半批数据。
    const prepared: { seq: number; code: string; position: bigint }[] = [];
    for (const s of samples) {
      if (opts.explicitSeq) {
        if (!Number.isInteger(s.seq)) throw new GrayError("SEQ_GAP", "显式编号模式下每个采样必须带整数 seq");
        if (s.seq !== nextSeq) throw new GrayError("SEQ_GAP", `顺序缺口：期望 seq=${nextSeq}，收到 seq=${s.seq}`);
      }
      const position = decode(s.code, width); // 同时校验码字合法性
      prepared.push({ seq: nextSeq, code: s.code, position });
      nextSeq++;
    }

    const transitions: any[] = [];
    this.db.exec("BEGIN");
    try {
      const insSample = this.db.prepare("INSERT INTO samples (rule_id, seq, code, position, batch_key) VALUES (?, ?, ?, ?, ?)");
      const insTrans = this.db.prepare("INSERT INTO transitions (rule_id, seq, from_code, to_code, hamming, changed_bits, delta, kind, direction, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      let prevCode = state ? String(state.last_code) : null;
      let prevPos = state ? BigInt(state.last_position) : null;
      for (const p of prepared) {
        insSample.run(ruleId, p.seq, p.code, p.position.toString(), idempotencyKey);
        if (prevCode !== null && prevPos !== null) {
          const v = judge(prevPos, p.position, width);
          const ham = hammingDistance(prevCode, p.code);
          const bits = changedBits(prevCode, p.code);
          insTrans.run(ruleId, p.seq, prevCode, p.code, ham, JSON.stringify(bits), v.delta, v.kind, v.direction, v.reason);
          transitions.push({ seq: p.seq, fromCode: prevCode, toCode: p.code, hamming: ham, changedBits: bits, ...v });
        }
        prevCode = p.code;
        prevPos = p.position;
      }
      const last = prepared[prepared.length - 1];
      this.db.prepare(
        "INSERT INTO state (rule_id, last_seq, last_code, last_position) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(rule_id) DO UPDATE SET last_seq=excluded.last_seq, last_code=excluded.last_code, last_position=excluded.last_position"
      ).run(ruleId, last.seq, last.code, last.position.toString());
      this.db.prepare("INSERT INTO batches (rule_id, idempotency_key, from_seq, to_seq) VALUES (?, ?, ?, ?)")
        .run(ruleId, idempotencyKey, prepared[0].seq, last.seq);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { ruleId, idempotent: false, fromSeq: prepared[0].seq, toSeq: prepared[prepared.length - 1].seq, accepted: prepared.length, transitions };
  }

  listSamples(ruleId: number) {
    this.widthOf(ruleId);
    return (this.db.prepare("SELECT seq, code, position, batch_key AS batchKey FROM samples WHERE rule_id = ? ORDER BY seq").all(ruleId) as any[]);
  }

  listTransitions(ruleId: number, onlyJumps = false) {
    this.widthOf(ruleId);
    const sql = "SELECT seq, from_code AS fromCode, to_code AS toCode, hamming, changed_bits AS changedBits, delta, kind, direction, reason FROM transitions WHERE rule_id = ?" +
      (onlyJumps ? " AND kind = 'jump'" : "") + " ORDER BY seq";
    return (this.db.prepare(sql).all(ruleId) as any[]).map((r) => ({ ...r, changedBits: JSON.parse(r.changedBits) }));
  }

  report(ruleId: number) {
    const rule = this.getRule(ruleId);
    const samples = this.listSamples(ruleId);
    const transitions = this.listTransitions(ruleId);
    const summary = { still: 0, stepForward: 0, stepBackward: 0, stepAmbiguous: 0, jump: 0 };
    for (const t of transitions) {
      if (t.kind === "still") summary.still++;
      else if (t.kind === "jump") summary.jump++;
      else if (t.direction === "forward") summary.stepForward++;
      else if (t.direction === "backward") summary.stepBackward++;
      else summary.stepAmbiguous++;
    }
    return { rule, sampleCount: samples.length, samples, transitions, summary };
  }
}
