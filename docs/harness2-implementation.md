# Harness² 原生实现

本文件记录在本项目内以原生方式实现 **Harness² 递归自改进（Recurse Agent Harnessing）** 的设计、接口、持久化与限制。目标是用该能力取代自建的 Skill 自演进。旧 Skill 自演进的引擎、回归评测、界面入口与相关测试均已删除，仅保留 Harness²。

## 1. 目标与取舍

- 让 Agent **在使用中自我改进**：面对未通过的任务，自动提出对"运行配置（instructions + 工具白名单）"的修改，重新探测，直至通过；把通过的经验沉淀到经验库，并被后续同类任务复用。
- **不 eval 代码、不改仓库代码**：Harness 只是一份配置（系统提示 + 工具名白名单），被改进的对象是"配置"而非"程序"，因此安全边界清晰。
- **人工发布门**：模型自生成的候选经验默认不持久化，必须由用户在界面确认发布后才进入经验库；可回滚。
- 参考官方 `google-research/harness2` 的递归改进思路，但不引入其 Python/Linux 隔离执行栈（见 `docs/harness2-assessment.md`）。

## 2. 核心概念

- **Harness**：一次任务的运行配置，`{ instructions, tools }`。`instructions` 为系统提示（非空、≤20000 字符）；`tools` 为去重后的工具名列表（≤32 项、每项 ≤120 字符）。每个 Harness 有稳定 `id`（`h_` 前缀）与 `digest`（对规范化配置的哈希），用于判断"是否真的改变了"。
- **Propose → Probe → Compose**：
  - **Probe**：用某个 Harness 执行任务并校验结果，返回 `{passed:boolean}` 与输出/证据。
  - **Propose**：验证失败时，由模型基于"当前 Harness + 任务 + 上次输出/证据"提出补丁（`instructions` / `tools` / `rationale`）。
  - **Compose**：把补丁合并进当前 Harness 得到新 Harness（工具去重合并，instructions 覆盖）。
- **L1（单任务递归）**：一个任务内最多 `maxRounds`（默认 4）轮 propose→compose→probe。先探测种子配置作为基线；基线通过则无需改进（`improved=false`）。
- **L2（跨任务迁移）**：一次 suite 运行内，某域名下的任务被解决后，其 Harness 配置会作为**临时（provisional）**基线传给同一 suite 的后续同域任务，实现"经验在运行内复用"。provisional 仅本次运行有效，**不会**绕过人工发布门。

## 3. 模块划分

### 3.1 `client/agent/harness2.mjs`（纯引擎，无模型依赖）

可在无模型环境下确定性运行，便于测试。

导出的纯函数：

- `HARNESS2_VERSION = 1`
- `validateSpec(spec) -> { instructions, tools }`：规范化并校验 Harness 配置。
- `createHarness(spec) -> { id, digest, spec }`（`base_`/`h_` 前缀）。
- `composeHarness(base, patch)`：合并补丁，tools 去重。
- `normalizePatch(proposed)`：接受字符串（当作 instructions）或对象，只取 `instructions`/`tools`，`rationale` 兼容别名 `reason`；返回 `null` 表示无可采纳内容。
- `validateTask(task, index) -> { id, domain|null, input, expected, title }`：`id` 必填 string，`input` 为 string，`domain`/`expected` 可空。
- `createHarness2(opts)`

核心类 `Harness2`：

```js
new Harness2({ propose, execute, verify, baseSpec, maxRounds = 4 })
```

- `state = { version, base:{id,digest,spec}, library:[], candidates:[], audit:[] }`；内部 `_provisional` Map 保存本次 suite 的跨任务转移。
- `probe(task, harness) -> { taskId, harness:{id,digest}, patchRationale, output, passed, score, evidence }`（`verify` 必须返回 `{passed:boolean}`）。
- `runTask(rawTask) -> { taskId, domain, solved, seedDigest, harness, probes }`：先探测种子基线，未过则进入 L1 递归。
- `runSuite({ tasks, autoAdopt = false }) -> { tasks:[summarizeRun…], solved, total, candidates:[…] }`：逐任务 runTask；某任务被解决且 `harness.digest !== seedDigest` 时记一条候选，并把该域配置写入 provisional 供同 suite 后续任务使用；`autoAdopt` 时自动发布（测试用）。
- `promote(candidateId, { approvedBy = 'human' }) -> experience`：仅当候选状态为 `candidate` 且 `evaluation.passed` 为真才允许发布；写入 `library`，id 前缀 `exp_`。
- `rollback(entryId)`：从 `library` 移除并把对应候选标记 `rolled_back`。
- `adoptedFor(domain)`、`snapshot()`、`history(limit)`、`serialize()`、`Harness2.fromState(adapters, state)`。

ID 前缀：`base_` / `h_` / `cand_` / `exp_` / `audit_` + UUID(36)。审计 `audit` 记录 init / candidate / suite / promote 等事件。

**人工发布门**：候选不 `promote` 不落盘；suite 内 `_provisional` 仅本次运行有效，因而 L2 迁移与"必须人工确认才持久"两个约束可以同时成立。

### 3.2 `client/agent/harness2-runtime.mjs`（Pi agent core 适配）

把纯引擎接到项目已在用的 Pi（`pi-durable` 的 Harness / agent core）上。本层不再自带模型适配器，也不写独立状态文件；执行与提议都跑在真实的 Pi 会话里。

- `HARNESS2_BASE_SPEC = { instructions: '你是 CRM 销售助手。请依据用户提供的信息作答，缺少依据时说明待确认，不要编造客户事实。', tools: [] }`
- `Harness2State = defineDoc({ kind: 'crm.harness2', version: 1, scope: 'session', ... })`：保存 `base` / `library` / `candidates` / `audit` 以及 `workerConversationId` / `proposerConversationId`，**与聊天记录存在同一个 `session.sqlite`**。
- `parseProposal(text)`：解析模型输出——支持纯 JSON、```json 代码围栏、裸 JSON；解析失败但为普通散文时当作 instructions；明显是垃圾 JSON 时返回 `null`。
- `openHarness2({ harness, model, ready, extensions, baseSpec, maxRounds }) -> { snapshot, history, runSuite(tasks), promote(id), rollback(id) }`，其中 `harness` 必须是已打开的 Pi Harness。

会话复用：

- 首次运行按状态文档里的 `workerConversationId` / `proposerConversationId` 取回会话；没有则 `harness.createConversation({ ownership:{kind:'ownerless'}, agent:{ model, extensions, instructions } })` 创建，并把 id 写回文档。重启后复用同一会话，不无限增长数据库。
- **execute**：用候选 Harness 配置 `configure({ model, extensions, instructions })`，`reset` 清空上下文后提交 `task.input`。执行会话带有与聊天相同的 CRM 扩展，因此模型能通过 `crm_search` / `crm_get` 读取真实 CRM 数据（写入类工具仍只生成待人工确认的申请）。
- **propose**：第二个会话（无扩展、仅提议器系统提示）让模型只返回 JSON 补丁 `{ instructions, tools?, rationale }`。
- **verify**：检查回答是否包含 `task.expected`（字面包含，见限制）。
- `ready()` 为假或缺少 `model` 时抛出 `MODEL_NOT_CONFIGURED`。
- 工具收窄：若 `spec.tools` 非空，用 `configure({ modelTools })` 只开放这些工具；为空则保留默认工具集。

持久化：

- `runSuite` / `promote` / `rollback` 之后调用 `harness.commit(tx => tx.doc(Harness2State))` 写回，与对话在同一事务、同一个 SQLite 中完成。
- 不再有 `state.bin`、`protect` 加密通道或 `skill-protect` IPC；这些随 Skill 自演进一并移除。

## 4. 与官方 Harness² 的对应与差异

- 对应：同样是"配置级递归改进 + 评测反馈 + 版本沉淀"，让 Agent 依据失败信号迭代自身运行配置。
- 差异：
  - 不接入官方仓库/基准执行栈（官方要求 Linux、Python 3.12，Windows 隔离执行未验证）。
  - 不运行可执行代码、不做进程/文件系统/网络隔离；改进对象仅提示与工具白名单。
  - 评测器目前是**字面包含**判定，不验证语义与事实；真实语义评估是后续工作（与 `docs/harness2-assessment.md` 的结论一致）。

## 5. IPC 与界面

主进程 `client/electron/main.cjs` 的 `crm:agent` 暴露五个动作（沿用现有校验风格）：

| 动作 | 载荷 | 说明 |
| --- | --- | --- |
| `harness2-state` | 无 | 读取快照（经验库、候选、审计等） |
| `harness2-history` | `{limit:100}` | 读取最近审计 |
| `harness2-run` | 1..10 个任务，每项校验 `id≤100`、`input≤4000`、`expected` 非空 ≤300、`domain` 可选 string | 运行一轮 suite |
| `harness2-promote` | `cand_[0-9a-f-]{36}` | 发布候选经验 |
| `harness2-rollback` | `exp_[0-9a-f-]{36}` | 回滚已发布经验 |

`harness2-run` 的请求超时放宽到 600000ms（多轮模型调用）。

界面 `client/src/App.tsx` 在控制栏新增「Harness² 递归自改进」卡片：可编辑任务 JSON（`id/domain/input/expected`）、运行一轮、查看经验库/候选计数、按候选的评测结果发布、回滚已发布经验。

## 6. 测试

- `client/agent/harness2.test.mjs`：13 个确定性 mock 测试（L1 收敛、maxRounds、null 提案早停、L2 跨任务转移、人工门与回滚、非法提案拒绝、序列化往返、审计、空输入拒绝）。
- `client/agent/harness2-runtime.test.mjs`：4 个测试，使用 Pi `MemoryStorage` / SQLite 与 `faux` 模型：parseProposal、在真实 Pi 会话上跑 suite 求解、promote 后关闭并以同一 `session.sqlite` 重开仍能看到经验且可 rollback、未配置模型时拒绝运行。
- 全量 `npm test`（vitest 10 项 + electron 56 项 + agent 36 项）与 `npm run build`（tsc --noEmit && vite build）均通过。

## 7. 已知限制与后续

- 未接入官方 Harness² 仓库，也未在真实 Linux 隔离基准上验收。
- 评测只做字面包含，可能误判；真实语义/事实校验需另行设计。
- 改进对象仅配置，不改动程序代码。
- 运行已接入 Pi agent core，但**未接入官方 Harness² 仓库/基准执行栈**（官方要求 Linux、Python 3.12）。
- 状态与对话保存在 Pi 的 `session.sqlite`（当前为明文），不再单独加密 `state.bin`；如需更强保护，可后续对文档字段加密。

## 8. 备注：Skill 自演进已被取代并删除

自建 Skill 自演进（`skill-evolution.mjs`、`skill-regression.mjs`、`skill-encryption-check.cjs` 及其测试与界面入口）已整体删除，能力由本 Harness² 原生实现取代；后续自改进以本文件为准。
