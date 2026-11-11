# vectr 注册表语义审计（只读）

审计对象：`~/.dsh/vectr-codebases.json`（15 条）、`~/.dsh/storages/workspace.json`（24 条）、`src/*.ts`。实测日期 2026-11-11。

## 结论先行（直答三问）

1. **为什么 JSON 缺 DSH 工作区**：不是 bug。`vectr-codebases.json` 只记录「被显式注册过的 codebase」，注册唯一入口是 `POST /api/vectr/codebases`（`src/index.ts:1865`）→`createCodebase`。DSH 工作区列表（24 条）只在 console 与 start-all 时**只读并入**（`src/workspaces.ts:284-303`、`src/index.ts:1181-1183`），从不写回该 JSON：`src/workspaces.ts` 内无任何 `saveCodebases` 调用（全仓仅 `src/codebases.ts:778/868/1015/1751`）。
2. **到底用什么标注**：每条 codebase 的 `workspace` 字段 = **归属的 DSH 工作区绝对路径**；缺省值是自己的 `path`（`src/codebases.ts:423` `const workspace = spec.workspace ?? spec.path`）。所以 15 条中 10 条 `workspace === path`（自挂），5 条才是真正的跨目录归属。
3. **为什么感觉乱**：`codebase` 与 `workspace` 是两个独立集合（有 codebase 不属于任何 DSH 工作区），`workspace` 又兼具「归属标注」与「自身路径」两种含义，再叠加三条互不同步的数据源 + 无 schema 版本 + `status` 是快照。详见第 6 节。

## 1. DSH 侧如何枚举工作区

`discoverWorkspaceRoots()`（`src/workspaces.ts:80`）读 `DEFAULT_DSH_WORKSPACE_FILE`（`src/workspaces.ts:41`）= `$DSH_HOME/storages/workspace.json`，缺省 `~/.dsh/storages/workspace.json`。

| 项 | 事实 | 证据 |
| :-- | :-- | :-- |
| 存储形状 | `{ unit, global, tables: { workspaces: { <id>: { path, title } } } }` | `src/workspaces.ts:98`；实测 top keys `['unit','global','tables']` |
| 取用字段 | 仅 `path`（必填）+ `title`（可选，trim 后非空才保留） | `src/workspaces.ts:105-114` |
| 过滤 | `path` 必须是字符串、非空、`isAbsolute` | `src/workspaces.ts:105` |
| 归一化 | `normalizeWorkspacePath = resolve()`（消 `./`、`..`、尾斜杠） | `src/workspaces.ts:62-64` |
| 去重键 | `normalizeWorkspacePath(path)`，文件序保留首个 | `src/workspaces.ts:106-108` |
| 失败模式 | 读/解析失败 → `onError` + 返回 `[]`（不抛） | `src/workspaces.ts:86-96` |
| 并集 | registry 记录优先，仅补 discovered-only 行（`live:false, reason:'not started'`）；标题回填 | `src/workspaces.ts:284-303` |

## 2. `vectr-codebases.json` 字段语义

类型定义 `src/domain/types.ts:99-134`（15 条实测 key：`host id localPort path remotePort serverName slug status tunnelCtl type workspace`）。

| 字段 | 语义 | 派生/冗余 |
| :-- | :-- | :-- |
| `id` / `slug` | 同一值重复两份。注释即「slug duplicate field kept for callers expecting id + slug」 | **完全冗余**（`types.ts:100-103`） |
| `path` | codebase 自身目录；注释写「Absolute workspace path served by the daemon」，与实际数据不符（挂载场景下 path≠served root） | 注释漂移 |
| `workspace` | 归属工作区；缺省 `= path` | `codebases.ts:423` |
| `serverName` | 派生：`vectr_<sha256(workspace)[:12]>_<slug>` | **派生值**（`codebases.ts:222-224`，常量 `WORKSPACE_KEY_LENGTH`） |
| `status` | 连接状态**快照**，只在注册/启停/隧道修复时重写 | `types.ts:128-129`；写入点 `codebases.ts:1178,1262,1495,1511,1632` |
| `localPort`/`remotePort`/`host`/`tunnelCtl` | 运行期连接参数 | 无 |
| `isPrimary` | 不落盘；仅 `GET /api/vectr/codebases` 时合成 primary 行 | `src/index.ts:1824-1833` |
| schema 版本 | **不存在**：顶层是裸数组，`loadCodebases` 要求 `Array.isArray` | `src/codebases.ts:264-265` |

写入/删除时机：`createCodebase`（`codebases.ts:350`，POST `index.ts:1865`）、`deleteCodebase`（`:788`，DELETE `index.ts:1910`）、`patchCodebase`（`:985`，PATCH `index.ts:2070`）、`migrateCodebases`（`:1692`，旧条目迁移）。所有落盘走 `persist()`（`:775`）→`saveCodebases`（`:281`，tmp+rename，0600）。

## 3. 精确差集（DSH 24 个 workspace vs JSON 10 个 workspace 值）

`DSH_NOT_IN_REG` = 14 条，全部目录存在（无软链/缺失差异）：

| 缺失工作区 | 分类 |
| :-- | :-- |
| `/home/csy`、`Code/installer/mihomo`、`Code/Github/{rustdesk,dsh-caveman,dsh-ponytail,strata-platform,dsh-force-subagent,magisk-tailscaled,vectr,fuse-nfs}`、`/home/csy/公共` | **从未注册**（11 条，DSH 有、vectr 无 codebase 记录） |
| `/home/csy/Work/vnm`、`/home/csy/Work/vnm_rust` | **跨目录归属**：已注册为 codebase，但 `workspace` 写了 `/home/csy/Work/two`（`codebases.ts:423` 显式传入） |
| `/home/csy/Code/Github/cloudcode-link-core` | **跨目录归属**：`workspace` 写了 `/home/csy/Code/Github/dsh-cloudcode-link` |

反向：有 2 个 codebase 的 `path` 不属于任何 DSH 工作区 —— `libtlv`（`/home/csy/Work/libtlv`，ws=`v2v_ws_plugin`）、`vnm_gui`（remote，`/home/edogawaconan/...`，ws=`/home/csy/Work/two`）。`REG_NOT_IN_DSH` = 0。

## 4. 是否真实缺陷

缺失本身**不是缺陷**：设计上 discovery 只服务 console/start-all，不负责注册（第 1 节并集不写回）。`status:'up'` 全 15 条说明 daemon 侧正常。真实问题另有两处：

- **B1（真实缺陷，低危）**——**已修复**：`src/codebases.ts:362` 现为 `assertServerNameAvailable(normalizeWorkspacePath(spec.workspace ?? spec.path), spec.slug)`，与建议的最小修复一致（同一未提交变更集内）。原缺陷：唯一性预检用**未归一化**的 `spec.workspace ?? spec.path`，而权威检查在 `:432` 用归一化后的 `workspace`（`:409-412` 才归一化）。同一目录的 `…/two` 与 `…/two/` 拼写会绕过 `createLocks` 预检，只在 core 内才抛错。
- **B2（真实不一致，中危）** 两套归一化并存：`src/workspaces.ts:63` 用 `resolve()`（消 `./`），`src/domain/rules.ts:56` 只 `trim + 去尾斜杠`；且 `isWorkspaceMatch`（`rules.ts:69-75`）额外做前缀包含，console 去重（`workspaces.ts:289-293`）不做。结果：同一目录可能在 console 算 1 个、在 `hasIndexedCodebase`（`rules.ts:135`）里算多个。最小修复：`rules.ts:56` 复用 `normalizeWorkspacePath`（**未做**）。

## 5. 记录纠偏

任务描述里的 `src/domain/rules.ts:126 hasActiveIndexedCodebase` **不存在**。实际函数名 `hasIndexedCodebase`（`rules.ts:135`，其 `isMemoryOnly` 分支在 `:143`）；`:126` 是 `hasCodebase`（`rules.ts:109`）的闭合行。

## 6. 「怎么感觉那么乱」——5 条具体事实

1. **双概念**：codebase ≠ workspace。15 个 codebase path 里 2 个不在 24 个 DSH 工作区中。
2. **`workspace` 双义**：既是归属标注，又等于自身 `path`（10/15 条），看数据无法区分「自挂」与「被挂」。
3. **一对多**：`/home/csy/Work/two` 一挂 4 个（`two`、`vnm`、`vnm_rust`、`vnm_gui`）；`v2v_ws_plugin`、`dsh-cloudcode-link` 各挂 2 个。
4. **三源不同步**：`vectr-codebases.json`（可写）、`~/.vectr/instances.json`（daemon 事实）、DSH `workspace.json`（只读），console 还在 `index.ts:1824-1833` 合成第四类 primary 行。
5. **无版本 + 快照**：裸数组无 `schemaVersion`；`status` 是写入时刻快照，不代表当前存活。

**最低成本一致性改进（唯一建议，不重写 schema）**：console 行补齐一个 `registered: boolean`（该 workspace 在 codebases.json 是否已有记录），并把 `rules.ts` 的 `normalizePath` 换成 `normalizeWorkspacePath`。前者让「缺记录」可见，后者消除双归一化，约 10 行改动。

## 证据（实际运行命令与关键输出）

```
$ python3  # set diff, ~/.dsh/storages/workspace.json vs ~/.dsh/vectr-codebases.json
dsh 24 reg 10
DSH_NOT_IN_REG: 14 条（全部 exists，无 MISSING_DIR）
REG_NOT_IN_DSH: 0

$ python3 -c '...top keys...'
['unit', 'global', 'tables']  workspaces: dict 24

$ python3  # 15 条 codebase
libtlv|local|/home/csy/Work/libtlv|/home/csy/Work/v2v_ws_plugin
vnm_rust|local|/home/csy/Work/vnm_rust|/home/csy/Work/two
vnm|local|/home/csy/Work/vnm|/home/csy/Work/two
vnm_gui|remote|/home/edogawaconan/Code/Work/vnm_gui|/home/csy/Work/two
cloudlink-core|local|/home/csy/Code/Github/cloudcode-link-core|/home/csy/Code/Github/dsh-cloudcode-link
（其余 10 条 workspace == path）
status/serverName 集合：15 条全为 status='up'，serverName 均形如 vectr_<12hex>_<slug>

$ grep -rn "saveCodebases(" src/ | grep -v "export function"
src/codebases.ts:778 / :868 / :1015 / :1751   ← workspaces.ts 无写回
（注意：grep 曾误扫 lib/ 下压缩产物，结论只取 src/）

$ vectr_locate discoverWorkspaceRoots → src/workspaces.ts:80（另有 lib/index.js:603 编译产物）
```

未验证：`start-all` 对 discovered-only 工作区调用 `deps.start`（`src/index.ts:1268-1290`）后是否间接产生 codebase 记录 —— 代码路径上 `VectrCliRunner.start` 只写 `~/.vectr/instances.json`，未实测跑一次 start-all。
