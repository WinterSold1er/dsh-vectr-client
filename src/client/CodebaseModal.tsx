/**
 * Add Codebase dialog with regex validation, credential isolation, and workspace pre-binding.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/CodebaseModal
 */

import { useState, type FormEvent, type ReactNode } from 'react'
import { BTN } from './buttons'

export interface CodebaseModalProps {
  workspace: string
  isOpen: boolean
  onClose: () => void
  onSuccess: (slug: string) => void
}

const SLUG_REGEX = /^[A-Za-z0-9_-]{1,32}$/

export function CodebaseModal({
  workspace,
  isOpen,
  onClose,
  onSuccess,
}: CodebaseModalProps): ReactNode {
  const [type, setType] = useState<'local' | 'remote'>('local')
  const [slug, setSlug] = useState('')
  const [path, setPath] = useState('')
  const [host, setHost] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [remotePort, setRemotePort] = useState('')
  const [authType, setAuthType] = useState<'key' | 'password'>('key')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const isSlugValid = SLUG_REGEX.test(slug)
  const slugError = slug.length > 0 && !isSlugValid ? 'Slug 仅支持 1-32 位字母、数字、下划线及短横线' : null

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!isSlugValid) {
      setError('Slug 格式不符合要求')
      return
    }

    setBusy(true)
    setError(null)

    const payload: Record<string, unknown> = {
      type,
      slug,
      workspace,
    }

    if (type === 'local') {
      if (!path.trim()) {
        setError('本地路径不可为空')
        setBusy(false)
        return
      }
      payload.path = path.trim()
    } else {
      if (!host.trim() || !remotePath.trim()) {
        setError('远程主机与路径不可为空')
        setBusy(false)
        return
      }
      payload.host = host.trim()
      payload.path = remotePath.trim()
      payload.remotePath = remotePath.trim()
      const portNum = remotePort.trim() ? parseInt(remotePort.trim(), 10) : undefined
      if (portNum !== undefined && !isNaN(portNum) && portNum > 0) {
        payload.remotePort = portNum
      }
      payload.auth = authType
      if (authType === 'password') {
        if (!password) {
          setError('选择密码认证时必须输入密码')
          setBusy(false)
          return
        }
        // Credential isolation: password is sent over secure POST, never displayed or logged
        payload.password = password
      }
    }

    try {
      const res = await fetch('/api/vectr/codebases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? `创建失败 (${res.status})`)
      } else {
        onSuccess(slug)
        onClose()
      }
    } catch (err) {
      setError(`网络异常: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vectr-modal-backdrop" onClick={onClose}>
      <div
        className="vectr-modal-card"
        style={{ maxWidth: 540 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 16 }}>添加 Codebase</div>
          <button
            type="button"
            className="vectr-btn"
            style={{ fontSize: 18, color: 'var(--dsw-alias-label-secondary)' }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--dsw-alias-state-error-subtle, rgba(239, 68, 68, 0.1))',
                color: 'var(--dsw-alias-state-error-primary, #ef4444)',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          <div>
            <label className="vectr-label" htmlFor="codebase-slug">
              Slug 标识 <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>*</span>
            </label>
            <input
              id="codebase-slug"
              className="vectr-input"
              style={{ width: '100%' }}
              value={slug}
              onChange={(e) => setSlug(e.target.value.trim())}
              placeholder="e.g. backend-service, auth-api"
              required
            />
            {slugError && (
              <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, marginTop: 4 }}>
                {slugError}
              </div>
            )}
          </div>

          <div>
            <label className="vectr-label">类型</label>
            <div style={{ display: 'flex', gap: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="cb-type"
                  checked={type === 'local'}
                  onChange={() => setType('local')}
                />
                📁 本地代码库 (Local)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="cb-type"
                  checked={type === 'remote'}
                  onChange={() => setType('remote')}
                />
                🌐 远程代码库 (Remote via SSH)
              </label>
            </div>
          </div>

          {type === 'local' ? (
            <div>
              <label className="vectr-label" htmlFor="codebase-path">
                本地目录路径 <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>*</span>
              </label>
              <input
                id="codebase-path"
                className="vectr-input"
                style={{ width: '100%' }}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/local/project"
                required
              />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 2 }}>
                  <label className="vectr-label" htmlFor="cb-host">
                    远程主机 (Host) <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>*</span>
                  </label>
                  <input
                    id="cb-host"
                    className="vectr-input"
                    style={{ width: '100%' }}
                    value={host}
                    onChange={(e) => setHost(e.target.value.trim())}
                    placeholder="user@192.168.1.100"
                    required
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="vectr-label" htmlFor="cb-rport">
                    远程端口 (可选)
                  </label>
                  <input
                    id="cb-rport"
                    type="number"
                    className="vectr-input"
                    style={{ width: '100%' }}
                    value={remotePort}
                    placeholder="留空自动解析"
                    onChange={(e) => setRemotePort(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="vectr-label" htmlFor="cb-rpath">
                  远程工作区路径 <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>*</span>
                </label>
                <input
                  id="cb-rpath"
                  className="vectr-input"
                  style={{ width: '100%' }}
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value.trim())}
                  placeholder="/home/user/project"
                  required
                />
              </div>

              <div>
                <label className="vectr-label">认证凭据隔离</label>
                <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="auth-type"
                      checked={authType === 'key'}
                      onChange={() => setAuthType('key')}
                    />
                    SSH Key (免密 / 默认)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="auth-type"
                      checked={authType === 'password'}
                      onChange={() => setAuthType('password')}
                    />
                    SSH 密码 (安全隔离存储)
                  </label>
                </div>
                {authType === 'password' && (
                  <input
                    type="password"
                    className="vectr-input"
                    style={{ width: '100%' }}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="输入 SSH 密码（不会明文落盘到元数据）"
                    required
                  />
                )}
              </div>
            </div>
          )}

          <div
            style={{
              fontSize: 11,
              color: 'var(--dsw-alias-label-tertiary)',
              paddingTop: 4,
            }}
          >
            挂载归属工作区: <code>{workspace}</code>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 10,
              marginTop: 10,
              paddingTop: 14,
              borderTop: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
            }}
          >
            <button type="button" className={BTN.secondary} onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              type="submit"
              className={BTN.primary}
              disabled={busy || !isSlugValid || (type === 'local' ? !path.trim() : !host.trim() || !remotePath.trim())}
            >
              {busy ? '创建中…' : '创建 Codebase'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
