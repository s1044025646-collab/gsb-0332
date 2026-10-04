/** 反射格雷码核心：全部使用 BigInt，避免 32 位位运算截断与安全整数溢出。 */

export const MIN_BITS = 1;
export const MAX_BITS = 128;
/** 码表区间返回数量上限（防止枚举巨大码表）。 */
export const MAX_TABLE_ENTRIES = 4096;

export class GrayError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "GrayError";
  }
}

export function assertBits(n: number): void {
  if (!Number.isInteger(n) || n < MIN_BITS || n > MAX_BITS) {
    throw new GrayError("E_BITS", `非法位宽 n=${n}，允许范围 ${MIN_BITS}..${MAX_BITS}`);
  }
}

export function maxPosition(bits: number): bigint {
  assertBits(bits);
  return (1n << BigInt(bits)) - 1n;
}

export function parsePosition(pos: bigint | string | number, bits: number): bigint {
  let p: bigint;
  if (typeof pos === "bigint") p = pos;
  else if (typeof pos === "number") {
    if (!Number.isSafeInteger(pos)) throw new GrayError("E_POSITION", `位置 ${pos} 超出安全整数范围，请使用十进制字符串`);
    p = BigInt(pos);
  } else if (typeof pos === "string" && /^-?\d+$/.test(pos)) p = BigInt(pos);
  else throw new GrayError("E_POSITION", `位置格式非法: ${String(pos)}`);
  if (p < 0n) throw new GrayError("E_POSITION", `位置不能为负: ${p}`);
  if (p > maxPosition(bits)) throw new GrayError("E_POSITION", `位置 ${p} 超出位宽 ${bits} 的最大值 ${maxPosition(bits)}`);
  return p;
}

/** 位置 -> 定宽格雷码字符串（保留前导零）。 */
export function encode(pos: bigint | string | number, bits: number): string {
  const p = parsePosition(pos, bits);
  const g = p ^ (p >> 1n);
  return g.toString(2).padStart(bits, "0");
}

/** 定宽格雷码 -> 位置（BigInt）。 */
export function decode(code: string, bits: number): bigint {
  assertBits(bits);
  if (typeof code !== "string" || code.length !== bits || !/^[01]+$/.test(code)) {
    throw new GrayError("E_CODEWORD", `码字必须是长度 ${bits} 且仅含 0/1 的字符串，收到: ${JSON.stringify(code)}`);
  }
  let g = 0n;
  for (const c of code) g = (g << 1n) | BigInt(c === "1");
  // 从高位到低位累计异或
  let b = 0n;
  let acc = 0n;
  for (let i = bits - 1; i >= 0; i--) {
    acc ^= (g >> BigInt(i)) & 1n;
    b |= acc << BigInt(i);
  }
  return b;
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) throw new GrayError("E_CODEWORD", "比较的两个码字位宽不一致");
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** 变化位下标（从左到右 0 基），仅用于展示。 */
export function changedBits(a: string, b: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

export type Direction = "stationary" | "forward" | "reverse" | "ambiguous" | "jump";

export interface TransitionVerdict {
  direction: Direction;
  hamming: number;
  /** 模位置差（正向方向，0..2^n-1） */
  delta: string;
  changedBits: number[];
  reason: string;
}

/** 在“一次采样最多移动一个位置”的假设下判定转移。 */
export function judge(prevCode: string, nextCode: string, bits: number): TransitionVerdict {
  const prev = decode(prevCode, bits);
  const next = decode(nextCode, bits);
  const mod = 1n << BigInt(bits);
  const delta = (next - prev + mod) % mod;
  const h = hamming(prevCode, nextCode);
  const cb = changedBits(prevCode, nextCode);
  if (delta === 0n) {
    return { direction: "stationary", hamming: h, delta: "0", changedBits: cb,
      reason: "码字与解码位置均不变：静止（不能据此推断设备未转整周）" };
  }
  if (bits === 1 && (delta === 1n || delta === mod - 1n)) {
    return { direction: "ambiguous", hamming: h, delta: delta.toString(), changedBits: cb,
      reason: "位宽为 1 时两个位置互为正反一步，方向不确定" };
  }
  if (delta === 1n) {
    return { direction: "forward", hamming: h, delta: "1", changedBits: cb,
      reason: `解码后模位置差为 +1：正向一步（汉明距离 ${h}）` };
  }
  if (delta === mod - 1n) {
    return { direction: "reverse", hamming: h, delta: (mod - 1n).toString(), changedBits: cb,
      reason: `解码后模位置差为 -1（模 ${mod} 为 ${mod - 1n}）：反向一步（汉明距离 ${h}）` };
  }
  return { direction: "jump", hamming: h, delta: delta.toString(), changedBits: cb,
    reason: `解码后模位置差为 ${delta}，超出 ±1：跳变（不自动修正、不补造中间采样）` };
}

/** 独立递归反射法生成完整码序列（仅用于小位宽核对）。 */
export function reflectSequence(bits: number): string[] {
  assertBits(bits);
  if (bits === 1) return ["0", "1"];
  const prev = reflectSequence(bits - 1);
  const out: string[] = [];
  for (const c of prev) out.push("0" + c);
  for (let i = prev.length - 1; i >= 0; i--) out.push("1" + prev[i]);
  return out;
}

/** 生成限定区间 [start, start+count) 的码表（沿位置递增，不模回绕）。 */
export function table(bits: number, start: bigint | string | number, count: number) {
  assertBits(bits);
  const s = parsePosition(start, bits);
  if (!Number.isInteger(count) || count < 1 || count > MAX_TABLE_ENTRIES) {
    throw new GrayError("E_RANGE", `区间数量须为 1..${MAX_TABLE_ENTRIES} 的整数，收到 ${count}`);
  }
  const max = maxPosition(bits);
  const avail = Number(max - s + 1n);
  const n = Math.min(count, avail);
  const rows: { position: string; code: string }[] = [];
  for (let i = 0; i < n; i++) {
    const p = s + BigInt(i);
    rows.push({ position: p.toString(), code: encode(p, bits) });
  }
  return { bits, start: s.toString(), count: n, truncated: n < count, entries: rows };
}
