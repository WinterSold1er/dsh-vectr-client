/**
 * Working Memory Viewer (Recall & Resume) for Vectr.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/MemoryViewer
 */

import { useState, type ReactNode } from 'react'
import type { ResumeResponse } from '../domain'
import { BTN } from './buttons'

export interface MemoryViewerProps {
  workspace: string
  port?: number | undefined
  live: boolean
}

export function MemoryViewer({ workspace, port, live }: MemoryViewerProps): ReactNode {
  const [subTab, setSubTab] = useState<'recall' | 'resume'>('recall')

  // Recall states
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [detail, setDetail] = useState<'full' | 'index'>('full')
  const [limit, setLimit] = useState(10)
  const [recallBusy, setRecallBusy] = useState(false)
  const [recalledText, setRecalledText] = useState<string | null>(null)
  const [recallError, setRecallError] = useState<string | null>(null)

  // Resume states
  const [resumeBusy, setResumeBusy] = useState(false)
  const [resumeData, setResumeData] = useState<ResumeResponse | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)

  const handleRecall = async (): Promise<void> => {
    if (!live) return
    setRecallBusy(true)
    setRecallError(null)
    try {
      const res = await fetch('/api/vectr/notes/recall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace,
          ...(port ? { port } : {}),
          query: query.trim() || undefined,
          kind: kind !== 'all' ? kind : undefined,
          detail,
          limit,
        }),
      })
      const data = (await res.json()) as { ok: boolean; notes?: string; error?: string }
      if (!res.ok || !data.ok) {
        setRecallError(data.error ?? `检索失败 (${res.status})`)
      } else {
        setRecalledText(data.notes ?? '未找到相关工作记忆')
      }
    } catch (err) {
      setRecallError(`网络异常: ${String(err)}`)
    } finally {
      setRecallBusy(false)
    }
  }

  const handleResume = async (): Promise<void> => {
    if (!live) return
    setResumeBusy(true)
    setResumeError(null)
    try {
      const params = new URLSearchParams()
      if (workspace) params.set('workspace', workspace)
      if (port) params.set('port', String(port))

      const res = await fetch(`/api/vectr/notes/resume?${params.toString()}`)
      const data = (await res.json()) as { ok: boolean; data?: ResumeResponse; error?: string }
      if (!res.ok || !data.ok) {
        setResumeError(data.error ?? `获取接续状态失败 (${res.status})`)
      } else {
        setResumeData(data.data ?? null)
      }
    } catch (err) {
      setResumeError(`网络异常: ${String(err)}`)
    } finally {
      setResumeBusy(false)
    }
  }

  if (!live) {
    return (
      <div
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 13,
        }}
      >
        ⚠️ Vectr 实例当前处于离线状态，启动后即可访问工作记忆（Recall & Resume）。
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Sub tabs */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
          paddingBottom: 2,
        }}
      >
        <button
          type="button"
          className={`vectr-tab-btn ${subTab === 'recall' ? 'active' : ''}`}
          onClick={() => setSubTab('recall')}
        >
          🔍 Note 记忆检索 (Recall)
        </button>
        <button
          type="button"
          className={`vectr-tab-btn ${subTab === 'resume' ? 'active' : ''}`}
          onClick={() => {
            setSubTab('resume')
            if (!resumeData && !resumeBusy) void handleResume()
          }}
        >
          ⏱️ 任务接续 (Resume)
        </button>
      </div>

      {subTab === 'recall' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="vectr-input"
              style={{ flex: 1 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入关键词检索 Note (如: architecture, lock, bug, schema)..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRecall()
              }}
            />
            <select
              className="vectr-select"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="all">类型: 全部</option>
              <option value="directive">directive (指令规范)</option>
              <option value="task">task (当前任务)</option>
              <option value="gotcha">gotcha (易踩坑点)</option>
              <option value="finding">finding (发现记录)</option>
              <option value="decision">decision (架构决策)</option>
            </select>
            <select
              className="vectr-select"
              value={detail}
              onChange={(e) => setDetail(e.target.value as 'full' | 'index')}
            >
              <option value="full">详情: 完整内容</option>
              <option value="index">详情: 单行摘要</option>
            </select>
            <select
              className="vectr-select"
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value, 10))}
            >
              <option value={5}>数量: 5</option>
              <option value={10}>数量: 10</option>
              <option value={20}>数量: 20</option>
            </select>
            <button
              type="button"
              className={BTN.primary}
              onClick={() => void handleRecall()}
              disabled={recallBusy}
            >
              {recallBusy ? '检索中…' : '检索'}
            </button>
          </div>

          {recallError && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--dsw-alias-state-error-subtle, rgba(239, 68, 68, 0.1))',
                color: 'var(--dsw-alias-state-error-primary, #ef4444)',
                fontSize: 12,
              }}
            >
              {recallError}
            </div>
          )}

          {recalledText !== null && (
            <div
              style={{
                maxHeight: '380px',
                overflowY: 'auto',
                background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))',
                border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
                borderRadius: 8,
                padding: '12px 16px',
                fontSize: 13,
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
              }}
            >
              {recalledText}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
              Deterministic 'pick up where you left off' 状态视图 (上一次任务、快照与 Gotchas)
            </span>
            <button
              type="button"
              className={BTN.secondary}
              onClick={() => void handleResume()}
              disabled={resumeBusy}
            >
              {resumeBusy ? '刷新中…' : '刷新 Resume'}
            </button>
          </div>

          {resumeError && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--dsw-alias-state-error-subtle, rgba(239, 68, 68, 0.1))',
                color: 'var(--dsw-alias-state-error-primary, #ef4444)',
                fontSize: 12,
              }}
            >
              {resumeError}
            </div>
          )}

          {resumeData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {resumeData.last_task && (
                <div className="vectr-note-card">
                  <div style={{ fontWeight: 600, color: 'var(--dsw-alias-brand-primary)', marginBottom: 4 }}>
                    📌 最近任务 (Last Task)
                  </div>
                  <div style={{ fontSize: 13 }}>
                    {resumeData.last_task.title || resumeData.last_task.content || JSON.stringify(resumeData.last_task)}
                  </div>
                </div>
              )}

              {resumeData.gotchas && resumeData.gotchas.length > 0 && (
                <div className="vectr-note-card">
                  <div style={{ fontWeight: 600, color: 'var(--dsw-alias-state-warning-primary, #f59e0b)', marginBottom: 4 }}>
                    ⚠️ 关联避坑项 (Gotchas: {resumeData.gotchas.length})
                  </div>
                  {resumeData.gotchas.map((g, idx) => (
                    <div key={idx} style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid #f59e0b' }}>
                      {g.file_path && <code style={{ fontSize: 11 }}>[{g.file_path}] </code>}
                      {g.content || g.title}
                    </div>
                  ))}
                </div>
              )}

              <div
                style={{
                  maxHeight: '300px',
                  overflowY: 'auto',
                  background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))',
                  border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
                  borderRadius: 8,
                  padding: '12px 16px',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {resumeData.formatted}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
