[English](README.md)

# dsh-vectr-client

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：让每个在某个项目里干活的 Agent 都拿到**这个项目的语义索引和一份活过对话的记忆**。Agent 按“意思”找代码而不是满仓库 grep，把发现写成能在上下文压缩后依然取回的笔记，新会话能从上次的断点继续——按工作区自动发生，不用你配。

> **基于 Vectr 开发 (Based on Vectr)**：本项目建立在由 Swapnanil Saha 开发的 [Vectr](https://github.com/swapnanil/vectr) 之上（[官方网站与技术文档](https://swapnanilsaha.com/tools/vectr)）。索引、记忆存储与守护进程都是 Vectr 的能力；本插件是它在 Harness 里的集成层（绑定、界面、按工作区路由）。

## 你会得到什么

- **按语义找代码** — Agent 描述概念、符号或调用关系（“工作区锁在哪里释放？”）即可命中，不需要靠猜路径或跑 grep 循环。工具以 `mcp__vectr__*` 出现在**该 Agent 自己的作用域**里。
- **扛得住上下文压缩的记忆** — 存成笔记的发现一次调用就能取回：本次会话稍后、上下文被裁剪之后、甚至新开的会话。
- **每个目录自动连对守护进程** — Agent 一启动，插件读取会话 `cwd`，在 `~/.vectr/instances.json` 里找到该目录对应的 Vectr 守护进程并连上。A 工作区的 Agent 永远拿不到 B 工作区的工具，也没有需要维护的全局 MCP 配置。
- **不阻塞、不挂死** — 守护进程缺失、已死或无响应，后果只是“这个 Agent 没有 Vectr 工具”；原因会连 workspace/cwd/port/pid 一起写进日志，Agent 照常干活。
- **在你打字的地方显示状态** — 会话头部胶囊显示该会话目录对应守护进程的状态、模式与端口；输入框旁有打开控制台的触发器。会话还没有目录时两者都会干净地复位。
- **一键启动全部守护进程** — 控制台里的 `一键启动全部 Daemon` 按钮一次请求拉起所有已注册守护进程，并列出逐个工作区的结果。
- **在面板里重建索引** — 直接 re-index 某个工作区；无法重建时（仅记忆模式、已在索引中、未就绪、离线），按钮的 tooltip 会说明原因。
- **一个工作区可以挂多个代码库** — 本地目录，以及通过 SSH 隧道的远程主机（密钥或密码认证）；每个代码库有独立的 MCP 连接（`vectr_<slug>`）和独立端口。

## 前置条件

- 带 web profile 的 DeepSeek Harness 宿主。
- 已安装 Vectr，且至少有一个项目被它索引过——插件只绑定 `~/.vectr/instances.json` 里**已经存在**的守护进程，不负责安装或创建它们。安装与 CLI 用法见 [Vectr 文档](https://swapnanilsaha.com/tools/vectr)。

## 安装

在包含本仓库的目录下执行：

```sh
dsh plugin --profile web add ./dsh-vectr-client
```

从 git 安装（仓库已提交编译产物 `lib/`，安装时不构建）：

```sh
dsh plugin --profile web add github:WinterSold1er/dsh-vectr-client
```

卸载：`dsh plugin --profile web remove dsh-vectr-client`。

`add` 会把插件链接进 Profile、写入 `dsh.profile.bundles`，并在下次启动时应用 `cordis.patch.yml`。**装完请重启宿主**——`/api/vectr/*` 路由和 Settings 分区都在启动时注册，已在运行的宿主不会凭空出现控制台。

## 绑定是怎么工作的

1. `agent/created`（以及启动时已经在跑的 Agent）把会话 `cwd` 交给插件。
2. `~/.vectr/instances.json` 以 `sha256(<工作区绝对路径>)[:12]` 为键。查找顺序：精确键 → 已存路径的精确字符串匹配（容错尾部斜杠）→ 前缀匹配（让注册工作区**内部**的子目录落到该工作区）。
3. 绑定前先做存活检查：pid、TCP 端口，以及带短超时的 `GET /v1/status`。
4. 工具只注册进该 Agent 的作用域；`agent/disposed` 时关闭连接并卸载。

没有 `cwd` 的会话会被跳过并记一条警告——刻意不做 `process.cwd()` 兜底，那会把 Agent 绑到错误的工作区。细节见 `src/index.ts`、`src/registry.ts`。

## Settings → Vectr 控制台

Web 端挂载一个控制台（`/api/vectr/*` 路由由本插件提供服务端实现）：

- 顶部统计条：已注册 / 在线 / 仅记忆 / 离线；
- **每个工作区一张卡片**：名称与完整路径、状态 + 模式 + 就绪三枚 pill（仅记忆模式始终按规范拼写显示）、端口 / 文件数 / 笔记数 / 语言，以及 re-index 按钮；
- 展开卡片可见该工作区的代码库（测试 / 启动 / 删除）与新建表单，表单绑定到当前工作区；
- 真实的空状态与错误状态——接口失败时显示接口返回的实际错误，而不是一张空表。

关于图标的一句实话：设置**左侧导航**的图标由 Harness 宿主按固定 id→图标映射决定，未知 id 回落到设置齿轮，插件无法设置它。本插件自己的标记出现在面板标题旁与输入框旁。

## 配置

`cordis.patch.yml` 只插入一行（`serverName: vectr`）；其余键可在你的 Profile patch 里覆盖：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `instancesPath` | `~/.vectr/instances.json` | 守护进程注册表文件 |
| `serverName` | `vectr` | 工具命名空间 `mcp__<serverName>__*` |
| `toolCallTimeoutMs` | `60000` | 单次 Vectr 工具调用超时 |
| `reconnect.enabled` | `true` | 连接丢失后自动重连（同一端口） |
| `reconnect.initialDelayMs` / `maxDelayMs` / `maxAttempts` | `500` / `30000` / `10` | 退避：每次失败翻倍；`maxDelayMs` 同时也是重试预算重置所需的连续在线时长 |
| `daemonHttpTimeoutMs` | `5000` | `/v1/status` 探活预算 |
| `daemonTcpTimeoutMs` | `300` | TCP 端口预检预算 |
| `codebasesPath` | `~/.dsh/vectr-codebases.json` | 多代码库元数据 |
| `secretsPath` | `~/.dsh/vectr-secrets.json` | 文件式凭据保险箱（权限 `0600`；宿主提供凭据服务时优先走系统安全通道） |
| `cliPath` | 由 `PATH` 推导 | 自定义 `vectr` 可执行文件 |
| `cliTimeoutMs` / `recallTimeoutMs` / `upgradeTimeoutMs` | `30000` / `10000` / `15000` | CLI、笔记召回、工作区升级的超时预算 |

## 已知限制

- **首轮时序竞争** — 连接是异步建立的（这样守护进程死了也绝不会阻塞 Agent 发布），所以极少数情况下首轮提示词发出时工具尚未注册，下一轮就有。
- **守护进程换端口重启不会被重新解析** — 重连只重试同一端口；新端口要等下一次 `agent/created`。挪动守护进程后请开新会话（或重启宿主）。
- **绑定失败对模型不可见，只在日志里** — Agent 就是没有 Vectr 工具；警告里带 workspace/cwd/port/pid。
- **只桥接工具** — Vectr 的 resources/prompts 不桥接。
- **控制台需要重启宿主才出现** — 路由与 Web 分区在启动时注册；没有 `ctx.webServer` 的宿主组合会跳过它们并告警，MCP 绑定不受影响。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit，服务端 + Web 端
pnpm test        # vitest
pnpm build       # tsc → lib/（服务端 + Web 端）
```

`lib/` 已提交，使用者无需构建。`link:` 指向本地 Harness 检出且含绝对路径，因此 `pnpm-lock.yaml` 与 workspace 文件是开发专用的并已 gitignore——请把 `link:` 指到你自己的检出。

## 致谢

- [Vectr](https://github.com/swapnanil/vectr)，作者 [Swapnanil Saha](https://swapnanilsaha.com/tools/vectr)：语义索引、工作记忆存储与守护进程。
- 本插件是它在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的集成层。

## 许可证

MIT —— 见 `package.json`。
