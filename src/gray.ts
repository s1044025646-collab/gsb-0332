/** 反射格雷码核心转换（BigInt 实现，支持任意位宽，不使用 32 位位运算）。 */

export const MIN_WIDTH = 1;
export const MAX_WIDTH = 128;

export class GrayError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "GrayError";
  }
}

export function assertWidth(n: number): void {
  if (!Number.isInteger(n) || n < MIN_WIDTH || n > MAX_WIDTH) {
    throw new GrayError("INVALID_WIDTH", `非法位宽 ${n}，允许范围 ${MIN_WIDTH}..${MAX_WIDTH}`);
  }
}

export function modulus(n: number): bigint {
  return 1n << BigInt(n);
}

export function maxPosition(n: number): bigint {
  return modulus(n) - 1n;
}

/** 位置 -> 定宽格雷码字符串。位置必须满足 0 <= pos < 2^n。 */
export function encode(position: bigint, n: number): string {
  assertWidth(n);
  if (position < 0n || position > maxPosition(n)) {
    throw new GrayError("POSITION_OUT_OF_RANGE", `位置 ${position} 超出位宽 ${n} 的范围 0..${maxPosition(n)}`);
  }
  const g = position ^ (position >> 1n);
  return g.toString(2).padStart(n, "0");
}

/** 定宽格雷码字符串 -> 位置。码字必须长度恰为 n 且只含 0/1。 */
export function decode(code: string, n: number): bigint {
  assertWidth(n);
  if (typeof code !== "string" || code.length !== n || !/^[01]+$/.test(code)) {
    throw new GrayError("INVALID_CODE", `非法码字 "${code}"：必须是长度 ${n} 的 0/1 字符串`);
  }
  let pos = 0n;
  let acc = 0n;
  for (let i = 0; i < n; i++) {
    const bit = BigInt(code.charCodeAt(i) - 48);
    acc = acc ^ bit;
    pos = (pos << 1n) | acc;
  }
  return pos;
}

/** 独立递归反射法生成完整码序列（仅用于小位宽核对）。 */
export function reflectSequence(n: number): string[] {
  assertWidth(n);
  if (n === 1) return ["0", "1"];
  const prev = reflectSequence(n - 1);
  const out: string[] = [];
  for (const c of prev) out.push("0" + c);
  for (let i = prev.length - 1; i >= 0; i--) out.push("1" + prev[i]);
  return out;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new GrayError("INVALID_CODE", "汉明距离要求两码字等长");
  }
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export function changedBits(a: string, b: string): number[] {
  const bits: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) bits.push(i);
  return bits;
}

export type TransitionKind = "still" | "step" | "jump";
export type Direction = "forward" | "backward" | "ambiguous" | "none";

export interface TransitionVerdict {
  kind: TransitionKind;
  direction: Direction;
  /** 模位置差 (to - from) mod 2^n，十进制字符串 */
  delta: string;
  reason: string;
}

/** 在“一次采样最多移动一个位置”的假设下判定相邻两次采样。 */
export function judge(fromPos: bigint, toPos: bigint, n: number): TransitionVerdict {
  const mod = modulus(n);
  const delta = ((toPos - fromPos) % mod + mod) % mod;
  if (delta === 0n) {
    // 注意：静止码字不代表设备未转整周，只表示两次采样位置相同。
    return { kind: "still", direction: "none", delta: "0", reason: "两次采样解码位置相同（模差 0），判定为静止；无法据此排除漏采整周" };
  }
  if (delta === 1n && delta === mod - 1n) {
    // n = 1 时 +1 与 -1 模 2 同余，方向不可区分。
    return { kind: "step", direction: "ambiguous", delta: "1", reason: "位宽为 1 时正向一步与反向一步同余，方向不确定" };
  }
  if (delta === 1n) {
    return { kind: "step", direction: "forward", delta: "1", reason: "模位置差为 +1（含末位置回绕到 0），判定为正向一步" };
  }
  if (delta === mod - 1n) {
    return { kind: "step", direction: "backward", delta: (mod - 1n).toString(), reason: "模位置差为 -1（模 2^n），判定为反向一步" };
  }
  return { kind: "jump", direction: "none", delta: delta.toString(), reason: `模位置差为 ${delta}，超出一步范围，判定为跳变；不自动修正或补造中间采样` };
}
