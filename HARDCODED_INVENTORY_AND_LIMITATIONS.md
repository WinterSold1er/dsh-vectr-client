# 硬编码清单与限制说明 (Hardcoded Inventory & Limitations)

本文档依照架构设计与规范要求，对 `dsh-vectr-client` 插件中的所有硬编码常量、外部假设及已知限制进行逐一登记，并明确其存在理由与替换路径。

---

## 一、 硬编码值清单 (Hardcoded Inventory)

| 常量/字段名称 | 当前取值 / 默认值 | 所在文件及位置 | 存在理由 | 外部化方式与替换路径 |
| :--- | :--- | :--- | :--- | :--- |
| `DEFAULT_INSTANCES_FILE` | `~/.vectr/instances.json` | `src/registry.ts`, `src/index.ts` | Vectr 官方守护进程默认注册表路径 | 可在 Cordis 插件配置 `Config.instancesPath` 中配置为自定义绝对路径 |
| `DEFAULT_CODEBASES_FILE` | `~/.dsh/vectr-codebases.json` | `src/index.ts` | 插件管理的多代码库元数据默认持久化文件 | 可通过 `Config.codebasesPath` 覆盖为任意指定文件 |
| `DEFAULT_SECRETS_FILE` | `~/.dsh/vectr-secrets.json` | `src/index.ts` | 独立运行环境下无宿主凭据服务时的本地安全凭据库文件 (0600) | 可通过 `Config.secretsPath` 外部化覆盖 |
| `DEFAULT_CLI_NAME` | `'vectr'` | `src/infra/cli-runner.ts` | Vectr 官方命令行工具标准名称 | 按优先级读取：1. `Config.cliPath`，2. 环境变量 `VECTR_CLI_PATH`，3. `VECTR_PATH`，4. 系统 PATH |
| `DEFAULT_CLI_TIMEOUT_MS` | `30000` (30s) | `src/infra/cli-runner.ts`, `src/index.ts` | `vectr init` 工作区初始化与配置生成的标准执行超时 | 可通过 `Config.cliTimeoutMs` 配置，或通过环境变量 `VECTR_CLI_TIMEOUT_MS` 注入 |
| `SIGKILL_ESCALATION_DELAY_MS` | `1500` (1.5s) | `src/infra/cli-runner.ts` | CLI 进程超时触发 `SIGTERM` 后等待其自行清理的安全缓冲时间，若未退出则升级为 `SIGKILL` 杜绝僵尸进程 | 可抽象为 `Config.cliKillEscalationMs` |
| `DEFAULT_RECALL_TIMEOUT_MS` | `10000` (10s) | `src/index.ts`, `src/bridge/session-service.ts` | 工作记忆笔记检索 (`POST /v1/recall`) 及断点恢复 (`GET /v1/resume`) 请求超时 | 可通过 `Config.recallTimeoutMs` 配置 |
| `DEFAULT_DAEMON_HTTP_TIMEOUT_MS`| `5000` (5s) | `src/index.ts`, `src/probe.ts` | 守护进程 HTTP `/v1/status` 探针超时，需严格低于进程假死挂起窗口 | 可通过 `Config.daemonHttpTimeoutMs` 配置 |
| `DEFAULT_DAEMON_TCP_TIMEOUT_MS` | `300` (300ms) | `src/index.ts`, `src/probe.ts` | 本地 TCP 端口监听探测超时，用于快速判断进程是否已拉起 | 可通过 `Config.daemonTcpTimeoutMs` 配置 |
| `DEFAULT_TOOL_CALL_TIMEOUT_MS` | `60000` (60s) | `src/index.ts` | 单次 MCP 工具调用（如代码语义检索、符号定位）的全局超时门禁 | 可通过 `Config.toolCallTimeoutMs` 配置 |
| `STARTUP_HEAL_COOLDOWN_MS` | `30000` (30s) | `src/index.ts` | 宿主重启时对失效远程隧道的自愈探测试探冷却周期，防止击穿不可达主机 | 可抽象为 `Config.startupHealCooldownMs` |
| `DEFAULT_TUNNEL_PROBE_MS` | `800` (800ms) | `src/codebases.ts` | 远程代码库本地映射端口复用前的 TCP 快速探活超时 | 可抽象为 `Config.tunnelProbeTimeoutMs` |
| `TUNNEL_PORT_MIN` ~ `TUNNEL_PORT_MAX` | `8760` ~ `8799` (40个端口) | `src/codebases.ts` | 远程代码库 SSH 隧道本地映射的连续端口保留区间，避免端口冲突 | 可在 `Config` 中增加 `tunnelPortRange: { min: number, max: number }` |
| `DEFAULT_HOST` | `'127.0.0.1'` | `src/registry.ts`, `src/bridge/session-service.ts` | 本地环回地址，防止守护进程未授权暴露在外部网络接口 | 守护进程启动参数可自定义 `--host`，注册表中记录的 `host` 会优先于此值 |
| `DEFAULT_SERVER_NAME` | `'vectr'` | `src/index.ts` | 工具在 DSH 暴露的 MCP 前缀 (`mcp__vectr__*`) | 可通过 `Config.serverName` 配置为自定义前缀 |
| `SLUG_PATTERN` | `/^[A-Za-z0-9_-]{1,32}$/` | `src/domain/rules.ts` | 代码库唯一标识符校验正则，确保文件系统、URL 路由与环境命名安全 | 核心安全不变式（Invariant），不建议随意放宽 |
| `WORKSPACE_KEY_LENGTH` | `12` | `src/registry.ts` | Vectr 原生 instances.json 中工作区路径 SHA-256 截断散列长度 | 严格对齐 Vectr 协议规范 |
| 远程端口 (Remote Port) | 无默认值（默认留空） | `src/client/CodebaseModal.tsx` | 前端组件移除写死的 8765 端口，支持留空以触发后端自动探测与自愈解析 | 用户可在前端表单输入自定义远程端口，或由后端自动查询远程 `instances.json` 与 `vectr start` 输出 |

---

## 二、 外部假设与显式校验 (External Assumptions & Explicit Checks)

1. **工作区有效性与绝对路径假设**：
   - 假设：会话对应的工作区必须是本地宿主或远程目标机上的合法绝对路径。
   - 校验：在 `src/domain/rules.ts` 中的 `validateWorkspace` 中显式校验：
     - 禁止空字符串或纯空格；
     - 禁止 `\0` 空字符（防路径注入攻击）；
     - 禁止未绑定哨兵 `__unassigned__`；
     - 严格要求必须为绝对路径（支持 POSIX `/` 与 Windows `C:\` 驱动器格式），相对路径一律拦截并返回清晰错误。

2. **工作区重索引 (Re-index) 模式约束**：
   - 假设：仅完整索引模式 (`full`) 且处于就绪状态的守护进程支持触发代码库重索引。
   - 校验：在 `src/domain/rules.ts` 的 `canReindex` 中显式校验：
     - 守护进程不在线时拒绝；
     - `memory_only` 纯工作记忆模式拒绝触发代码索引；
     - `search_only` 纯搜索模式拒绝触发持久索引变更；
     - 已有重索引任务正在进行时 (`reindex_in_progress: true`) 拒绝；
     - 初始索引未完成时 (`fully_ready: false`) 拒绝。

3. **SSH 密码认证与凭据隔离假设**：
   - 假设：当指定密码认证时，密码不得持久化到明文元数据文件，且必须成功加载。
   - 校验：若配置 `auth: 'password'` 但未提供密码或密钥库无法解析密码，后端立即拦截报错，禁止静默降级为免密 SSH 导致难以排查的网络探测失败。密码写入受保护的凭据库（0600 权限），元数据中仅保存引用键名。

4. **系统提示词注入与代码库判定（解耦网络探针）**：
   - 假设：只要当前工作区存在有效实例或已登记代码库，系统提示词（`vectr:mcp-guidance` 及 `tool:grep` 遮蔽）应立即、无条件生效，不再等待或依赖守护进程 HTTP/TCP 网络探针。
   - 校验：
     - 在 `src/domain/rules.ts` 的 `hasCodebase` 纯领域规则中显式校验：`workspace` 必须为有效非空字符串；当且仅当 `entry` 存在或 `codebases` 中存在 `item.workspace === workspace` 时返回 `true`。
     - 若 `hasCodebase` 返回 `false`，则不注入系统提示词；
     - 若返回 `true`，立即同步注入系统提示词并绑定至 `promptFibers`；后台网络探针与连接流水线完全独立异步运行，超时或异常仅记录警告日志，handles 保持为空，绝不波及系统提示词。

---

## 三、 已知限制 (Known Limitations)

1. **远端操作系统兼容性**：
   - 当前远程代码库自动安装与拉起脚本假设远端为 POSIX 兼容环境（Linux / macOS），非交互式 SSH 会话使用 `sh` / `bash`。
   - 远端 Windows 宿主暂未支持自动 provision（需在远端手动启动 `vectr start` 并使用本地代码库挂载）。

2. **远端工作区路径格式**：
   - 远程执行通过安全命令列表注入 `export PATH=$HOME/.local/bin:$PATH && ...`。当前远程工作区路径假设不包含未转义的空格。若远端路径包含空格，需通过单引号转义。

3. **并发创建同名 Slug 保护**：
   - 相同 slug 的代码库创建在进程内受单飞锁（Single-flight lock）保护；后发请求会等待先发请求完成并校验命名冲突，但跨多实例节点部署时需依赖集中式元数据锁。

4. **SSH 密码认证系统依赖**：
   - 本地宿主如需使用密码连接远程代码库，宿主环境需安装 `sshpass`。如未安装，系统会给出清晰提示要求安装 `sshpass` 或配置 SSH 密钥互信。
