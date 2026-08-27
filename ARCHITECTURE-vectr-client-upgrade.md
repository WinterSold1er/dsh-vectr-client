# 架构设计：dsh-vectr-client 存活门升级 / 诊断清理 / 重建部署

> 角色：架构师（技术负责人）。依据需求规格 + 代码实查（src/index.ts, src/workspaces.ts, package.json, tsconfig*, cordis.patch.yml, tests/, ~/.vectr/instances.json, ~/.dsh/profiles/web 链路）产出。供开发工程师直接实现。
> 核心原则：配置外部化、依赖倒置、抽象边界；更换配置来源/值不需改核心逻辑。禁止硬编码 daemon 地址/端口/主机端口。

---

## 0. 实查事实（设计依据，非推测）

- `src/index.ts:479-498` 确有 TEMP DIAGNOSTIC 块（含 `ctx.get('sessionProjections')` 与 `ctx.effect(...,'vectr-client:diag-timeout')`）。R1 删除点精确。
- `isDaemonAlive`（`src/index.ts` 当前）只做进程层：pid `kill(0)` 成功 → alive；无 pid → 纯 TCP `isPortListening`。**未复用 `fetchStatus`**，故无法识别"pid 在+端口在听但 HTTP 挂死"。
- `fetchStatus(entry, timeoutMs)` 在 `src/workspaces.ts:79`，私有（未 export），做 `GET http://host:port/v1/status` 带 `AbortController` 超时，非 2xx/抛错 → `undefined`。**必须复用，禁止重实现**。
- 循环依赖现状：`index.ts` import `scanWorkspaces/triggerIndex` from `workspaces.ts`；`workspaces.ts` import `isDaemonAlive/readInstancesFile` from `index.ts`。即 `index ↔ workspaces` 互引（ESM live binding 勉强成立，但脆弱且阻碍 DI）。
- `package.json` `exports["./client"]` = `{ types: ./lib/client/index.d.ts, default: ./lib/client.js }`。`lib/client.js` 是 tsdown 产物（CJS + `window.__ModuleLoader__` 包裹，**非 node 可 import**），当前为 untracked（`??`）；`lib/client/index.js` 是 `tsc -p tsconfig.client.json` 产物（ESM，node 可 import），tracked。
- **构建链缺口**：`npm run build` = `tsc -p tsconfig.json && tsconfig.build.json && tsconfig.client.json`，**不含 tsdown**。即 `lib/client.js` 不会被 `npm run build` 重建。R6/AC7 必须补齐该步。
- 部署链路：`~/.dsh/profiles/web/package.json` 声明 `"dsh-vectr-client": "link:/home/csy/Projects/dsh-vectr-client"`；`~/.dsh/profiles/web/node_modules/dsh-vectr-client` → `~/Projects/dsh-vectr-client`（symlink）。3081/3080 经此 symlink 读取插件树。
- 3081 服务的 `/plugins/dsh-vectr-client/client.js` = 树内 `lib/client.js`（tsdown 产物，MD5 当前 d8b9e63d 为旧包）。
- web profile `cordis.patch.yml:134` 已有 `- id: vectr-client inject: ['agents','webServer']`，**已正确接线，无需改动**。
- `~/.vectr/instances.json` 现状：`edacb50f116d` → two/8767/pid 3516405（健康）；`b5b2266ddc64` → twoplus/8765/pid 2483691/host 127.0.0.1（pid 在、TCP 在听、HTTP 挂死）。所有 host/port/pid 均来自文件，无硬编码。
- src 内无 8765/8767/3080/3081 硬编码（仅 `src/index.ts:6` 注释含 "localhost"，非字面量地址）。P2/P7 基线干净。

---

## 1. 模块边界与依赖方向

### 1.1 拆分（破环 + 支撑 DI）

| 模块 | 文件 | 职责 | 对外接口（抽象） |
|---|---|---|---|
| registry 层 | `src/registry.ts`（新） | 类型 + 读取解析 instances.json + cwd→entry 解析 | `InstanceEntry`,`InstancesFile`,`readInstancesFile()`,`resolveInstance()`,`DEFAULT_HOST` const |
| probe 探测层 | `src/probe.ts`（新） | 进程层（pid/TCP）+ HTTP 层组合判定；**纯函数、无 cordis、无 config 读取** | `isPortListening()`,`fetchStatus()`,`isDaemonAlive()`,`HttpProbe` 类型 |
| console 层 | `src/workspaces.ts` | 控制台视图 `scanWorkspaces`/`triggerIndex` | 不变，改 import 来源 |
| binding 连接层 | `src/index.ts` | `apply`/`install`/路由/凭证；依赖注入装配 | 不变接口，删诊断块 |
| client 浏览器半 | `src/client/*` + tsdown | 浏览器 UI 半 | 独立产物 `lib/client.js` |

### 1.2 依赖方向（必须）

```
registry (leaf)  ──►  probe  ──►  workspaces  ──►  index(binding+apply)
                     ▲                │                │
                     └────────────────┴────────────────┘  (workspaces/index 仅 import probe/registry)
client ── 仅依赖浏览器平台模块（react/cordis client slots），不依赖上述任何服务端模块
```

- probe **禁止** import `cordis`、`Config`、或 `index`/`workspaces`。保证 NFR3 单测零依赖。
- workspaces **禁止** import `index`（破环）；改从 `registry`/`probe` 取 `isDaemonAlive`/`fetchStatus`/`readInstancesFile`。
- index(binding) **禁止** import `workspaces` 的内部私有符号；仅用其导出函数。
- binding 与 console 互不依赖内部实现。
- client 与服务端模块零耦合。

> 最小替代方案（若取更小 diff）：至少将 `fetchStatus` 从 `workspaces.ts` 导出，`isDaemonAlive` 复用之；可接受既有 `index↔workspaces` 循环依赖。但推荐完整拆分以彻底破环并满足依赖方向禁令。

---

## 2. 存活门新判定接口设计（R3 / NFR3）

### 2.1 新签名（抽象）

```ts
// src/probe.ts
export type HttpProbe = (entry: InstanceEntry, timeoutMs: number) => Promise<VectrStatus | undefined>

export async function isDaemonAlive(
  entry: InstanceEntry,
  deps: { httpProbe: HttpProbe; httpTimeoutMs: number; tcpTimeoutMs: number },
): Promise<boolean>

export function isPortListening(host: string, port: number, timeoutMs: number): Promise<boolean>
export async function fetchStatus(entry: InstanceEntry, timeoutMs: number): Promise<VectrStatus | undefined>
```

### 2.2 组合逻辑（精确对应 R3）

```
processLayer = (entry.pid !== undefined && kill(pid,0) 成功)   // ESRCH/ENOENT→死；EPERM/成功→活
             OR (isPortListening(entry.host ?? DEFAULT_HOST, entry.port, tcpTimeoutMs))

httpLayer    = (await httpProbe(entry, httpTimeoutMs)) !== undefined   // 复用 fetchStatus：非2xx/超时/抛错→undefined

alive = processLayer AND httpLayer
```

- **twoplus 8765 场景**：pid 2483691 在 → processLayer=true；HTTP /v1/status 挂死 → httpProbe 超时返回 undefined → httpLayer=false → **alive=false → skip + warn**。满足 R3/R4。
- `httpProbe` 默认实现 = `(e, ms) => fetchStatus(e, ms)`。单测注入假 probe（返回 status 对象=健康；返回 undefined=挂死；throw=超时）即可覆盖 NFR3 全场景，无需真网络。
- `isDaemonAlive` 内部对 `httpProbe` 包 try/catch：抛错一律按 `httpLayer=false` 处理（绝不向上抛）。

### 2.3 超时来源（Config 化，NFR2）

- `httpTimeoutMs`、`tcpTimeoutMs` 由调用方（install）从 `Required<Config>` 下传，**不**在 probe 内读全局配置（依赖倒置）。
- 默认值见 §4。

### 2.4 NFR3 覆盖矩阵（vitest，注入 probe + 小超时）

| 场景 | 注入 | 期望 |
|---|---|---|
| 健康 | pid 活 + probe 返回 status | true |
| pid 死(ESRCH) | kill(0)→ESRCH | false |
| 无 pid + 端口关 | TCP 失败 | false |
| 端口开 + HTTP 挂死 | pid 活/TCP 真 + probe undefined | false |
| HTTP 超时 | probe throw | false |
| registry 缺失 | readInstancesFile→undefined | install 早退不绑定（非 isDaemonAlive 范畴） |
| registry 损坏 | readInstancesFile throw | install catch→warn+skip 不抛 |

---

## 3. 降级策略设计（R4 / NFR4）

### 3.1 skip 路径（绝不抛）

- `readInstancesFile` 抛错（损坏）→ install catch → warn + return（不抛进 `agent/created` 监听）。
- `readInstancesFile` 返回 undefined（缺失）→ install 早退。
- `isDaemonAlive`=false → warn + return，不 `startConnection`。
- install 内 liveness 探测仍跑在 `void (async()=>{...})()` 非阻塞 IIFE，绝不延迟 `agent/created` 发布（保留 D-2/D-7 行为）。

### 3.2 warn 日志规范（必须含 cwd/port/pid/原因）

统一由纯函数 `formatSkipWarn(entry, reason)` 产出（建议放 probe 或 index 内小helper），形如：
```
vectr-client: vectr daemon not alive, skipping bind for session <agentId> (cwd=<cwd>, workspace=<entry.workspace>, port=<port>, pid=<pid|n/a>, reason=<PROCESS_DEAD_ESRCH|PORT_CLOSED|HTTP_PROBE_TIMEOUT|HTTP_PROBE_UNREACHABLE>)
```
- 原因枚举：`PROCESS_DEAD_ESRCH` / `PORT_CLOSED` / `HTTP_PROBE_TIMEOUT` / `HTTP_PROBE_UNREACHABLE`。
- 多 workspace 并发：每个 agent 独立 IIFE + 独立 handle，互不 await（NFR4 天然满足，无需共享锁）。

### 3.3 异常边界（绝不发生）

- 不在 `agent/created` / `agent/disposed` 监听器内 throw。
- `isDaemonAlive` 自身不抛（httpProbe 异常已兜）。
- `startConnection` 失败仅 warn（D-1），不阻塞。

---

## 4. Config 注入策略（NFR2）

`Config`（z 校验）新增字段；**读取方只接收值，不自行解析来源**（apply 解析一次，向下透传）。

| 字段 | 类型 | 默认值 | 来源 | 说明 |
|---|---|---|---|---|
| `instancesPath` | string | `~/ .vectr/instances.json` | Config | 每次 install 重读（D-7） |
| `serverName` | string | `'vectr'` | Config | startConnection + policy label |
| `toolCallTimeoutMs` | number | 60000 | Config | 透传 startConnection |
| `daemonHttpTimeoutMs` | number | **5000** | Config（新增） | HTTP /v1/status 探测预算；< 已知挂死时长(8s) 以正确判死 |
| `daemonTcpTimeoutMs` | number | **300** | Config（新增） | TCP 探测预算（原 isPortListening 默认） |
| `reconnect` | object | `{enabled:false}` | Config | 保留 D-6 语义 |
| `codebasesPath` | string | `~/ .dsh/vectr-codebases.json` | Config | feature B |
| `secretsPath` | string | `~/ .dsh/vectr-secrets.json` | Config | feature B |
| `DEFAULT_HOST` | `'127.0.0.1'` | 模块常量 | **非 Config** | 仅 `entry.host` 缺失时兜底（需求允许） |

**禁止硬编码清单（设计约束）**：8765 / 8767 / 3080 / 3081 / 任何 daemon 实际地址端口 → 全部来自 `instances.json` + Config。仅 `DEFAULT_HOST` 允许作为常量默认（host 缺省）。

---

## 5. 部署面归属裁决（B4 / R6）

### 5.1 允许操作（插件侧）

1. **重建产物（in-tree）**：补齐构建链——`npm run build` 须含 tsdown 步（新增 `build:client` 脚本或并入 build：`tsdown --config tsdown.config.ts`）。产 `lib/types/*`、`lib/index.js`、`lib/client/index.js`、**`lib/client.js`**。
2. **依赖 symlink 让 3081/3080 直接读取新树**：`~/.dsh/profiles/web/node_modules/dsh-vectr-client → ~/Projects/dsh-vectr-client` 已在。重建后**无需复制**，host 经 symlink 读取新 `lib/`。
3. **插件自带 `cordis.patch.yml`**：仓库内文件，声明 bundle.patch，属插件资产，允许保留/修改（当前已正确）。web profile 的 `cordis.patch.yml:134` 接线已就绪，**不触碰**。

### 5.2 越界（绝对禁止，P1）

- 改 `~/Code/installer/deepseek-harness-official` 或 `~/Projects/deepseek-harness` 任何文件（含其 `lib/index.js`）。
- 改 DSH 核心 serving 机制源码。
- 手动拷入核心 node_modules（除既定 symlink 机制外）。

### 5.3 验证「bundle 被 3081 实际服务」（AC7）

> **AC7 语义（部署核对，非字节变化归因）**：`curl -s http://127.0.0.1:3081/plugins/dsh-vectr-client/client.js | md5sum` 须 `==` 树内 `lib/client.js` 的 md5 且 `!= d8b9e63d`。这是「3081 实际在 serve 新树产物」的部署一致性核对，**不**把 R1–R4 的服务端改动与字节变化错误绑定——AC7 由**浏览器侧真实改动**（reason 列 + codebases 修复这些 `src/client/*` 改动）驱动 `lib/client.js` 重算而满足，与 R1–R4 是否已部署无关。

- 步1：重建后 `md5sum lib/client.js` 记为 `NEW`。
- 步2：`curl -s http://localhost:3081/plugins/dsh-vectr-client/client.js | md5sum` → 须 `≠ d8b9e63d` 且 `== NEW`。
- 步3：若 MD5 未变 → 重启 3081/3080 web profile 进程以刷新 bundle 缓存（**操作运行进程，非改源码**，在界内）；再验步2。
- 步4（AC8 双跑一致）：3080/3081 同读一棵 symlink 树 → 同 `lib/client.js` → 一致由构造保证。

> 注意 R2 易踩坑：改 `exports["./client"].default` 指向 `lib/client/index.js`（node 可 import 的 tsc 产物）**正确且不影响 host 加载**——host 经路径服务的是 tsdown 的 `lib/client.js`，不走 npm exports。但**绝不能因 R2 而删除 tsdown 构建**：`lib/client.js` 才是 3081 实际服务的浏览器半产物，删之 AC7 必败。

---

## 6. B3 裁决（插件侧完成若 AC5 仍败）

- AC5 失败且插件侧已满足 AC1-AC4/AC6/AC7 → 问题归属 **DSH 核心**（其 `mcp-client/src` 有 +9 uncommitted re-export、`session-projection` src 守卫已删但 `lib/index.js` 未重建）。
- 处置：**记录为阻塞（blocker），归属核心 owner；插件侧不修改核心**。交付证据包：① 插件 `npm run build` 0 错；② `lib/client.js` MD5≠d8b9e63d；③ 3081 实际服务新包（§5.3 步2）；④ 健康 two/8767 的连接 attempt 日志（证明请求到达 mcp-client 后于核心处失败）。
- 不自行改核心源码（P1）。

---

## 7. 关键接口签名汇总（无实现）

```ts
// registry.ts
export interface InstanceEntry { workspace: string; port: number; pid?: number; started_at?: number; mode?: string; host?: string; extra_roots?: string[]; code_workspace_file?: string|null }
export type InstancesFile = Record<string, InstanceEntry>
export const DEFAULT_HOST = '127.0.0.1'
export function readInstancesFile(ctx, path): InstancesFile | undefined   // 缺失→undefined；损坏→throw
export function resolveInstance(instances, cwd): InstanceEntry | undefined

// probe.ts
export type HttpProbe = (entry: InstanceEntry, timeoutMs: number) => Promise<VectrStatus | undefined>
export function isPortListening(host: string, port: number, timeoutMs: number): Promise<boolean>
export function fetchStatus(entry: InstanceEntry, timeoutMs: number): Promise<VectrStatus | undefined>  // 复用，禁重实现
export async function isDaemonAlive(entry, deps: { httpProbe: HttpProbe; httpTimeoutMs: number; tcpTimeoutMs: number }): Promise<boolean>

// index.ts（binding）
export function install(ctx, handles, instancesPath, config: Required<Config>, agent, codebasesPath?): void
export function apply(ctx, config?: Config): void   // 删 TEMP DIAGNOSTIC；装配 defaultProbe=(e,ms)=>fetchStatus(e,ms)
export interface Config { instancesPath?; serverName?; toolCallTimeoutMs?; daemonHttpTimeoutMs?; daemonTcpTimeoutMs?; reconnect?; codebasesPath?; secretsPath? }
```

---

## 8. 禁止事项重申（对照 P1-P7）

- **P1** 禁改 DSH 核心（`~/Code/installer/deepseek-harness-official`、`~/Projects/deepseek-harness`）。部署只走 symlink+重建，不动核心。
- **P2** 禁硬编码 daemon 地址/端口（8765/8767 等）→ 全来自 instances.json + Config。
- **P3** 禁 `process.cwd()` 兜底 → 无 cwd 即 skip（D-4 保留）。
- **P4** 禁残留 TEMP DIAGNOSTIC / sessionProjections / diag-timeout → R1 整块删除，grep 0 匹配。
- **P5** 禁探测参数散落字面量 → 全部走 `daemonHttpTimeoutMs`/`daemonTcpTimeoutMs`/Config。
- **P6** 禁删 D-fix 合理行为 → D-2 存活门、D-4 无cwd skip、D-7 每次重读 registry、D-6 reconnect 语义、D-1 连接失败上日志，全部保留。
- **P7** 禁硬编码工作目录 → cwd 取自 `agent.session.header.cwd`；registry/codebase 路径走 Config（带 ~/ 默认常量）。

---

## 9. 不合理约束指出

- **R2 字面易误读**：若仅改 `exports` 而删 tsdown 步，AC7 必败。已在上文（§5.3 注意）澄清正确做法——改 export 指向 + 保留/补齐 tsdown 构建。
- **构建链缺口（需求未提但阻塞 AC7）**：`npm run build` 缺 tsdown，须补。属插件侧，允许。
- **host 默认 127.0.0.1 作常量**：需求允许，仅作 `entry.host` 缺失兜底，非硬编码 daemon 地址，符合要求。

---

## 99. QA 已知问题记录（仅记录，不改行为）

- **F1（记录）— `lib/client/index.js` 不被 Node 直接 import**：tsc 产物含无扩展相对导入（`./codebases` 等），Node ESM 解析报 `ERR_MODULE_NOT_FOUND`。不影响 host：实际服务的是 tsdown 产物 `lib/client.js`（CJS 包裹），AC3 仍满足。如需 Node 直接 import，应在 `tsconfig.client.json` 加 `"moduleResolution":"Bundler"` 或给相对导入补 `.js` 扩展名——但属于构建侧增强，不在本次修复范围。
- **F4（记录）— `HTTP_PROBE_TIMEOUT` 生产不可达**：`fetchStatus` 内部吞掉所有异常返回 `undefined`，默认 probe 永不抛 → 生产路径只可能得到 `HTTP_PROBE_UNREACHABLE`（undefined），`HTTP_PROBE_TIMEOUT`（throw 路径）仅测试注入 `httpProbe` 抛错时触发。语义边界已写入 `src/probe.ts` 注释；正确性无影响（两者皆 `alive:false`），故不改行为。
