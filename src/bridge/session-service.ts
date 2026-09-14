/**
 * Application service for session-scoped Vectr status and operations.
 *
 * Implements {@link ISessionStatusService} (Layer 3: Host RPC Bridge).
 * Coordinates domain policies, instance discovery, codebase querying,
 * daemon HTTP calls, and CLI execution.
 *
 * @module dsh-vectr-client/bridge/session-service
 */

import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  canReindex,
  formatMode,
  isSystemPrimarySlug,
  validateWorkspace,
  type CodebaseEntry,
  type CodebaseSummary,
  type ICodebaseService,
  type IInstanceResolver,
  type InitResult,
  type InstanceEntry,
  type ISessionStatusService,
  type IVectrApiClient,
  type IVectrCliRunner,
  type RecallOptions,
  type ResumeResponse,
  type SessionVectrState,
  type TriggerResult,
  type UpgradeResult,
  type VectrInitOptions,
  type VectrMode,
  type VectrStatus,
} from '../domain'
import { DEFAULT_HOST } from '../registry'

export interface SessionServiceOptions {
  instanceResolver: IInstanceResolver
  apiClient: IVectrApiClient
  codebaseService: ICodebaseService
  cliRunner: IVectrCliRunner
  statusTimeoutMs?: number
  recallTimeoutMs?: number
  upgradeTimeoutMs?: number
  defaultHost?: string
}

export class SessionVectrService implements ISessionStatusService {
  private readonly instanceResolver: IInstanceResolver
  private readonly apiClient: IVectrApiClient
  private readonly codebaseService: ICodebaseService
  private readonly cliRunner: IVectrCliRunner
  private readonly statusTimeoutMs: number
  private readonly recallTimeoutMs: number
  private readonly upgradeTimeoutMs: number
  private readonly defaultHost: string
  private readonly inFlightUpgrades = new Map<string, Promise<UpgradeResult>>()

  constructor(options: SessionServiceOptions) {
    this.instanceResolver = options.instanceResolver
    this.apiClient = options.apiClient
    this.codebaseService = options.codebaseService
    this.cliRunner = options.cliRunner
    this.statusTimeoutMs = options.statusTimeoutMs ?? 5_000
    this.recallTimeoutMs = options.recallTimeoutMs ?? 10_000
    const envTimeout = process.env.VECTR_UPGRADE_TIMEOUT_MS
      ? parseInt(process.env.VECTR_UPGRADE_TIMEOUT_MS.trim(), 10)
      : undefined
    const parsedEnvTimeout =
      typeof envTimeout === 'number' && !isNaN(envTimeout) && envTimeout > 0 ? envTimeout : undefined
    this.upgradeTimeoutMs =
      parsedEnvTimeout ??
      (typeof options.upgradeTimeoutMs === 'number' && options.upgradeTimeoutMs > 0
        ? options.upgradeTimeoutMs
        : undefined) ??
      15_000
    this.defaultHost = options.defaultHost ?? DEFAULT_HOST
  }

  private buildCodebases(
    workspace: string,
    codebasesRaw: CodebaseEntry[],
    mode: VectrMode,
    live: boolean,
  ): CodebaseSummary[] {
    const codebases: CodebaseSummary[] = []
    if (codebasesRaw.length > 0 && mode !== 'memory_only') {
      codebases.push({
        slug: 'primary',
        type: 'local',
        target: workspace,
        status: live ? 'up' : 'down',
        workspace,
        isPrimary: true,
        deletable: false,
      })
    }
    for (const cb of codebasesRaw) {
      const isPrimarySlug = typeof cb.slug === 'string' && isSystemPrimarySlug(cb.slug)
      const isSamePath = cb.type === 'local' && cb.path && resolve(cb.path) === resolve(workspace)
      if (isPrimarySlug || isSamePath) continue
      codebases.push({
        slug: cb.slug,
        type: cb.type,
        target: cb.type === 'remote' ? `${cb.host ?? ''}:${cb.remotePort ?? ''}` : cb.path,
        status: cb.status,
        isPrimary: false,
        deletable: true,
        ...(cb.error ? { error: cb.error } : {}),
        ...(cb.workspace ? { workspace: cb.workspace } : {}),
      })
    }
    return codebases
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

    // 2. Discover daemon instance for this workspace
    const instance = await this.instanceResolver.resolveForWorkspace(workspace)
    if (!instance) {
      const offlineCodebases = this.buildCodebases(workspace, codebasesRaw, 'offline', false)
      return {
        workspace,
        live: false,
        mode: 'offline',
        codebases: offlineCodebases,
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

    // 6. Build codebase list: non-memory_only workspaces display their own codebase as Primary at index 0 when external codebases are mounted
    const codebases = this.buildCodebases(workspace, codebasesRaw, mode, live)

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

  async upgradeWorkspace(workspace: string): Promise<UpgradeResult> {
    const wsCheck = validateWorkspace(workspace)
    if (!wsCheck.valid) {
      return { ok: false, error: wsCheck.error }
    }

    const normWs = resolve(workspace)
    const inFlight = this.inFlightUpgrades.get(normWs)
    if (inFlight) {
      return inFlight
    }

    const task = this.doUpgradeWorkspace(normWs)
    this.inFlightUpgrades.set(normWs, task)
    try {
      return await task
    } finally {
      this.inFlightUpgrades.delete(normWs)
    }
  }

  private async doUpgradeWorkspace(workspace: string): Promise<UpgradeResult> {
    // 1. Run init to update workspace configs (without memory-only)
    const initRes = await this.cliRunner.init({ workspace, hooks: true, memoryOnly: false })
    if (!initRes.ok) {
      return {
        ok: false,
        error: initRes.error ?? 'Failed to initialize workspace for upgrade',
        stdout: initRes.stdout,
        stderr: initRes.stderr,
      }
    }

    // 2. Execute CLI restart --full
    const restartResult = await this.cliRunner.restart(workspace, { full: true })
    if (!restartResult.ok) {
      return {
        ok: false,
        error: restartResult.error ?? 'Failed to restart Vectr in full mode',
        stdout: restartResult.stdout,
        stderr: restartResult.stderr,
      }
    }

    // 3. Probe until live and ready in full mode ("探活就绪")
    const probeDeadline = Date.now() + this.upgradeTimeoutMs
    let readyInstance: InstanceEntry | undefined
    let readyStatus: VectrStatus | undefined

    while (Date.now() < probeDeadline) {
      const inst = await this.instanceResolver.resolveForWorkspace(workspace)
      if (inst && inst.port) {
        const host = inst.host ?? this.defaultHost
        const st = await this.apiClient.getStatus(host, inst.port, 1_000)
        if (st !== undefined) {
          const rawStMode = typeof st.mode === 'string' ? st.mode : undefined
          const effectiveMode = formatMode(inst.mode ?? rawStMode, true)
          if (effectiveMode !== 'memory_only') {
            readyInstance = inst
            readyStatus = st
            break
          }
        }
      }
      await sleep(200)
    }

    // 探活超时假阳性防线: 若未探活到 readyInstance 或依然是 memory_only，严禁返回 ok: true
    if (!readyInstance) {
      const finalInst = await this.instanceResolver.resolveForWorkspace(workspace)
      let finalStatus: VectrStatus | undefined
      if (finalInst && finalInst.port) {
        finalStatus = await this.apiClient.getStatus(finalInst.host ?? this.defaultHost, finalInst.port, 1_000)
      }
      const rawMode = typeof finalInst?.mode === 'string'
        ? finalInst.mode
        : typeof finalStatus?.mode === 'string'
          ? finalStatus.mode
          : undefined
      const finalMode = formatMode(rawMode, finalStatus !== undefined)
      const isStuckMem = finalMode === 'memory_only' || rawMode === 'memory_only' || rawMode === 'memory-only'
      const errorMsg = isStuckMem
        ? `Vectr daemon is still in memory_only mode after upgrade restart (timeout: ${this.upgradeTimeoutMs}ms)`
        : `Timed out waiting for Vectr instance to become ready in full mode (timeout: ${this.upgradeTimeoutMs}ms)`
      return {
        ok: false,
        error: errorMsg,
        mode: finalMode,
        port: finalInst?.port,
        stdout: restartResult.stdout,
        stderr: restartResult.stderr,
      }
    }

    const rawFinalMode =
      typeof readyInstance.mode === 'string'
        ? readyInstance.mode
        : typeof readyStatus?.mode === 'string'
          ? readyStatus.mode
          : 'full'
    const finalMode = formatMode(rawFinalMode, true)

    if (finalMode === 'memory_only') {
      return {
        ok: false,
        error: 'Vectr daemon is still in memory_only mode after upgrade restart',
        mode: finalMode,
        port: readyInstance.port,
        stdout: restartResult.stdout,
        stderr: restartResult.stderr,
      }
    }

    return {
      ok: true,
      mode: finalMode,
      port: readyInstance.port,
      stdout: restartResult.stdout,
      stderr: restartResult.stderr,
    }
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
