/**
 * Infrastructure HTTP API client for Vectr daemon.
 *
 * Implements {@link IVectrApiClient} (Layer 2: Infrastructure).
 * Handles HTTP requests to `/v1/status`, `/v1/index`, `/v1/recall`, `/v1/resume`
 * with AbortController timeouts and structured error handling.
 *
 * @module dsh-vectr-client/infra/api-client
 */

import { setTimeout as sleep } from 'node:timers/promises'
import type {
  IVectrApiClient,
  RecallOptions,
  ResumeResponse,
  TriggerResult,
  VectrStatus,
} from '../domain'
import { fetchStatus } from '../probe'

export interface ApiClientOptions {
  /** Injected fetch implementation for unit testing. */
  fetchFn?: typeof fetch | undefined
}

export class VectrApiClient implements IVectrApiClient {
  private readonly customFetch: typeof fetch | undefined

  constructor(options: ApiClientOptions = {}) {
    this.customFetch = options.fetchFn
  }

  private get doFetch(): typeof fetch {
    return this.customFetch ?? fetch
  }

  async getStatus(host: string, port: number, timeoutMs: number): Promise<VectrStatus | undefined> {
    if (this.customFetch) {
      // If custom fetch injected, use it directly
      const controller = new AbortController()
      const timer = sleep(timeoutMs).then(() => controller.abort())
      try {
        const res = await this.doFetch(`http://${host}:${port}/v1/status`, {
          signal: controller.signal,
        })
        if (!res.ok) return undefined
        return (await res.json()) as VectrStatus
      } catch {
        return undefined
      } finally {
        void timer.catch(() => {})
      }
    }
    // Re-use verified probe implementation from probe.ts
    return fetchStatus({ workspace: '', port, host }, timeoutMs)
  }

  async triggerIndex(host: string, port: number, timeoutMs: number): Promise<TriggerResult> {
    const controller = new AbortController()
    const timer = sleep(timeoutMs).then(() => controller.abort())
    try {
      const res = await this.doFetch(`http://${host}:${port}/v1/index`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: false }),
        signal: controller.signal,
      })
      if (res.ok) return { ok: true, status: res.status }
      const text = await res.text().catch(() => '')
      if (res.status === 503) {
        return { ok: false, error: text.trim() || 'reindex already in progress (503)', status: 503 }
      }
      return {
        ok: false,
        error: `index request rejected: ${res.status}${text ? ` ${text}` : ''}`,
        status: res.status,
      }
    } catch (error) {
      return { ok: false, error: `index request failed: ${String(error)}` }
    } finally {
      void timer.catch(() => {})
    }
  }

  async recall(
    host: string,
    port: number,
    options: RecallOptions,
    timeoutMs: number,
  ): Promise<{ ok: boolean; notes?: string; error?: string; processing_ms?: number }> {
    const controller = new AbortController()
    const timer = sleep(timeoutMs).then(() => controller.abort())
    try {
      const payload: Record<string, unknown> = {
        limit: options.limit ?? 10,
        detail: options.detail ?? 'full',
      }
      if (options.query !== undefined && options.query.trim().length > 0) {
        payload.query = options.query.trim()
      }
      if (options.kind !== undefined && options.kind !== 'all') {
        payload.kind = options.kind
      }
      if (options.priority !== undefined) {
        payload.priority = options.priority
      }
      if (options.tags !== undefined && options.tags.length > 0) {
        payload.tags = options.tags
      }
      if (options.sort_by !== undefined) {
        payload.sort_by = options.sort_by
      }

      const res = await this.doFetch(`http://${host}:${port}/v1/recall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return {
          ok: false,
          error: `recall failed with HTTP ${res.status}: ${text}`,
        }
      }

      const data = (await res.json()) as { notes?: string; processing_ms?: number }
      return {
        ok: true,
        notes: data.notes ?? '',
        ...(data.processing_ms !== undefined ? { processing_ms: data.processing_ms } : {}),
      }
    } catch (error) {
      return { ok: false, error: `recall request failed: ${String(error)}` }
    } finally {
      void timer.catch(() => {})
    }
  }

  async resume(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<{ ok: boolean; data?: ResumeResponse; error?: string }> {
    const controller = new AbortController()
    const timer = sleep(timeoutMs).then(() => controller.abort())
    try {
      const res = await this.doFetch(`http://${host}:${port}/v1/resume`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return {
          ok: false,
          error: `resume failed with HTTP ${res.status}: ${text}`,
        }
      }

      const data = (await res.json()) as ResumeResponse
      return {
        ok: true,
        data,
      }
    } catch (error) {
      return { ok: false, error: `resume request failed: ${String(error)}` }
    } finally {
      void timer.catch(() => {})
    }
  }
}
