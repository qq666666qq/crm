# CRM 主要数据流、模块和耦合点

本文依据当前代码描述主要路径，不覆盖所有异常分支。图中的线表示调用或数据传递，不表示所有组件在同一进程运行。

## 业务和 Agent 数据流

```mermaid
flowchart LR
  user[用户] --> ui[React 页面]
  ui -->|调用桌面桥接| preload[preload.cjs]
  preload -->|进程间消息| main[Electron 主进程]
  main --> transport[请求管理]
  transport -->|HTTP 和当前账号身份| api[FastAPI 路由与权限校验]
  api --> domain[客户、成员与销售业务]
  domain -->|业务记录、审计与事件在同一事务提交| db[(PostgreSQL)]
  db -->|读取事件并重新检查权限| sync[同步模块]
  sync -->|SSE 事件流| stream[桌面同步连接]
  stream -->|当前会话的事件| main
  main -->|同步通知| ui

  main -->|进程间消息| worker[Agent 工作进程]
  worker --> runtime[Pi 运行时]
  runtime --> evolution[回答重跑与比较]
  runtime --> model[配置的模型服务]
  runtime --> memory[(会话与记忆存储)]
  worker -->|受限读取请求| main
  worker -->|提交写入申请| main
  main -->|保存申请| approvals[本地审批记录]
  approvals -->|用户确认后由主进程执行| main
```

- 一般业务请求从 `src/api.ts` 经 `preload.cjs` 到主进程，再由主进程请求服务端。服务端的 `service.write` 负责幂等处理和提交；成功的业务变更通过 `outbox.emit` 加入同步事件。
- 同步模块读取事件时重新检查当前账号的访问权限。SSE 是服务端向客户端持续发送事件的连接；客户端收到通知后合并或重新读取数据。
- Agent 对 CRM 的读取经主进程限制路径。受支持的写操作先创建审批，用户确认后才由主进程请求服务端。模型和 Agent 不直接写 CRM 数据库。
- 默认会话使用本机加密存储；临时会话不持久保存。模拟同步和演示检索不是第三方真实接入。

## 主要模块关系

```mermaid
flowchart TB
  subgraph frontend[React 页面]
    app[App 与工作区]
    agent[AgentWorkspace]
    settings[SettingsPanel]
    approval[审批模块]
    traces[执行记录模块]
    mock[模拟同步模块]
    runner[模拟同步重试模块]
    app --> agent
    app --> settings
    agent --> approval
    agent --> traces
    agent --> mock
    mock --> runner
    approval -->|每条记录的审批数量| traces
  end
  subgraph desktop[Electron 主进程]
    bridge[preload 受控桥接]
    host[会话、请求、Agent 调度]
    actions[Agent 请求校验与分发]
    stream[同步连接与重连]
    transport[HTTP 请求管理]
    local[审批及模块本地存储]
    bridge --> host --> local
    host --> actions
    host --> stream
    host --> transport
    stream --> transport
  end
  subgraph agentprocess[Agent 工作进程]
    worker[消息分发]
    pi[Pi 运行时]
    memory[记忆、检索和任务]
    telemetry[轨迹记录]
    evolution[回答重跑与比较]
    worker --> pi
    pi --> memory
    pi --> telemetry
    pi --> evolution
  end
  subgraph server[FastAPI 服务端]
    routes[路由]
    identity[身份和权限]
    domain[客户及销售业务]
    journal[业务变更记录]
    sync[事件与同步]
    db[(PostgreSQL)]
    routes --> identity
    routes --> domain
    domain --> db
    domain --> journal --> sync --> db
  end
  frontend --> bridge
  actions -->|已校验的进程间消息| worker
  transport -->|HTTP| routes
  sync -->|SSE| stream
```

## 这次重构解决的耦合

原来的 `App.tsx` 同时放置业务入口、Agent 整页、系统设置、审批、执行记录和模拟同步。Agent 组件还同时持有审批列表、模拟任务和对话状态。修改模拟同步时，需要在同一个组件中检查审批和对话的状态及初始化过程。

这次将 Agent 页面和系统设置移出应用入口。Agent 请求的参数校验与分发也从 Electron 主进程移入独立模块；主进程仍负责验证发送者、登录身份和进程生命周期。Agent 审批模块负责列表、确认、刷新和展示；执行记录模块只接收每条记录的关联审批数量；模拟同步模块负责自己的状态和重试。模拟同步重试模块按目标保留未确定结果的操作标识，成功后再清除。审批控制器只发布当前页面和最新刷新请求的结果，防止较旧请求覆盖较新结果，或页面关闭后更新新会话。

Agent 页面仍把忙碌状态和错误提示传给这些模块，以保持页面原有的操作协调方式。模型、审批执行、授权和服务端事务的实现没有因此迁移到前端。


继续重构时，`crm-transport.cjs` 负责 HTTP 地址校验、请求取消和重试标识；账号状态和权限失效后的清理仍由主进程协调。同步连接、游标、断线重连和停止逻辑集中到 `sync-stream.cjs`。每条连接持有启动时的身份，旧连接停止后不会再发送事件或撤销新会话；分块接收时会正确处理跨块的 CRLF 和 UTF-8 字符。

`evolution-runner.mjs` 负责一次回答的安全重跑与比较；`runtime.mjs` 继续负责运行时组装、任务注册和会话存储。恢复任务在执行前仍等待运行时绑定，来源权限仍在原有阶段复核。

`change_journal.py` 统一成功操作的审计与同步事件写入。它使用调用方传入的数据库会话，不自行提交。客户和成员审计仍不记录字段新旧值，销售审计仍按原规则记录变更值；同步事件只记录字段的新值，向客户端下发时还会筛选允许的字段。

## 后续可继续处理的耦合

- `electron/main.cjs` 仍同时负责登录会话、Agent 进程和审批。它们共享账号生命周期与清理顺序，后续拆分应继续验证切换账号和进程退出。
- `agent/runtime.mjs` 仍负责会话初始化、对话、记忆和轨迹组装；继续拆分时必须保留数据库单进程所有权和恢复顺序。
- `app/service.py` 和 `app/sales_service.py` 仍共享部分权限查询与业务关联校验；应按实际业务规则拆分，避免只增加转发层。

上述位置仍可继续改进，不能只凭文件数量判断是否已经消除耦合。
