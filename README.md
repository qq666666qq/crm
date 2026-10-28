# B2B CRM 服务端（开发中）

FastAPI + PostgreSQL 模块化服务原型。客户端和 Agent 必须通过 HTTP API 操作；本项目不提供 Agent 直连数据库的接口。

本服务面向本地开发。首次正式部署前仍需完成安全审查、HTTPS 配置和备份恢复演练。

## 启动

1. 安装并启动 Docker Desktop。
2. 将 `.env.example` 复制为 `.env`，设置强随机数据库密码，并同时更新 `DATABASE_URL` 中的密码。URL 中的特殊字符需要百分号编码。
3. 执行 `docker compose up --build -d`。服务启动时执行 Alembic 迁移。
4. 执行 `docker compose exec api python -m app.bootstrap`，交互式创建首个租户和管理员。密码不会显示在命令行参数中。记录输出的租户 UUID。
5. 访问 `http://127.0.0.1:8000/docs` 查看 API 文档；`GET /health` 检查数据库连接。

Compose 只将 API 绑定到本机，数据库不发布宿主机端口。示例密码仅用于提示，不可用于正式环境。首次初始化后不要重复创建初始租户。

## API 调用约定

`POST /api/v1/auth/login` 接收邮箱和密码，返回随机 bearer token。此 token 只在服务端以 SHA-256 摘要保存，有过期时间和撤销状态。之后每次请求提供 `Authorization: Bearer <token>` 和 `X-Tenant-ID: <租户 UUID>`；租户选择并非授权，服务端仍会检查用户、企业和成员状态。`POST /api/v1/auth/logout` 撤销当前 token。

所有公司和联系人写请求必须带 `Idempotency-Key`（1–128 字符）。同一个租户、用户和 key 的原始方法、路径、查询字符串和请求体必须完全一致；重试返回原结果，内容不一致返回 409。请求体按字节比较，所以重试时应原样发送。更新请求包含 `expected_version`；删除时用查询参数 `expected_version`。读取默认不返回软删除记录。

销售员只访问自己负责的公司及其联系人。管理员和经理目前访问本租户全部公司，尚无团队管理范围或共享授权。请求中不可传入 `tenant_id` 或 `user_id`；`owner_id` 可由管理员或经理设置为本租户启用的成员，销售员只能设置为自己。`X-Operation-Source` 和 `X-Agent-Run-ID` 是客户端自报的审计元数据，不能证明请求由 Agent 发起。

管理员使用 `GET /api/v1/members` 列出成员，`POST /api/v1/members` 创建新本地账号并加入本租户，`POST /api/v1/members/attach` 使用已有账号 UUID 加入本租户，`PATCH /api/v1/members/{id}` 调整角色和成员状态。最后一名有效管理员不能被停用或降级。账号密码必须通过安全渠道交付；此本地机制不包含邀请、密码重置或用户同意流程。成员接口中的 `user_id` 仅用于指定要加入的已有账号，不用于认证或指定请求主体。

删除后可通过 `POST /api/v1/companies/{id}/restore` 或 `POST /api/v1/contacts/{id}/restore` 恢复，JSON 中提供删除后的 `expected_version`。恢复联系人要求公司仍有效；若渠道已被其他活跃联系人使用，恢复返回冲突。`GET /api/v1/companies/duplicates?name=...&country=...` 返回有权查看的名称和国家相同的疑似重复项，不自动合并。相同域名属于确定性冲突，同公司活跃联系人使用相同标准化邮箱、电话或 WhatsApp 标识会返回冲突，需人工确认。

官网以主机名去掉 `www.`、转小写后，在租户活跃公司范围内唯一。这是第一版假设，不适合多个独立公司共用网站的情况。公司名不唯一。电话要求国际 E.164 格式。公司有活跃联系人时不能删除；删除联系人后才可以删除公司。

## 测试

在安装依赖的 Python 环境运行 `python -m pytest -q`。数据库测试需要设置 `TEST_DATABASE_URL` 指向**专用测试 PostgreSQL 数据库**，测试会创建并删除随机命名的 schema；例如 PowerShell：

```powershell
$env:TEST_DATABASE_URL='postgresql+psycopg://test:test@localhost:5432/crm_test'
python -m pytest -q
```

未设置时数据库测试会明确显示 skipped。不要把生产数据库用于测试。

## 第二阶段业务接口

线索、商机、跟进任务和沟通记录接口使用 `/api/v1`，完整请求结构见 `/docs`。列表支持 `limit`（1–100）、`offset`、状态或阶段和相关业务对象筛选。所有写操作继续要求 `Idempotency-Key`；线索、商机和跟进任务的更新、删除及状态变更要求 `expected_version`。金额和数量在 JSON 响应中以十进制字符串返回，避免浮点精度损失。

创建线索时必须随请求提交至少一条 `evidence`。`evidence_type=quote` 必须提供 `original_quote`；`evidence_type=manual` 必须使用 `source_type=manual` 并提供 `manual_note`。若提供 `quote_start` 和 `quote_end`，两者使用 Python Unicode 字符下标，起点包含、终点不包含，并且必须精确匹配快照。服务端可以校验快照与引用的一致性，但无法独立证明快照来自真实消息，也不能凭客户端自报的来源判断操作者实际是人还是 Agent。相同租户、来源类型、来源消息 ID 与相同原文或人工备注会被拒绝；同一消息可以保留不同引用。

线索按 `new → working → qualified → converted` 流转，也可从未转化状态标记 `disqualified`，通过 reopen 回到 working。`POST /leads/{id}/convert` 要求当前线索为 qualified、有产品意向或需求备注。调用者可提供 `company_id` 关联现有公司，或提供 `company_new` 创建公司；两者都未提供时使用线索已关联的公司。可选的 `contact_id` 和 `contact_new` 分别用于关联或创建联系人；未提供时沿用线索已关联的联系人。每组选择互斥，已有线索关联与请求不一致时拒绝。关联联系人会作为主要联系人加入新商机。新公司名称与同租户现有公司存在疑似匹配时返回冲突，官网域名及联系人渠道冲突也会阻止创建；系统不自动合并。转化时同公司同名称的活跃商机会被视为需人工确认的重复候选；公司相同但名称不同的商机可以共存。公司、联系人、商机、线索状态和成功审计在同一事务内提交。

商机在 discovery、quoting、negotiating 之间可前进或回退；won 和 lost 通过专门接口关闭，关闭后不能普通编辑或改变阶段。lost 必须提供原因，阶段变化在审计的 `changes` 字段中记录旧值和新值。多个联系人可以同时设为主要联系人，但必须属于商机的公司。

`/follow-up-tasks/due` 默认返回当前用户截止现在已到期的待办，可传带时区的 `from_at` 和 `until` 限定时间范围；`/overdue` 查询截止当前时刻的逾期待办；`/reminders` 查询提醒时间已经到达的待办。时间输入必须包含时区，服务端按 UTC 存储。完成和取消是独立状态操作；活动记录的是已发生的沟通，与跟进任务可选关联。活动表按 handoff 未设置版本字段，其编辑不提供乐观锁。

销售员对新线索和商机仅可访问自己负责、且关联公司也可访问的记录；任务仅访问分配给自己的记录，活动仅访问自己创建且关联对象可访问的记录。管理员和经理范围仍为本租户全部记录。删除已有公司、联系人、线索、商机或任务时，若存在受保护的活跃关联记录，服务端拒绝删除；原始证据随线索保留。

## 备份与恢复

本地可定期执行 `docker compose exec -T db pg_dump -U crm -d crm > crm-backup.sql`，将输出保存到受限访问、独立于数据库卷的位置；生产应设置自动化、保留周期、异地副本和加密。账号与库名若已修改，应使用对应配置。备份包含客户资料，请严格限制访问。

恢复演练应先创建独立空数据库，再用 `psql` 将备份导入该空库，并验证迁移版本、记录数量与业务查询。不要直接覆盖现有业务数据库。当前没有自动备份任务，也尚未执行正式环境恢复演练。

## 已知缺口和上线前工作

- 团队管理范围和共享授权尚未设计；经理的范围明确为本租户全部数据。
- 登录缺少限流、账户锁定和 OIDC/PKCE；正式部署需要可信身份服务、HTTPS、密钥管理和安全审查。
- 成功操作审计和业务写入同一事务；已认证的失败写请求尝试在独立事务记录结果。数据库故障时失败审计可能无法保存，未认证请求没有关联业务审计主体。来源由客户端声明；不记录字段值，日志也不是防篡改存储。
- 数据备份及恢复演练尚未实施。正式部署必须配置备份、恢复演练、日志脱敏、连接和超时监控。
- 迁移降级会删除数据，禁止对正式数据随意执行 downgrade。
- 不应将开发用 API 直接暴露公网；正式部署还需安全加固及审查。
