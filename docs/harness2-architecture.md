# Harness² 架构：模块依赖图与数据流程图

> 新能力以 **Harness²（Recurse Agent Harnessing）** 为准；自建 Skill 自演进代码已删除。
> 本文给出两张图：**模块依赖图**（文件/模块之间真实的 import / require 关系）与**数据流程图 DFD**（外部实体、处理过程、数据存储与数据流）。
> 配套图片：`docs/harness2-module-dependency.png`、`docs/harness2-data-flow.png`；实现细节见 `docs/harness2-implementation.md`。

## 1. 模块依赖图

> 箭头方向为 **A → B：A 依赖 / import B**。实线为 import/require，虚线为运行时桥接（IPC、窗口全局、safeStorage 等）。

![Harness² 模块依赖图](harness2-module-dependency.png)

```mermaid
flowchart LR
  App["client/src/App.tsx"] -.->|"window.crm.agent"| Pre["client/electron/preload.cjs"]
  Pre -->|"ipcRenderer.invoke"| Main["client/electron/main.cjs"]
  Main -->|"utilityProcess.fork"| Worker["client/agent/worker.mjs"]
  Worker -->|"import"| RT["client/agent/runtime.mjs"]
  RT -->|"import"| H2RT["client/agent/harness2-runtime.mjs"]
  H2RT -->|"import"| H2["client/agent/harness2.mjs"]
  Main -->|"require"| Acrm["client/electron/agent-crm.cjs"]
  Main -->|"require"| Aappr["client/electron/agent-approvals.cjs"]
  Worker -->|"import"| Trace["client/agent/trace.mjs"]
  Worker -->|"import"| Demo["client/agent/demo.mjs"]
  Demo -->|"import"| Evidence["client/agent/evidence.mjs"]
  RT -->|"import"| Presets["client/agent/presets.mjs"]
  RT -->|"import"| CrmTools["client/agent/crm-tools.mjs"]
  RT -.->|"import"| Pi["Pi 包：pi-durable · pi-ai · chord"]
  H2RT -.->|"import"| Pi
  Presets -.->|"import"| Pi
  CrmTools -.->|"import"| Pi
  H2 -.->|"import"| Node["Node 内建：crypto / fs / path"]
  Trace -.->|"import"| Node
  Main -.->|"require"| Electron["electron"]
  Aappr -.->|"safeStorage"| Electron
```

**分层要点**

- **渲染层**只发 IPC 动作（`harness2-state/history/run/promote/rollback`），不接触模型与数据库。
- **主进程**负责发送者/会话/租户校验与动作白名单，`harness2-run` 任务数 1..10、字段长度受限，超时放宽到 600s。
- **Worker** 是 utilityProcess 子进程，把消息转发给 `runtime.harness2*`。
- **运行时装配** 先 `Harness.open(session.sqlite)` 打开 Pi agent core 与会话，再把同一个 harness 注入 `openHarness2`。
- **适配器** `harness2-runtime.mjs`：`propose` 用第二个 Pi 会话让模型返回 JSON 补丁，`execute` 用候选配置在 Pi 会话里执行任务（可调用真实 CRM 工具），`verify` 做 `answer.includes(expected)`；状态以 `crm.harness2` 文档写回同一 SQLite。
- **纯引擎** `harness2.mjs` 无模型/IO 依赖，只做配置校验、组合、L1 递归检索与 L2 经验库；**harness 是配置（instructions + 工具白名单），永不 eval 代码**。

## 2. 数据流程图（DFD）

> 矩形=外部实体，圆角矩形=处理过程，开口矩形=数据存储，箭头=数据流。

![Harness² 数据流程图](harness2-data-flow.png)

```mermaid
flowchart LR
  U["用户"] -->|"任务 JSON / 发布·回滚"| P1["P1 渲染层 App"]
  P1 -->|"harness2-* IPC"| P2["P2 主进程"]
  P2 -->|"校验后的 tasks"| P3["P3 Worker + runtime"]
  P3 -->|"runSuite(tasks)"| P4["P4 Harness² 引擎"]
  P4 -->|"execute(harness, input)"| P5["P5 Pi 执行会话"]
  P5 -->|"answer"| P4
  P4 -->|"propose(...)"| P6["P6 Pi 提议会话"]
  P6 -->|"JSON 配置补丁"| P4
  P4 -->|"solved / total / candidates"| P3
  P3 -->|"persist：commit"| D2[("D2 crm.harness2 状态")]
  D2 -.->|"启动恢复"| P3
  P5 <-->|"对话 entries"| D1[("D1 对话记录")]
  P6 <-->|"entries"| D1
  P5 <-->|"prompt / response"| Model["模型服务"]
  P6 <-->|"prompt / response"| Model
  P2 -->|"白名单只读查询"| CRM["CRM 服务端"]
  CRM -->|"CRM 记录"| P2
  P2 -->|"crm_propose_* 写申请"| D3[("D3 审批存储")]
  P5 -.->|"crm_search / crm_get / crm_propose_*"| P2
```

**附：一次 runSuite 的时序（补充）**

```mermaid
sequenceDiagram
  autonumber
  participant App as App.tsx 渲染层
  participant Main as main.cjs 主进程
  participant Worker as worker.mjs
  participant RT as runtime + adapter
  participant Eng as Harness2 引擎
  participant Pi as Pi agent core（会话 + 模型 + SQLite）

  App->>Main: crm.agent('harness2-run', tasks)  [IPC invoke]
  Main->>Worker: 校验 trusted/租户 + 任务字段长度 → postMessage {type:'harness2-run',tasks}
  Worker->>RT: runtime.harness2Run(tasks)
  RT->>Eng: engine.runSuite({ tasks })  (autoAdopt=false)
  Eng->>Pi: execute：worker 会话 configure(harness 配置) + reset + submit(task.input)
  Pi->>Eng: 回答文本 answer（可经 CRM 工具读真实数据）
  Eng->>Eng: verify：answer.includes(expected)
  Eng->>Pi: 未通过 → propose：proposer 会话 submit（任务 + 当前 harness + 探测证据）
  Pi->>Eng: JSON 补丁 { instructions?, tools?, rationale }
  Eng->>Eng: normalizePatch → composeHarness → probe（重复 ≤ 4 轮）
  Eng->>Eng: 通过且 digest≠seed → 记 candidate，写 _provisional[domain]
  Eng->>RT: { tasks, solved, total, candidates }
  RT->>Pi: persist：commit → crm.harness2 文档（同一 SQLite 事务）
  RT->>App: 结果回传（经 worker / main）→ 显示 通过数 / 候选数
  App->>Main: crm.agent('harness2-promote', cand_id)  [人工发布]
  Main->>Eng: （经 worker/runtime）promote：仅 candidate 且 evaluation.passed
  Eng->>Pi: persist → 写 experience library
  App->>Main: crm.agent('harness2-rollback', exp_id) → 移出 library，候选标记 rolled_back
```

**关键流程**

1. **运行入口**：`App.runH2` 解析任务 JSON → IPC `harness2-run` → 主进程校验 → Worker → `runtime.harness2Run` → `engine.runSuite`。
2. **L1 单任务递归**：先探测 seed 基线；未通过则 `propose`（模型返回配置补丁）→ `normalizePatch` → `composeHarness` → 再次 `probe`，最多 `maxRounds=4` 轮，通过即停。
3. **L2 运行内迁移**：某域任务被解决且 harness `digest` 改变 → 记 `candidate`，并把该域配置写 `_provisional[domain]`，供同一 suite 后续同域任务复用；**仅本次运行有效**。
4. **持久化**：每次 `runSuite/promote/rollback` 后把 `engine.serialize()` 写入 `crm.harness2` 文档，与对话共用同一个 `session.sqlite` 事务，重启后复用。状态当前为明文，不再单独加密 `state.bin`。