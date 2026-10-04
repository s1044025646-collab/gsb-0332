# 反射格雷码位置解码与采样跳变核验后端

纯本地运行的离线位置编码分析服务：TypeScript + Node.js + SQLite（`node:sqlite` 内置模块），仅提供 HTTP API 与 CLI，不连接真实传感器、不模拟无线噪声、不依赖 Docker/WSL/在线服务。

## 环境要求

- Windows 本地，Node.js >= 22.5（开发使用 Node 25 验证）
- 无原生模块编译依赖

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # 运行演示：三位码表循环 + 各类转移样例
```

环境变量：

- `PORT`：指定监听端口；不设置时自动选择空闲端口
- `GRAY_DB`：SQLite 数据库文件路径，默认 `data/gray.db`（项目内数据目录）

## 核心规则

- 编码：`gray = position ^ (position >> 1)`，输出定宽字符串并保留前导零
- 解码：从高位到低位累计异或还原二进制位置
- 位置范围：`0 .. 2^n - 1`，首尾相连（模 `2^n` 环）
- 位宽 `n`：1..128；超过安全整数的数值一律用 BigInt，API/CLI 以十进制字符串交换
- 码表区间单次最多返回 4096 条，不枚举巨大完整码表

## 采样运动假设与限制（重要）

- 假设“一次采样最多移动一个位置”。在此假设下判定：静止 / 正向一步 / 反向一步 / 跳变
- 判定依据是**解码后的模位置差**，单比特变化（汉明距离 1）只是线索，不能替代相邻判断。例如三位码 `000 -> 010` 汉明距离为 1，但解码后是位置 0 -> 3，属于跳变
- 末位置到零（如三位 `100 -> 000`，即 7 -> 0）按正向一步识别，反向回绕同理
- 位宽为 1 时两个位置互为正反一步，判定为 `ambiguous`（方向不确定），不任意宣称方向
- 明显跳变只如实记录，**不自动修正、不补造中间采样、不虚构累计圈数**
- 静止码字不能解释为“设备必然未转整周”：若漏采了整周运动，码字无法区分，本系统也不做此类推断
- 只记录由相邻样本直接得到的结论，不推断未观测到的真实运动轨迹

## HTTP API

统一错误格式：`{ "error": { "code": "...", "message": "..." } }`，HTTP 400（参数类）/ 404 / 500。

- GET  `/meta`：公开位宽范围与码表数量上限
- POST `/rules`：创建编码规则 `{ "bits": 3 }`，创建后锁定位宽与位序（msb-first）
- GET  `/rules`、`/rules/:id`：查询规则
- POST `/encode`：`{ "bits": 3, "position": "5" }` -> `{ "code": "111" }`
- POST `/decode`：`{ "bits": 3, "code": "111" }` -> `{ "position": "5" }`
- GET  `/table?bits=3&start=0&count=8`：限定区间码表（count <= 4096，超出报错；接近末尾自动截断并标记 truncated）
- POST `/rules/:id/samples`：追加采样，单条 `{ "seq": 1, "code": "000", "idempotencyKey": "k1" }` 或批量 `{ "samples": [...] }`
- GET  `/rules/:id/samples`：查询原始采样（含解码位置与上一码字）
- GET  `/rules/:id/transitions?direction=jump`：查询转移记录，可按方向过滤
- GET  `/rules/:id/report`：导出核验报告（统计 + 明细）

错误码：`E_BITS`（非法位宽）、`E_POSITION`（位置为负/越界/格式非法）、`E_CODEWORD`（码字长度或字符非法）、`E_RANGE`（区间数量超限）、`E_SEQ`（采样编号缺口）、`E_IDEMPOTENCY`（幂等键冲突）、`E_RULE`（规则不存在）、`E_BATCH`、`E_JSON`、`E_NOT_FOUND`。

### 持久化与一致性

- SQLite 保存规则、原始采样（含上一位置）与转移记录
- 每个追加批次与其产生的转移记录在同一事务提交；批次中任一采样非法则整批回滚，不留半批数据
- 采样编号 `seq` 必须连续（从 1 开始逐条 +1），缺口明确报 `E_SEQ`
- `idempotencyKey` 唯一约束保证重复提交幂等：同键同内容返回已有记录，同键不同内容报 `E_IDEMPOTENCY`
- 重启后从数据库恢复末状态，继续核验与不中断输入结果一致（有测试覆盖）
- 每条规则独立会话，位宽创建即锁定，不会用不同位宽重新解释旧采样

## CLI

```powershell
node dist/cli.js encode 3 5                 # -> 111
node dist/cli.js decode 3 111               # -> 5
node dist/cli.js table 3 0 8                # 三位完整码表
node dist/cli.js judge 3 000 010            # 单比特但非相邻 -> jump
node dist/cli.js rule-create 3
node dist/cli.js sample-add 1 1 000 key-1
node dist/cli.js transitions 1
node dist/cli.js report 1
```

CLI 展示码字、解码位置、变化位下标、汉明距离、模位置差与判定理由。

## 三位码表与典型样例

```
位置 0 -> 000     位置 4 -> 110
位置 1 -> 001     位置 5 -> 111
位置 2 -> 011     位置 6 -> 101
位置 3 -> 010     位置 7 -> 100   （100 -> 000 回绕也算一步）
```

- 静止：`000 -> 000`，汉明 0
- 正向一步：`000 -> 001`（0->1）、`100 -> 000`（7->0 回绕）
- 反向一步：`001 -> 000`（1->0）、`000 -> 100`（0->7 回绕）
- 单比特但非相邻：`000 -> 010`，汉明 1，但解码为 0->3，判定 `jump`
- 位宽 1：`0 -> 1` 判定 `ambiguous`

## 测试

`npm test` 覆盖：小位宽（1..6）用独立递归反射法生成码序列并核对全部编解码与相邻汉明距离；大于 32 位的高位值（64 位最大位置、2^63、33 位位宽）、全零、最大位置、回绕、一位方向歧义；分批追加与一次导入一致性、幂等键、顺序缺口回滚、重启恢复、规则间位宽隔离。

## 已知限制

- `node:sqlite` 在 Node 25 仍标记为实验特性，启动时会打印 ExperimentalWarning，不影响功能
- 服务监听 `127.0.0.1`，无鉴权，仅面向本机离线分析
- 位序固定为 msb-first（字符串最左为最高位）
