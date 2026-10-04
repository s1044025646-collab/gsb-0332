# 反射格雷码位置解码与采样跳变核验后端

离线位置编码分析服务：TypeScript + Node.js + SQLite（`node:sqlite` 内置模块，无原生依赖），仅提供 HTTP API 与 CLI，Windows 本地直接运行，不依赖 Docker / WSL / 外部在线服务。

## 功能

- 位宽 `n`（1..128）下位置 `0 .. 2^n - 1` 与定宽反射格雷码互转（首位相连环形）。
- 编码：`g = pos ^ (pos >> 1)`；解码：从高位到低位累计异或。全部使用 BigInt，超过 2^53 的数值以十进制字符串交换，前导零保留，不使用 32 位有符号位运算。
- 采样核验：同时给出相邻码字的汉明距离、变化位与解码后的模位置差，区分 `still` / `step(forward|backward|ambiguous)` / `jump`。
- 规则创建后位宽与位序锁定；采样编号必须连续；批次幂等键去重；追加批次与末状态在同一事务提交；导入失败整体回滚。
- 码表仅按限定区间生成，默认上限 1024、硬上限 65536，不枚举巨大完整码表。

## 运动假设与限制（重要）

- 假设“一次采样最多移动一个位置”。在此假设下，模位置差 `+1` 判正向一步、`-1` 判反向一步、`0` 判静止，其余判跳变。
- 单比特变化只是线索，不能替代解码后的相邻判断：例如三位码 `000 -> 010` 汉明距离为 1，但解码为 `0 -> 3`，模差 3，判定为跳变。
- 位宽为 1 时，两个位置间的跳变同时满足正反方向（`+1 ≡ -1 (mod 2)`），方向标记为 `ambiguous`，不任意宣称方向。
- 静止码字不代表设备必然未转整周：若漏采，设备可能已转过整圈，码字无法区分。
- 跳变数据不用于虚构累计圈数，不自动修正、不补造中间采样；只记录由相邻样本直接得到的结论。
- 本服务不连接真实传感器、不模拟无线噪声、不推断未观测到的真实运动轨迹。

## 构建 / 测试 / 启动

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 构建并运行 node:test 测试
npm start         # 启动 API（默认由系统分配空闲端口，PORT 环境变量可指定）
npm run demo      # 三位码表完整循环 + 静止/正反一步/单比特非相邻样例
```

数据目录默认为项目内 `data/`（可用 `GRAY_DATA_DIR`、`GRAY_DB_PATH` 覆盖），重启后核验状态不丢失。

## HTTP API

所有请求/响应均为 JSON；大整数（位置、模差）以十进制字符串表示。错误响应形如 `{ "error": "<错误码>", "message": "..." }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/rules` | 创建规则 `{name, width, bitOrder?}`，位宽创建后锁定 |
| GET | `/rules`、`/rules/:id` | 查询规则 |
| POST | `/encode` | `{width, position}` → `{code}` |
| POST | `/decode` | `{width, code}` → `{position}` |
| GET | `/rules/:id/table?from=&to=&limit=` | 限定区间码表（limit ≤ 65536） |
| POST | `/rules/:id/samples/import` | `{samples:[{seq,code}], idempotencyKey}` 显式编号导入 |
| POST | `/rules/:id/samples/append` | `{samples:[{code}], idempotencyKey}` 自动连续编号追加 |
| GET | `/rules/:id/samples` | 原始采样 |
| GET | `/rules/:id/transitions` | 全部转移记录 |
| GET | `/rules/:id/jumps` | 仅跳变 |
| GET | `/rules/:id/report` | 汇总报告（计数 + 明细） |

错误码：`INVALID_WIDTH`、`INVALID_CODE`、`POSITION_OUT_OF_RANGE`、`SEQ_GAP`、`RULE_NOT_FOUND`、`LIMIT_EXCEEDED`、`VALIDATION`。

## CLI

```powershell
npm run build
node dist/src/cli.js encode 3 5            # -> 111
node dist/src/cli.js decode 3 111          # -> 5
node dist/src/cli.js table 3               # 三位完整循环码表
node dist/src/cli.js rule create enc 3     # 创建规则（输出规则 id）
node dist/src/cli.js import 1 samples.json batch-1
node dist/src/cli.js append 1 batch-2 110 111
node dist/src/cli.js jumps 1
node dist/src/cli.js report 1
node dist/src/cli.js serve 8080
node dist/src/cli.js demo
```

转移输出包含码字、解码位置、汉明距离、变化位、模位置差与判定理由。

## 持久化

SQLite 表：`rules`（位宽/位序锁定）、`samples`（原始采样 + 解码位置 + 批次键）、`transitions`（相邻样本转移结论）、`state`（每规则末状态）、`batches`（幂等键）。追加批次与末状态在同一事务提交；重复幂等键直接返回原批次结果，不产生重复记录。新规则拥有独立会话，不会用不同位宽重新解释旧采样。

## 测试覆盖

- 位宽 1..6 递归反射序列与公式编码互核、相邻（含首尾回绕）汉明距离为 1。
- 全零、最大位置、大于 32 位的高位值、前导零保留。
- 回绕（末位置→0 为正向一步）、位宽 1 方向歧义、单比特非相邻（`000->010`）判跳变。
- 分批追加与一次导入结果一致、幂等键去重、顺序缺口/非法码字整体回滚、重启后继续核验一致、码表区间与上限。
