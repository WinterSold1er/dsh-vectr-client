/**
 * Infrastructure instance resolver for discovering running Vectr daemons.
 *
 * Implements {@link IInstanceResolver} (Layer 2: Infrastructure).
 * Reads `~/.vectr/instances.json` dynamically with no caching so external starts/restarts
 * are detected immediately.
 *
 * @module dsh-vectr-client/infra/instance-resolver
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IInstanceResolver } from '../domain'
import {
  DEFAULT_INSTANCES_FILE,
  readInstancesFile,
  resolveInstance,
  type InstanceEntry,
  type LoggerCtx,
} from '../registry'

const NOOP_LOGGER: LoggerCtx = {
  logger: {
    info: () => {},
    warn: () => {},
  },
}

export class InstanceResolver implements IInstanceResolver {
  private readonly ctx: LoggerCtx
  private readonly instancesPath: string

  constructor(instancesPath: string = DEFAULT_INSTANCES_FILE, ctx?: Context) {
    this.instancesPath = instancesPath
    this.ctx = ctx ?? NOOP_LOGGER
  }

  async resolveForWorkspace(workspace: string): Promise<InstanceEntry | undefined> {
    try {
      const instances = readInstancesFile(this.ctx, this.instancesPath)
      if (!instances) return undefined
      return resolveInstance(instances, workspace)
    } catch {
      return undefined
    }
  }

  async getAll(): Promise<Record<string, InstanceEntry>> {
    try {
      const instances = readInstancesFile(this.ctx, this.instancesPath)
      return instances ?? {}
    } catch {
      return {}
    }
  }
}
