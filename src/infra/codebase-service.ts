/**
 * Infrastructure codebase service for querying codebase metadata.
 *
 * Implements {@link ICodebaseService} (Layer 2: Infrastructure).
 * Reads codebase definitions from the configured metadata file.
 *
 * @module dsh-vectr-client/infra/codebase-service
 */

import type { ICodebaseService } from '../domain'
import {
  DEFAULT_CODEBASES_FILE,
  loadCodebases,
  type CodebaseEntry,
} from '../codebases'

export class CodebaseService implements ICodebaseService {
  private readonly metaPath: string

  constructor(metaPath: string = DEFAULT_CODEBASES_FILE) {
    this.metaPath = metaPath
  }

  async listForWorkspace(workspace: string): Promise<CodebaseEntry[]> {
    try {
      const all = loadCodebases(this.metaPath)
      return all.filter((entry) => entry.workspace === workspace)
    } catch {
      return []
    }
  }
}
