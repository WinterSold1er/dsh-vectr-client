/**
 * Application service for session-scoped Vectr status and operations.
 *
 * Implements {@link ISessionStatusService} (Layer 3: Host RPC Bridge).
 * Coordinates domain policies, instance discovery, codebase querying,
 * daemon HTTP calls, and CLI execution.
 *
 * @module dsh-vectr-client/bridge/session-service
 */

import {
  canReindex,
  formatMode,
  validateWorkspace,
  type CodebaseSummary,
  type ICodebaseService,
  type IInstanceResolver,
  type InitResult,
  type ISessionStatusService,
  type IVectrApiClient,
  type IVectrCliRunner,
  type RecallOptions,
  type ResumeResponse,
  type SessionVectrState,
  type TriggerResult,
  type VectrInitOptions,
} from '../domain'
import { DEFAULT_HOST } from '../registry'

export interface SessionServiceOptions {
  instanceResolver: IInstanceResolver
  apiClient: IVectrApiClient
  codebaseService: ICodebaseService
  cliRunner: IVectrCliRunner
  statusTimeoutMs?: number
  recallTimeoutMs?: number
  defaultHost?: string
}

export class SessionVectrService implements ISessionStatusService {
  private readonly instanceResolver: IInstanceResolver
  private readonly apiClient: IVectrApiClient
  private readonly codebaseService: ICodebaseService
  private readonly cliRunner: IVectrCliRunner
  private readonly statusTimeoutMs: number
  private readonly recallTimeoutMs: number
  private readonly defaultHost: string

  constructor(options: SessionServiceOptions) {
    this.instanceResolver = options.instanceResolver
    this.apiClient = options.apiClient
    this.codebaseService = options.codebaseService
    this.cliRunner = options.cliRunner
    this.statusTimeoutMs = options.statusTimeoutMs ?? 5_000
    this.recallTimeoutMs = options.recallTimeoutMs ?? 10_000
    this.defaultHost = options.defaultHost ?? DEFAULT_HOST
  }

  async getSessionStatus(workspace: string): Promise<SessionVectrState> {
    const wsCheck = validateWorkspace(workspace)
    if (!wsCheck.valid) {
      return {
        workspace,
        live: false,
        mode: 'offline',
        codebases: [],
        canReindex: false,
        ...(wsCheck.error ? { error: wsCheck.error, reindexDisabledReason: wsCheck.error } : {}),
      }
    }

    // 1. Query affiliated codebases
    const codebasesRaw = await this.codebaseService.listForWorkspace(workspace)
    const codebases: CodebaseSummary[] = codebasesRaw.map((cb) => ({
      slug: cb.slug,
      type: cb.type,
      target: cb.type === 'remote' ? `${cb.host ?? ''}:${cb.remotePort ?? ''}` : cb.path,
      status: cb.status,
      ...(cb.error ? { error: cb.error } : {}),
      ...(cb.workspace ? { workspace: cb.workspace } : {}),
    }))

    // 2. Discover daemon instance for this workspace
    const instance = await this.instanceResolver.resolveForWorkspace(workspace)
    if (!instance) {
      return {
        workspace,
        live: false,
        mode: 'offline',
        codebases,
        canReindex: false,
        reindexDisabledReason: 'No Vectr daemon registered for this workspace',
        reason: 'no_instance_registered',
      }
    }

    const host = instance.host ?? this.defaultHost

    // 3. Probe daemon status
    const status = await this.apiClient.getStatus(host, instance.port, this.statusTimeoutMs)
    const live = status !== undefined

    // 4. Resolve effective mode (from instance record or status payload)
    const rawMode = typeof instance.mode === 'string'
      ? instance.mode
      : typeof status?.mode === 'string'
        ? status.mode
        : 'full'
    const mode = formatMode(rawMode, live)

    // 5. Evaluate domain rules for re-indexing
    const reindexRule = canReindex(live, mode, status)

    return {
      workspace,
      live,
      mode,
      port: instance.port,
      ...(instance.pid !== undefined ? { pid: instance.pid } : {}),
      host,
      ...(status !== undefined ? { status } : {}),
      codebases,
      canReindex: reindexRule.canReindex,
      ...(reindexRule.reason ? { reindexDisabledReason: reindexRule.reason } : {}),
      ...(!live ? { reason: 'daemon_unresponsive_or_offline' } : {}),
    }
  }

  async triggerIndex(workspace: string): Promise<TriggerResult> {
    const wsCheck = validateWorkspace(workspace)
    if (!wsCheck.valid) {
      return { ok: false, error: wsCheck.error }
    }

    const instance = await this.instanceResolver.resolveForWorkspace(workspace)
    if (!instance) {
      return { ok: false, error: 'No Vectr daemon registered for this workspace' }
    }

    const host = instance.host ?? this.defaultHost
    const status = await this.apiClient.getStatus(host, instance.port, this.statusTimeoutMs)
    const live = status !== undefined
    const rawMode = typeof instance.mode === 'string'
      ? instance.mode
      : typeof status?.mode === 'string'
        ? status.mode
        : 'full'
    const mode = formatMode(rawMode, live)

    const reindexRule = canReindex(live, mode, status)
    if (!reindexRule.canReindex) {
      return { ok: false, error: reindexRule.reason ?? 'Re-index rejected by domain policy' }
    }

    return this.apiClient.triggerIndex(host, instance.port, this.statusTimeoutMs)
  }

  async initWorkspace(options: VectrInitOptions): Promise<InitResult> {
    return this.cliRunner.init(options)
  }

  async recallNotes(
    target: { workspace?: string | undefined; port?: number | undefined },
    options: RecallOptions,
  ): Promise<{ ok: boolean; notes?: string | undefined; error?: string | undefined; processing_ms?: number | undefined }> {
    let port = target.port
    let host = this.defaultHost

    if (port === undefined && target.workspace) {
      const inst = await this.instanceResolver.resolveForWorkspace(target.workspace)
      if (inst) {
        port = inst.port
        if (inst.host) host = inst.host
      }
    }

    if (port === undefined) {
      return { ok: false, error: 'No active Vectr instance found for recall' }
    }

    return this.apiClient.recall(host, port, options, this.recallTimeoutMs)
  }

  async getResume(
    target: { workspace?: string | undefined; port?: number | undefined },
  ): Promise<{ ok: boolean; data?: ResumeResponse | undefined; error?: string | undefined }> {
    let port = target.port
    let host = this.defaultHost

    if (port === undefined && target.workspace) {
      const inst = await this.instanceResolver.resolveForWorkspace(target.workspace)
      if (inst) {
        port = inst.port
        if (inst.host) host = inst.host
      }
    }

    if (port === undefined) {
      return { ok: false, error: 'No active Vectr instance found for resume' }
    }

    return this.apiClient.resume(host, port, this.recallTimeoutMs)
  }
}
