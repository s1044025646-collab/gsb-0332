import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  GrayError, assertBits, decode, encode, judge, maxPosition, parsePosition,
  type TransitionVerdict,
} from "./gray.js";

export interface RuleRow { id: number; bits: number; bit_order: string; created_at: string; }
export interface SampleRow {
  id: number; rule_id: number; seq: number; code: string; position: string;
  prev_code: string | null; prev_position: string | null; idempotency_key: string | null;
}
export interface TransitionRow {
  id: number; rule_id: number; from_seq: number; to_seq: number;
  from_code: string; to_code: string; from_position: string; to_position: string;
  hamming: number; delta: string; direction: string; changed_bits: string; reason: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bits INTEGER NOT NULL,
        bit_order TEXT NOT NULL DEFAULT 'msb-first',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        seq INTEGER NOT NULL,
        code TEXT NOT NULL,
        position TEXT NOT NULL,
        prev_code TEXT,
        prev_position TEXT,
        idempotency_key TEXT,
        UNIQUE (rule_id, seq),
        UNIQUE (rule_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        from_code TEXT NOT NULL,
        to_code TEXT NOT NULL,
        from_position TEXT NOT NULL,
        to_position TEXT NOT NULL,
        hamming INTEGER NOT NULL,
        delta TEXT NOT NULL,
        direction TEXT NOT NULL,
        changed_bits TEXT NOT NULL,
        reason TEXT NOT NULL,
        UNIQUE (rule_id, from_seq, to_seq)
      );
    `);
  }

  close(): void { this.db.close(); }

  createRule(bits: number): RuleRow {
    assertBits(bits);
    const r = this.db.prepare("INSERT INTO rules (bits, bit_order) VALUES (?, 'msb-first')").run(bits);
    return this.getRule(Number(r.lastInsertRowid));
  }

  getRule(ruleId: number): RuleRow {
    const row = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(ruleId) as RuleRow | undefined;
    if (!row) throw new GrayError("E_RULE", `规则 ${ruleId} 不存在`);
    return row;
  }

  listRules(): RuleRow[] {
    return this.db.prepare("SELECT * FROM rules ORDER BY id").all() as unknown as RuleRow[];
  }

  /** 追加一批采样；同一事务写入样本、转移与末状态。幂等键重复时返回已存在记录。 */
  appendSamples(ruleId: number, items: { seq: number; code: string; idempotencyKey?: string }[]): {
    inserted: SampleRow[]; duplicates: SampleRow[]; transitions: TransitionRow[];
  } {
    const rule = this.getRule(ruleId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new GrayError("E_BATCH", "采样批次不能为空");
    }
    // 先整体校验，避免半批数据
    const seen = new Set<number>();
    for (const it of items) {
      if (!Number.isInteger(it.seq) || it.seq < 1) throw new GrayError("E_SEQ", `采样编号必须为正整数: ${it.seq}`);
      if (seen.has(it.seq)) throw new GrayError("E_SEQ", `批次内采样编号重复: ${it.seq}`);
      seen.add(it.seq);
      decode(it.code, rule.bits); // 校验码字，顺便验证位宽
    }

    const inserted: SampleRow[] = [];
    const duplicates: SampleRow[] = [];
    const transitions: TransitionRow[] = [];

    this.db.exec("BEGIN");
    try {
      for (const it of items) {
        if (it.idempotencyKey != null) {
          const dup = this.db.prepare(
            "SELECT * FROM samples WHERE rule_id = ? AND idempotency_key = ?",
          ).get(ruleId, it.idempotencyKey) as SampleRow | undefined;
          if (dup) {
            if (dup.seq !== it.seq || dup.code !== it.code) {
              throw new GrayError("E_IDEMPOTENCY",
                `幂等键 ${it.idempotencyKey} 已用于不同内容（seq=${dup.seq}, code=${dup.code}）`);
            }
            duplicates.push(dup);
            continue;
          }
        }
        const last = this.db.prepare(
          "SELECT * FROM samples WHERE rule_id = ? ORDER BY seq DESC LIMIT 1",
        ).get(ruleId) as SampleRow | undefined;
        const expected = last ? last.seq + 1 : 1;
        if (it.seq !== expected) {
          throw new GrayError("E_SEQ", `采样编号不连续：期望 ${expected}，收到 ${it.seq}（存在顺序缺口）`);
        }
        const position = decode(it.code, rule.bits).toString();
        const prevCode = last ? last.code : null;
        const prevPos = last ? last.position : null;
        const r = this.db.prepare(
          `INSERT INTO samples (rule_id, seq, code, position, prev_code, prev_position, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(ruleId, it.seq, it.code, position, prevCode, prevPos, it.idempotencyKey ?? null);
        const sample = this.db.prepare("SELECT * FROM samples WHERE id = ?")
          .get(Number(r.lastInsertRowid)) as unknown as SampleRow;
        inserted.push(sample);
        if (last) {
          const v: TransitionVerdict = judge(last.code, it.code, rule.bits);
          const tr = this.db.prepare(
            `INSERT INTO transitions
             (rule_id, from_seq, to_seq, from_code, to_code, from_position, to_position,
              hamming, delta, direction, changed_bits, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(ruleId, last.seq, it.seq, last.code, it.code, last.position, position,
            v.hamming, v.delta, v.direction, JSON.stringify(v.changedBits), v.reason);
          transitions.push(this.db.prepare("SELECT * FROM transitions WHERE id = ?")
            .get(Number(tr.lastInsertRowid)) as unknown as TransitionRow);
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { inserted, duplicates, transitions };
  }

  listSamples(ruleId: number): SampleRow[] {
    this.getRule(ruleId);
    return this.db.prepare("SELECT * FROM samples WHERE rule_id = ? ORDER BY seq")
      .all(ruleId) as unknown as SampleRow[];
  }

  listTransitions(ruleId: number, direction?: string): TransitionRow[] {
    this.getRule(ruleId);
    if (direction) {
      return this.db.prepare(
        "SELECT * FROM transitions WHERE rule_id = ? AND direction = ? ORDER BY from_seq",
      ).all(ruleId, direction) as unknown as TransitionRow[];
    }
    return this.db.prepare("SELECT * FROM transitions WHERE rule_id = ? ORDER BY from_seq")
      .all(ruleId) as unknown as TransitionRow[];
  }

  report(ruleId: number) {
    const rule = this.getRule(ruleId);
    const samples = this.listSamples(ruleId);
    const transitions = this.listTransitions(ruleId);
    const counts: Record<string, number> = {};
    for (const t of transitions) counts[t.direction] = (counts[t.direction] ?? 0) + 1;
    return {
      rule,
      maxPosition: maxPosition(rule.bits).toString(),
      sampleCount: samples.length,
      transitionCount: transitions.length,
      counts,
      samples,
      transitions,
    };
  }
}
