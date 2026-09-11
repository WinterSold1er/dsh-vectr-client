/**
 * Session Drawer Modal for Vectr status, codebase management, init, and working memory.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/SessionDrawerModal
 */

import { useState, type ReactNode } from 'react'
import { resolveUnifiedStatus, type SessionVectrState } from '../domain'
import { BTN } from './buttons'
import { CodebaseModal } from './CodebaseModal'
import { MemoryViewer } from './MemoryViewer'

export interface SessionDrawerModalProps {
  workspace: string
  state: SessionVectrState | null
  loading: boolean
  isOpen: boolean
  onClose: () => void
  onRefresh: () => void
}

export function SessionDrawerModal({
  workspace,
  state,
  loading,
  isOpen,
  onClose,
  onRefresh,
}: SessionDrawerModalProps): ReactNode {
  const [activeTab, setActiveTab] = useState<'codebases' | 'memory' | 'ops'>('codebases')
  const [showAddModal, setShowAddModal] = useState(false)

  // Re-index state
  const [reindexing, setReindexing] = useState(false)
  const [reindexMsg, setReindexMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Init state
  const [initHooks, setInitHooks] = useState(true)
  const [initMemoryOnly, setInitMemoryOnly] = useState(false)
  const [initBusy, setInitBusy] = useState(false)
  const [initResult, setInitResult] = useState<{ ok: boolean; text: string } | null>(null)

  // Codebase action states
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [codebaseMsg, setCodebaseMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmDeleteSlug, setConfirmDeleteSlug] = useState<string | null>(null)

  if (!isOpen) return null

  const live = state?.live === true
  const mode = state?.mode ?? 'unknown'
  const isMemoryOnly = mode === 'memory_only'
  const status = state?.status
  const unifiedStatus = resolveUnifiedStatus({
    live,
    mode,
    status,
    reason: state?.reason,
    error: state?.error,
  })

  const handleReindex = async (): Promise<void> => {
    setReindexing(true)
    setReindexMsg(null)
    try {
      const res = await fetch('/api/vectr/session-reindex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (res.ok && data.ok) {
        setReindexMsg({ ok: true, text: '重新索引已触发并开始后台构建' })
      } else {
        setReindexMsg({ ok: false, text: data.error ?? `触发失败 (${res.status})` })
      }
    } catch (err) {
      setReindexMsg({ ok: false, text: `请求异常: ${String(err)}` })
    } finally {
      setReindexing(false)
    }
  }

  const handleInit = async (): Promise<void> => {
    setInitBusy(true)
    setInitResult(null)
    try {
      const res = await fetch('/api/vectr/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace,
          hooks: initHooks,
          memoryOnly: initMemoryOnly,
        }),
      })
      const data = (await res.json()) as {
        ok: boolean
        stdout?: string
        stderr?: string
        error?: string
      }
      if (data.ok) {
        setInitResult({
          ok: true,
          text: `Vectr 工作区初始化完成！\n后续指引：如需启动语义检索与工作记忆守护进程，请在终端执行 vectr start（或配置后台守护进程拉起）。${data.stdout ? `\n\n${data.stdout}` : ''}`,
        })
      } else {
        setInitResult({
          ok: false,
          text: `初始化失败: ${data.error || data.stderr || '未知错误'}`,
        })
      }
    } catch (err) {
      setInitResult({ ok: false, text: `网络错误: ${String(err)}` })
    } finally {
      setInitBusy(false)
    }
  }

  const handleTestCodebase = async (slug: string): Promise<void> => {
    setBusySlug(slug)
    setCodebaseMsg(null)
    try {
      const res = await fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}/test`, {
        method: 'POST',
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (res.ok && data.ok) {
        setCodebaseMsg({ ok: true, text: `Codebase "${slug}" 连通性测试通过` })
      } else {
        setCodebaseMsg({ ok: false, text: `Codebase "${slug}" 连通失败: ${data.error ?? res.status}` })
      }
    } catch (err) {
      setCodebaseMsg({ ok: false, text: `测试请求失败: ${String(err)}` })
    } finally {
      setBusySlug(null)
    }
  }

  const executeDeleteCodebase = async (slug: string): Promise<void> => {
    setBusySlug(slug)
    setConfirmDeleteSlug(null)
    setCodebaseMsg(null)
    try {
      const res = await fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setCodebaseMsg({ ok: true, text: `Codebase "${slug}" 已解绑删除` })
      } else {
        const data = (await res.json()) as { error?: string }
        setCodebaseMsg({ ok: false, text: `删除失败: ${data.error ?? res.status}` })
      }
    } catch (err) {
      setCodebaseMsg({ ok: false, text: `删除请求异常: ${String(err)}` })
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <div className="vectr-modal-backdrop" onClick={onClose}>
      <div className="vectr-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--dsw-alias-bg-layer-1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>⚡</span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>Vectr 会话工作区面板</span>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 600,
                    background:
                      unifiedStatus.kind === 'ready' || unifiedStatus.kind === 'memory_only'
                        ? 'var(--dsw-alias-state-success-tertiary)'
                        : unifiedStatus.isBusy
                          ? 'var(--dsw-alias-state-warn-tertiary)'
                          : 'var(--dsw-alias-interactive-bg-hover-danger)',
                    color:
                      unifiedStatus.kind === 'ready' || unifiedStatus.kind === 'memory_only'
                        ? 'var(--dsw-alias-state-success-primary)'
                        : unifiedStatus.isBusy
                          ? 'var(--dsw-alias-state-warn-primary)'
                          : 'var(--dsw-alias-state-error-primary)',
                  }}
                  title={unifiedStatus.description}
                >
                  {unifiedStatus.kind === 'offline' ? '○ ' : '● '}
                  {unifiedStatus.label}
                </span>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 500,
                    background: isMemoryOnly
                      ? 'var(--dsw-alias-brand-tertiary)'
                      : mode === 'search_only'
                        ? 'var(--dsw-alias-state-warn-tertiary)'
                        : 'var(--dsw-alias-brand-tertiary)',
                    color: isMemoryOnly
                      ? 'var(--dsw-alias-brand-primary)'
                      : mode === 'search_only'
                        ? 'var(--dsw-alias-state-warn-primary)'
                        : 'var(--dsw-alias-brand-primary)',
                  }}
                >
                  {mode}
                </span>
                {state?.port && (
                  <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                    Port: {state.port} {state.pid ? `(PID ${state.pid})` : ''}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-secondary)',
                  marginTop: 3,
                  fontFamily: 'monospace',
                }}
                title={workspace}
              >
                📁 {workspace}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className={BTN.secondary}
              onClick={onRefresh}
              disabled={loading}
              title="刷新状态"
            >
              {loading ? '…' : '🔄 刷新'}
            </button>
            <button
              type="button"
              className="vectr-btn"
              style={{ fontSize: 18, color: 'var(--dsw-alias-label-secondary)' }}
              onClick={onClose}
              title="关闭"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Metrics Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
            padding: '14px 20px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
          }}
        >
          <div className="vectr-metric-card">
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
              📁 索引文件数
            </span>
            <span style={{ fontSize: 18, fontWeight: 600 }}>
              {isMemoryOnly ? (
                <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }}>
                  N/A (仅记忆)
                </span>
              ) : (
                status?.indexed_files ?? (live ? 0 : '-')
              )}
            </span>
            <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>
              {isMemoryOnly ? '无代码目录正常工作' : '已入库文件'}
            </span>
          </div>

          <div className="vectr-metric-card">
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
              🧩 代码块数
            </span>
            <span style={{ fontSize: 18, fontWeight: 600 }}>
              {isMemoryOnly ? (
                <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }}>
                  N/A
                </span>
              ) : (
                status?.total_chunks ?? (live ? 0 : '-')
              )}
            </span>
            <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>
              {isMemoryOnly ? '不建索引' : '语义向量切片'}
            </span>
          </div>

          <div className="vectr-metric-card">
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
              🧠 记忆条目数
            </span>
            <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)' }}>
              {status?.notes_count ?? (live ? 0 : '-')}
            </span>
            <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>
              工作记忆 (Notes)
            </span>
          </div>

          <div className="vectr-metric-card">
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
              ⚡ 运行就绪
            </span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              {live ? (status?.fully_ready !== false ? '已就绪 (Ready)' : '构建中…') : '未运行 (Offline)'}
            </span>
            <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>
              {status?.embed_model ? status.embed_model.split('/').pop() : '嵌入模型未就绪'}
            </span>
          </div>
        </div>

        {/* Tab Header */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            padding: '0 20px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
          }}
        >
          <button
            type="button"
            className={`vectr-tab-btn ${activeTab === 'codebases' ? 'active' : ''}`}
            onClick={() => setActiveTab('codebases')}
          >
            📁 挂载代码库 ({state?.codebases.length ?? 0})
          </button>
          <button
            type="button"
            className={`vectr-tab-btn ${activeTab === 'memory' ? 'active' : ''}`}
            onClick={() => setActiveTab('memory')}
          >
            🧠 工作记忆检索 (Memory)
          </button>
          <button
            type="button"
            className={`vectr-tab-btn ${activeTab === 'ops' ? 'active' : ''}`}
            onClick={() => setActiveTab('ops')}
          >
            ⚙️ 维护与初始化 (Init)
          </button>
        </div>

        {/* Tab Content */}
        <div style={{ padding: '18px 20px', overflowY: 'auto', flex: 1, minHeight: 320 }}>
          {activeTab === 'codebases' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
                  当前工作区已绑定的代码库列表：
                </span>
                <button
                  type="button"
                  className={BTN.primary}
                  onClick={() => setShowAddModal(true)}
                >
                  + 添加 Codebase
                </button>
              </div>

              {codebaseMsg && (
                <div
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: codebaseMsg.ok
                      ? 'var(--dsw-alias-state-success-tertiary)'
                      : 'var(--dsw-alias-interactive-bg-hover-danger)',
                    color: codebaseMsg.ok
                      ? 'var(--dsw-alias-state-success-primary)'
                      : 'var(--dsw-alias-state-error-primary)',
                    fontSize: 12,
                  }}
                >
                  {codebaseMsg.text}
                </div>
              )}

              {!state?.codebases || state.codebases.length === 0 ? (
                <div
                  style={{
                    padding: '30px',
                    textAlign: 'center',
                    color: 'var(--dsw-alias-label-tertiary)',
                    fontSize: 13,
                    border: '1px dashed var(--dsw-alias-border-l2)',
                    borderRadius: 8,
                  }}
                >
                  当前工作区暂未挂载 Codebase，可点击上方“添加 Codebase”进行配置绑定。
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr
                      style={{
                        borderBottom: '1px solid var(--dsw-alias-border-l2)',
                        textAlign: 'left',
                        color: 'var(--dsw-alias-label-secondary)',
                      }}
                    >
                      <th style={{ padding: '8px 10px' }}>Slug</th>
                      <th style={{ padding: '8px 10px' }}>类型</th>
                      <th style={{ padding: '8px 10px' }}>目标路径 / 主机</th>
                      <th style={{ padding: '8px 10px' }}>状态</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.codebases.map((cb) => (
                      <tr
                        key={cb.slug}
                        style={{ borderBottom: '1px solid var(--dsw-alias-border-l2)' }}
                      >
                        <td style={{ padding: '10px', fontWeight: 600 }}>{cb.slug}</td>
                        <td style={{ padding: '10px' }}>
                          {cb.type === 'remote' ? '🌐 Remote' : '📁 Local'}
                        </td>
                        <td style={{ padding: '10px', fontFamily: 'monospace', fontSize: 12 }}>
                          {cb.target}
                        </td>
                        <td style={{ padding: '10px' }}>
                          <span
                            style={{
                              fontWeight: 600,
                              color:
                                cb.status === 'up'
                                  ? 'var(--dsw-alias-state-success-primary)'
                                  : cb.status === 'error'
                                    ? 'var(--dsw-alias-state-error-primary)'
                                    : 'var(--dsw-alias-label-tertiary)',
                            }}
                            title={cb.error || ''}
                          >
                            {cb.status}
                          </span>
                        </td>
                        <td style={{ padding: '10px', textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            {confirmDeleteSlug === cb.slug ? (
                              <>
                                <button
                                  type="button"
                                  className={BTN.danger}
                                  onClick={() => void executeDeleteCodebase(cb.slug)}
                                  disabled={busySlug === cb.slug}
                                >
                                  {busySlug === cb.slug ? '删除中…' : '确认解绑？'}
                                </button>
                                <button
                                  type="button"
                                  className={BTN.secondary}
                                  onClick={() => setConfirmDeleteSlug(null)}
                                  disabled={busySlug === cb.slug}
                                >
                                  取消
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className={BTN.action}
                                  onClick={() => void handleTestCodebase(cb.slug)}
                                  disabled={busySlug === cb.slug}
                                >
                                  测试连通性
                                </button>
                                <button
                                  type="button"
                                  className={BTN.danger}
                                  onClick={() => setConfirmDeleteSlug(cb.slug)}
                                  disabled={busySlug === cb.slug}
                                >
                                  解绑/删除
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {activeTab === 'memory' && (
            <MemoryViewer workspace={workspace} port={state?.port} live={live} />
          )}

          {activeTab === 'ops' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Re-index section */}
              <div
                style={{
                  padding: 16,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 8,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                  🔄 触发重新索引 (Re-index)
                </div>
                <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 }}>
                  向守护进程发送 <code>POST /v1/index</code>，更新代码符号与语义向量切片。
                </div>

                {isMemoryOnly ? (
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: 6,
                      background: 'var(--dsw-alias-brand-tertiary)',
                      color: 'var(--dsw-alias-brand-primary)',
                      fontSize: 12,
                    }}
                  >
                    ℹ️ 当前工作区运行在 <strong>memory_only</strong> 模式，禁止发起索引请求（原生支持仅工作记忆与 hooks，无需代码目录，不建索引）。
                  </div>
                ) : (
                  <div>
                    <button
                      type="button"
                      className={BTN.primary}
                      disabled={!state?.canReindex || reindexing}
                      onClick={() => void handleReindex()}
                    >
                      {reindexing ? '触发中…' : '立即触发 Re-index'}
                    </button>
                    {!state?.canReindex && state?.reindexDisabledReason && (
                      <span
                        style={{
                          fontSize: 12,
                          color: 'var(--dsw-alias-label-tertiary)',
                          marginLeft: 12,
                        }}
                      >
                        ({state.reindexDisabledReason})
                      </span>
                    )}
                  </div>
                )}

                {reindexMsg && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 12px',
                      borderRadius: 6,
                      background: reindexMsg.ok
                        ? 'var(--dsw-alias-state-success-tertiary)'
                        : 'var(--dsw-alias-interactive-bg-hover-danger)',
                      color: reindexMsg.ok
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-state-error-primary)',
                      fontSize: 12,
                    }}
                  >
                    {reindexMsg.text}
                  </div>
                )}
              </div>

              {/* vectr init section */}
              <div
                style={{
                  padding: 16,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 8,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                  🚀 初始化工作区 (vectr init)
                </div>
                <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 }}>
                  为当前工作区生成 IDE 规范文件（CLAUDE.md、.mcp.json、.vectrignore 等）并配置 Hooks。
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={initHooks}
                      onChange={(e) => setInitHooks(e.target.checked)}
                    />
                    写入 Claude Code Hooks (<code>--hooks</code>, 自动注入 SessionStart / UserPrompt 记忆)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={initMemoryOnly}
                      onChange={(e) => setInitMemoryOnly(e.target.checked)}
                    />
                    仅工作记忆模式 (<code>--memory-only</code> / <code>--style memory-only</code>，无代码目录正常工作)
                  </label>
                </div>

                <button
                  type="button"
                  className={BTN.primary}
                  disabled={initBusy}
                  onClick={() => void handleInit()}
                >
                  {initBusy ? '初始化执行中…' : '执行 vectr init'}
                </button>

                {initResult && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '10px 12px',
                      borderRadius: 6,
                      background: initResult.ok
                        ? 'var(--dsw-alias-state-success-tertiary)'
                        : 'var(--dsw-alias-interactive-bg-hover-danger)',
                      color: initResult.ok
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-state-error-primary)',
                      fontSize: 12,
                      fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {initResult.text}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <CodebaseModal
        workspace={workspace}
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSuccess={() => setCodebaseMsg({ ok: true, text: 'Codebase 添加成功' })}
      />
    </div>
  )
}
