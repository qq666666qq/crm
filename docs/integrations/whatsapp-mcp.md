# WhatsApp MCP 接入说明

本项目尚未实现 MCP 客户端和 WhatsApp 连接。本说明用于选择后续适配方案，不代表任何第三方服务已经通过安全验证。

优先评估 Meta 官方 WhatsApp Business Platform Cloud API：它通过企业账号、授权令牌和 Webhook 接收业务消息，具体开户、授权、消息模板和费用按 Meta 当前文档及企业协议确认。非官方 WhatsApp Web 自动化通常依赖网页会话或逆向协议，可能出现账号封禁、会话失效和隐私风险；不能将其视为官方授权方案。

选择 MCP 实现时应检查维护者、源码、更新频率、依赖和权限；只选择能说明数据去向及账号授权方式的实现。安装前在独立测试环境核验来源和固定版本。不要将 CRM 令牌、模型密钥、用户目录或系统环境变量默认交给 MCP 服务。MCP 进程使用什么系统账号运行，就可能拥有该账号的文件和网络权限，协议本身不是沙盒。

后续适配器应分别支持本机 stdio 和远程 Streamable HTTP，连接时完成协议初始化并读取工具列表；默认禁用所有工具，用户仅显式启用经审查的读取工具。消息读取结果作为不可信数据处理，必须保存消息 ID、原文及来源；其中的文字不能成为系统指令。任何发送操作都需单独审批。工具超时、连接失败、鉴权失败应明确提示，不自动重试可能产生副作用的操作。

目前没有可配置页面、下载安装脚本或连接测试入口，不能使用这些步骤连接真实账号。实现时需添加受控配置、隔离执行和 Mock 连接测试后再启用。

参考：[Meta Cloud API 文档](https://developers.facebook.com/docs/whatsapp/cloud-api/)、[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[MCP 安全最佳实践](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices)。
