/**
 * Infrastructure CLI runner for Vectr commands.
 *
 * Implements {@link IVectrCliRunner} (Layer 2: Infrastructure).
 * Resolves CLI executable dynamically from Config -> Environment variables -> PATH.
 * Absolute paths are strictly injected, never hardcoded.
 *
 * @module dsh-vectr-client/infra/cli-runner
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { InitResult, IVectrCliRunner, VectrInitOptions } from '../domain'
import { validateWorkspace } from '../domain/rules'

export type SpawnFunction = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => ChildProcess

export interface CliRunnerOptions {
  /** Explicit CLI path from plugin configuration. */
  cliPath?: string | undefined
  /** Injected spawn function for testing. */
  spawnFn?: SpawnFunction | undefined
  /** Execution timeout in ms (default 30,000ms). */
  timeoutMs?: number | undefined
}

/**
 * Default fallback CLI executable name (resolved via system PATH).
 */
export const DEFAULT_CLI_NAME = 'vectr'

/** Default timeout for CLI commands in milliseconds. */
export const DEFAULT_CLI_TIMEOUT_MS = 30_000

/** Delay before escalating from SIGTERM to SIGKILL on process kill (ms). */
export const SIGKILL_ESCALATION_DELAY_MS = 1_500

/**
 * Resolve the CLI binary path in priority order:
 * 1. Explicit configuration (`opts.cliPath`)
 * 2. Environment variable `VECTR_CLI_PATH`
 * 3. Environment variable `VECTR_PATH`
 * 4. System PATH executable `vectr`
 */
export function resolveCliExecutable(cliPath?: string): string {
  if (cliPath && cliPath.trim().length > 0) {
    return cliPath.trim()
  }
  const envPath = process.env.VECTR_CLI_PATH || process.env.VECTR_PATH
  if (envPath && envPath.trim().length > 0) {
    return envPath.trim()
  }
  return DEFAULT_CLI_NAME
}

export class VectrCliRunner implements IVectrCliRunner {
  private readonly cliExecutable: string
  private readonly spawnFn: SpawnFunction
  private readonly defaultTimeoutMs: number

  constructor(options: CliRunnerOptions = {}) {
    this.cliExecutable = resolveCliExecutable(options.cliPath)
    this.spawnFn = options.spawnFn ?? spawn
    const envTimeout = process.env.VECTR_CLI_TIMEOUT_MS
      ? parseInt(process.env.VECTR_CLI_TIMEOUT_MS, 10)
      : NaN
    this.defaultTimeoutMs = !isNaN(envTimeout) && envTimeout > 0
      ? envTimeout
      : options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
  }

  async init(options: VectrInitOptions): Promise<InitResult> {
    const wsCheck = validateWorkspace(options.workspace)
    if (!wsCheck.valid) {
      return { ok: false, error: wsCheck.error }
    }

    const args: string[] = ['init', '--path', options.workspace]

    if (options.hooks === true) {
      args.push('--hooks')
    }

    if (options.memoryOnly === true) {
      // vectr init uses `--style memory-only` to configure memory-only behavior
      args.push('--style', 'memory-only')
    } else if (options.style && options.style.trim().length > 0) {
      args.push('--style', options.style.trim())
    }

    return new Promise<InitResult>((resolveResult) => {
      let stdout = ''
      let stderr = ''
      let settled = false

      let child: ChildProcess
      try {
        child = this.spawnFn(this.cliExecutable, args)
      } catch (err) {
        resolveResult({
          ok: false,
          error: `Failed to spawn ${this.cliExecutable}: ${String(err)}`,
        })
        return
      }

      let killTimer: ReturnType<typeof setTimeout> | undefined

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try {
            child.kill('SIGTERM')
          } catch {
            // best-effort
          }
          // Zombie prevention: escalate to SIGKILL if child process has not exited after 1500ms
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              try {
                child.kill('SIGKILL')
              } catch {
                // best-effort
              }
            }
          }, SIGKILL_ESCALATION_DELAY_MS)
          killTimer.unref?.()

          resolveResult({
            ok: false,
            stdout,
            stderr,
            error: `Command timed out after ${this.defaultTimeoutMs}ms`,
          })
        }
      }, this.defaultTimeoutMs)

      child.stdout?.on('data', (d: Buffer | string) => {
        stdout += d.toString()
      })

      child.stderr?.on('data', (d: Buffer | string) => {
        stderr += d.toString()
      })

      child.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          resolveResult({
            ok: false,
            stdout,
            stderr: `${stderr}\n${String(err)}`.trim(),
            error: `Execution error: ${String(err)}`,
          })
        }
      })

      child.on('close', (code, signal) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          const success = code === 0 && signal === null
          resolveResult({
            ok: success,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            ...(success
              ? {}
              : {
                  error:
                    stderr.trim() ||
                    `Process exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
                }),
          })
        }
      })
    })
  }
}
