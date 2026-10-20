[English](README.md)

# dsh-vectr-client

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。它给项目里的每个 Agent 两样东西：**语义检索 (Semantic Search)** 和**可靠工作记忆 (Reliable Working Memory)**。前者是当前项目的语义索引，后者是一份活过对话的记忆。Agent 按意思找代码，不用满仓库 grep；写下的笔记熬得过上下文压缩；新会话接着上次的进度继续干。这些按工作区自动完成，不用你操心。

> **基于 Vectr 开发 (Based on Vectr)**：本项目建立在 Swapnanil Saha 开发的 [Vectr](https://github.com/swapnanil/vectr) 之上，[官网与文档](https://swapnanilsaha.com/tools/vectr) 在这里。索引、记忆存储和守护进程都由 Vectr 提供；本插件是它在 Harness 里的集成层，负责绑定、界面和按工作区分发。

## 能做什么

- **按语义找代码** —— Agent 说清楚要找什么概念、符号或调用关系（比如“工作区锁在哪儿释放的？”）就能命中，不用跑 grep 循环。工具挂在 `mcp__vectr__*` 下面，只对当前 Agent 可见。
- **记忆熬得过上下文压缩** —— 存成笔记的发现，一次调用就能取回。不管是本次会话稍后、上下文被裁剪之后，还是新开的会话。
- **目录对哪个守护进程，自动连** —— 每个 Agent 启动时，插件读会话的 `cwd`，去 `~/.vectr/instances.json` 里找这个目录对应的 Vectr 守护进程，然后连上。A 工作区的 Agent 拿不到 B 工作区的工具，也用不着维护全局 MCP 配置。
- **不阻塞，不挂死** —— 守护进程没装、已死或者没响应，最坏也就是“这个 Agent 没有 Vectr 工具”。原因会连 workspace/cwd/port/pid 一起写进日志，Agent 照常干活。
- **在输入框旁边看状态** —— 会话头部的胶囊显示当前会话守护进程的状态、模式和端口；输入框旁边有个触发器，点开就是控制台。会话还没有目录时，两处都会干净复位。
- **一键拉起全部守护进程** —— 控制台里的 `一键启动全部 Daemon` 按钮，一次请求启完所有已注册的守护进程，并逐个工作区列出结果。
- **在面板里重建索引** —— 可以直接重建某个工作区的索引；重建不了的时候（仅记忆模式、正在索引、还没就绪、离线），按钮的 tooltip 会说明原因。
- **一个工作区挂多个代码库** —— 本地目录可以，走 SSH 的远程主机也可以（密钥或密码认证）。每个代码库有自己的 MCP 连接（`vectr_<workspaceKey>_<slug>`，key 是 `sha256(工作区路径)` 的前 12 位十六进制）和自己的端口。

## 环境要求

- 带 web profile 的 DeepSeek Harness 宿主。
- 装好 Vectr，且至少有一个项目被它索引过。绑定需要一个**已经注册**的守护进程（`~/.vectr/instances.json` 里有它的记录）；插件不会替你安装 Vectr，也不会建初始索引。安装和 CLI 用法看 [Vectr 文档](https://swapnanilsaha.com/tools/vectr)。

## 安装

在包含本仓库的目录里执行：

```sh
dsh plugin --profile web add ./dsh-vectr-client
```

从 git 安装也可以（仓库已提交编译产物 `lib/`，安装时不构建）：

```sh
dsh plugin --profile web add github:WinterSold1er/dsh-vectr-client
```

卸载：`dsh plugin --profile web remove dsh-vectr-client`。

`dsh plugin add` 只负责把包装进 Profile，**不会改 Profile 清单**。还需要把这个包列进 Profile 的 `dsh.profile.bundles`——手动改 Profile 的 `package.json`，或者用插件管理界面加上——加载器才会枚举它，并在下次启动时套用 `cordis.patch.yml`。**装完记得重启宿主**。`/api/vectr/*` 路由和 Settings 分区都是启动时注册的，宿主已经在跑就不会凭空多出控制台。

## 绑定机制

1. `agent/created` 事件（包括启动时已经在跑的 Agent）把会话的 `cwd` 交给插件。
2. `~/.vectr/instances.json` 用 `sha256(<工作区绝对路径>)[:12]` 做键。查找顺序：先精确匹配键，再精确匹配已存路径（尾部斜杠容错），最后前缀匹配——这样注册工作区**里面**的某个目录也能落到该工作区。
3. 绑定之前先验活：pid、TCP 端口，再来一次短超时的 `GET /v1/status`。
4. 工具只注册进这个 Agent 的作用域。`agent/disposed` 时关闭连接，把工具卸干净。

会话没有 `cwd` 就跳过，记一条警告。这里刻意不做 `process.cwd()` 兜底——那会把 Agent 绑到错误的工作区上。实现见 `src/index.ts`、`src/registry.ts`。

## Settings → Vectr

Web 端挂了一个控制台（`/api/vectr/*` 的服务端路由在本插件里）：

- 顶部统计条：已注册 / 在线 / 仅记忆 / 离线；
- **每个工作区一张卡片**：名称和完整路径、状态 + 模式 + 就绪三个 pill（仅记忆模式始终按规范拼写显示）、端口 / 文件数 / 笔记数 / 语言，还有 re-index 操作；
- 展开卡片，能看到它的代码库（测试 / 启动 / 删除），还有一个新建表单，绑定到当前工作区；
- 空状态和错误状态都是真的——接口挂了就显示接口返回的实际错误，不会给你一张空表。

关于图标，说实话：设置**左侧导航**那个图标由 Harness 宿主按固定的 id→图标映射决定，认不出来的 id 回落成设置齿轮，插件设不了。插件自己的标记在面板标题旁边和输入框旁边。

## 配置

`cordis.patch.yml` 只插一行（`serverName: vectr`）；其余键在你自己的 Profile patch 里覆盖：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `instancesPath` | `~/.vectr/instances.json` | 守护进程注册表文件 |
| `serverName` | `vectr` | 工具命名空间 `mcp__<serverName>__*` |
| `toolCallTimeoutMs` | `60000` | 单次 Vectr 工具调用超时 |
| `reconnect.enabled` | `true` | 连接断了自动重连（同一端口） |
| `reconnect.initialDelayMs` / `maxDelayMs` / `maxAttempts` | `500` / `30000` / `10` | 每失败一次退避翻倍；`maxDelayMs` 同时是重试预算重置所需的连续在线时长 |
| `daemonHttpTimeoutMs` | `5000` | `/v1/status` 探活超时 |
| `daemonTcpTimeoutMs` | `300` | TCP 端口预检超时 |
| `codebasesPath` | `~/.dsh/vectr-codebases.json` | 多代码库元数据 |
| `secretsPath` | `~/.dsh/vectr-secrets.json` | 文件式凭据保险箱（权限 `0600`；宿主有凭据服务时以宿主为准） |
| `cliPath` | 由 `PATH` 推导 | 自定义 `vectr` 可执行文件 |
| `cliTimeoutMs` / `recallTimeoutMs` / `upgradeTimeoutMs` | `30000` / `10000` / `15000` | CLI、笔记召回、工作区升级的超时 |

## 已知限制

- **首轮请求有时赶早** —— 连接是异步建立的，所以守护进程死了也挡不住 Agent。代价是第一条提示词有可能在工具注册完成之前就跑起来，下一步就好了。
- **守护进程换了端口，不会被重新解析** —— 重连只认原端口；新端口要等下一次 `agent/created`。挪完守护进程，开个新会话（或者重启宿主）。
- **绑定失败只在日志里，模型看不到** —— Agent 就是没有 Vectr 工具；警告里有 workspace/cwd/port/pid。
- **只桥接工具** —— Vectr 的 resources/prompts 不过桥。
- **控制台要重启宿主才出现** —— 路由和 Web 分区都是启动时注册的。没有 `ctx.webServer` 的宿主组合会跳过它们并告警，MCP 绑定不受影响。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit，服务端 + Web 端
pnpm test        # vitest
pnpm build       # tsc → lib/（服务端 + Web 端）
```

`lib/` 已提交，用的人不用构建。`link:` 这类开发依赖指向本地 Harness 检出，会带上绝对路径——所以 `pnpm-lock.yaml` 和 workspace 文件都是开发专用、已 gitignore。把它们指到你自己的检出。

## 致谢

- [Vectr](https://github.com/swapnanil/vectr)，作者 [Swapnanil Saha](https://swapnanilsaha.com/tools/vectr)：语义索引、工作记忆存储和守护进程。
- 本插件是它在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的集成层。

## 许可证

MIT —— 见 `package.json`。
