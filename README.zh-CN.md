[English](README.md)

# dsh-vectr-client

> **基于 Vectr 开发 (Based on Vectr)**：本项目深度集成由 Swapnanil Saha 开发的 [Vectr](https://github.com/swapnanil/vectr)（[官方网站与技术文档](https://swapnanilsaha.com/tools/vectr)）。

`dsh-vectr-client` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的工作区感知型 Vectr MCP 绑定**套件（Bundle）**。在每次 `agent/created` 事件（以及启动时已处于激活状态的 Agent）触发时，动态解析 Agent 会话的工作目录（`cwd`），从 `~/.vectr/instances.json` 中查找对应的 Vectr 守护进程端口，建立基于 [Streamable HTTP](https://modelcontextprotocol.io/) 的 MCP 客户端连接（`http://localhost:<port>/mcp`），并将 Vectr 工具集（`mcp__vectr__*`）精确注入到该 Agent 专属的作用域中。当 `agent/disposed` 触发时自动关闭连接并卸载工具，确保跨工作区完全隔离。

每个工作区拥有独立的 Vectr 守护进程与端口，绑定过程完全由工作区目录动态推导，无需全局静态配置。在 Harness Profile 中加载一次即可自动覆盖所有 Agent。

---

## Vectr 核心能力 (Core Capabilities)

Vectr 赋予 DeepSeek Harness Agent 两项核心杀手级能力：

### 1. 语义检索 (Semantic Search)
- **概念驱动检索**：告别在数百个文件中使用 `grep` 盲猜符号名称或反复穷举搜索。Agent 只需用自然语言描述目标逻辑、设计模式或代码概念，即可秒级命中排序精准的代码切片（Code Chunks）。
- **精准调用图与符号解析**：内置确定性符号定位（`vectr_locate`）与双向调用链分析（`vectr_trace`），快速理清“谁调用了该函数”与“该函数调用了谁”。

### 2. 可靠工作记忆 (Reliable Working Memory)
- **<50ms 极速按需召回**：随时存储开发过程中的关键决策、重要模式、踩坑经验与类型定义，毫秒级召回（`vectr_recall`），杜绝重复扫描磁盘文件带来的 Token 浪费与交互轮次消耗。
- **强抗上下文压缩衰减 (Compaction Resilience)**：当会话上下文过长触发 Harness 的上下文压缩与总结时，存储于 Vectr 中的工作记忆永不丢失，精准保留关键代码签名与约束。
- **跨会话持久化恢复 (Cross-Session Recovery)**：新会话冷启动时从第 1 轮即可继承先前探索沉淀的高价值结论，无需重新探查代码库。
- **多 Agent 共享总线**：在编排器与子任务 Agent 协同工作流中，工作记忆充当共享持久总线，子 Agent 完成任务前写入记忆即可实现零损耗交付。

---

## 系统架构与设计原理 (Architecture)

系统遵循**同包双面（Same-Bundle Dual-Face, C1）**与**分层整洁架构（Clean Architecture）**设计：

```
┌─────────────────────────────────────────────────────────────┐
│                 Layer 4: Presentation / Web                  │
│   Settings → Vectr Panel  │  SessionHeaderAction Capsule    │
│   CodebaseModal / Drawer  │  ConversationInputRightAction   │
├─────────────────────────────────────────────────────────────┤
│                 Layer 3: Bridge & Host Routes               │
│   GET /api/vectr/workspaces  │  POST /api/vectr/codebases   │
│   PATCH /api/vectr/codebases │  GET  /api/vectr/session-status
├─────────────────────────────────────────────────────────────┤
│                 Layer 2: Infrastructure / OS                │
│   Instances Resolver  │  CLI Runner  │  SSH / sshpass Tunnel │
├─────────────────────────────────────────────────────────────┤
│                 Layer 1: Domain Core (Pure Rules)           │
│   hasActiveSession  │  validateSlug  │  resolveUnifiedStatus│
└─────────────────────────────────────────────────────────────┘
```

1. **Node 服务端数据面**：
   - 监听 Cordis 生命周期事件，挂载 `/api/vectr/*` 管理接口与 Agent 专属 MCP 客户端通道。
   - 守护进程探活采用 TCP 连接预检与 HTTP `/v1/status` 超时熔断机制，避免守护进程僵死拖垮主服务。
2. **Web 浏览器表现面**：
   - 统一入口打包至 `lib/client.js`，通过 Cordis Slot 服务注入至宿主：
     - `settings.section`：在设置中心挂载完整的 工作区与多 Codebase 管理大盘。
     - `conversation.session.header.utilities`：会话顶部胶囊（`SessionHeaderAction`），动态展示当前会话工作区状态与端口。
     - `conversation.input.right`：对话输入栏右侧快捷入口（`ConversationInputRightAction`）。
     - `shell.overlay`：全局模态弹窗根节点（`VectrDialogRoot`）。
3. **会话按钮防重与互斥真理源（Session Button Deduplication）**：
   - 由领域层核心 `src/domain/rules.ts` 的 `hasActiveSession(sessionId)` 作为唯一判定源，严密防御空串、空白符、`'null'`/`'undefined'` 字符串字面量以及非有限数值（如 `Infinity`、`NaN`）。
   - **已有激活会话**（`sessionId` 存在且有效）：顶部会话栏保留 `SessionHeaderAction` 胶囊，动态解析当前会话工作区；若 `session.cwd` 未就绪则严禁发起网络请求且不回退 `.` 目录。右侧输入栏 `ConversationInputRightAction` 主动让位返回 `null`。
   - **新建/空白会话**（`sessionId` 不存在、空串或 undefined）：输入框保留纯静态无 Hook 的快捷入口，顶部栏直接返回 `null` 且**严格不发起任何网络请求**。

---

## 安装指南 (Installation)

在包含本项目的目录中执行：

```sh
dsh plugin --profile web add ./dsh-vectr-client
```

该命令会将插件链接至指定的 Profile，并在其 `package.json` 的 `dsh.profile.bundles` 中自动登记，下次启动时自动应用 `cordis.patch.yml`。若需卸载，运行 `dsh plugin --profile web remove dsh-vectr-client`。

若通过 Git 仓库安装（仓库已提交构建产物 `lib/`，安装无需额外编译）：

```sh
dsh plugin --profile web add github:WinterSold1er/dsh-vectr-client
```

### 宿主启用与热重载说明
1. 本插件开箱即用，通过 `cordis.patch.yml` 声明服务依赖，通过 `dsh.client` 声明 Web 端入口。
2. 重启 Harness 宿主服务后，服务路由及设置中心 **Settings → Vectr** 面板即生效。
3. 验证方式：调用 `GET /api/vectr/workspaces` 返回 200，且在关联了 Vectr 守护进程的工作区中创建 Agent 时，工具列表自动出现 `mcp__vectr__*`。

---

## 配置说明 (Configuration)

支持在 Profile 的 `cordis.patch.yml` 中覆盖以下参数：

| 配置项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `instancesPath` | 否 | `~/.vectr/instances.json` | Vectr 守护进程注册表文件路径（绝对路径直接使用，相对路径相对于进程 cwd） |
| `serverName` | 否 | `vectr` | 注入 Agent 的 MCP 工具命名前缀（格式为 `mcp__<serverName>__*`） |
| `toolCallTimeoutMs` | 否 | `60000` | 单次 Vectr MCP 工具调用超时时间（毫秒） |
| `reconnect.enabled` | 否 | `false` | 连接断开后是否自动重连 |
| `reconnect.initialDelayMs` | 否 | `500` | 初始重试延迟（毫秒），每次连续失败后指数递增 |
| `reconnect.maxDelayMs` | 否 | `30000` | 重试回退最大上限（毫秒） |
| `reconnect.maxAttempts` | 否 | `10` | 放弃前的连续重试次数上限 |
| `codebasesPath` | 否 | `~/.dsh/vectr-codebases.json` | 多 Codebase 拓扑元数据文件路径 |
| `secretsPath` | 否 | `~/.dsh/vectr-secrets.json` | 文件凭证保险箱路径（权限 `0600`，宿主存在凭证服务时优先走系统安全通道） |
| `daemonHttpTimeoutMs` | 否 | `5000` | HTTP `/v1/status` 探活超时预算（毫秒） |
| `daemonTcpTimeoutMs` | 否 | `300` | TCP 端口存活预检超时（毫秒） |

---

## 工作区解析规则 (Workspace Resolution)

`~/.vectr/instances.json` 记录了 `sha256(工作区绝对路径)[:12]` 到守护进程信息的映射。当 Agent 创建时，插件按以下优先级解析工作区：

1. **SHA-256 精确匹配**：计算会话工作区路径哈希前 12 位并查找。
2. **子目录前缀匹配**：若会话工作区位于已登记的某工作区子目录下，自动继承父级工作区的 Vectr 守护进程。
3. **尾部斜杠容错匹配**：自动剔除尾部斜杠后比对路径字符串。

若未找到匹配项，将在日志记录 `vectr-client: no vectr daemon for <cwd>, skipping`，Agent 不挂载 Vectr 工具，绝不静默绑定至错误的 `process.cwd()`。

---

## 多 Codebase 管理 (Multi-Codebase Management)

支持跨本地与远程多代码库管理：

### 1. 本地代码库
- 执行 `vectr start --path <path> --json` 启动守护进程并解析元数据。
- 采用参数数组隔离调用，杜绝 Shell 注入隐患。

### 2. 远程代码库与 SSH 隧道穿透
- 支持基于 SSH 密钥与密码认证的远程主机：
  - **密钥认证**：复用系统配置好的 SSH Key。
  - **密码认证**：宿主需安装 `sshpass`。密码由凭证库读取并写入临时权限为 `0600` 的安全文件，命令退出立即清理。**明文密码绝对不进入进程命令行参数（避免通过 `ps` 或 `/proc` 泄露），也绝不落盘至公共元数据文件**。
- 隧道建立采用 SSH ControlMaster（`-M -S <ctl>`），通过 `ssh -O check` 精准获取主控进程 PID，清理时通过 `ssh -O exit` 优雅释放，辅以 PID 信号强杀保底。

---

## 开发与构建 (Development)

本项目采用 TypeScript + tsdown + Vitest 开发测试套件：

```sh
pnpm install       # 安装依赖并链接本地 Harness monorepo 核心包
pnpm run typecheck # 严格类型检查（包括 Host 与 Client 两个 tsconfig）
pnpm test          # 运行 300+ 单元与集成测试用例（覆盖 TDD、安全审计与边界测试）
pnpm build         # 构建出 lib/index.js (Host) 与 lib/client.js (Web 端 bundle)
```

---

## 已知限制与防御性设计 (Known Limitations)

1. **首轮提示词轻微时序竞争**：连接初始化在 `agent/created` 中异步执行且不阻塞 Agent 启动，极端情况下若守护进程初次握手未完成，首轮对话可能未挂载工具，随后轮次会自动就绪。
2. **端口突变需新会话拾取**：守护进程如果异常退出并变更端口重启，需待新建会话或重新加载注册表后重新绑定。
3. **Web 端热重载与全量生效**：Web 端组件在开发模式下通过 Client 插件热接收器即时更新；核心服务端路由变更需重启宿主服务。
