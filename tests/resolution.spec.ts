/**
 * Unit tests for vectr daemon-port resolution from a temp `instances.json`:
 * exact sha256[:12] key match, prefix match, trailing-slash tolerance, and the
 * missing-entry skip (never a throw).
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readInstancesFile, resolveInstance, type InstancesFile, type InstanceEntry } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** sha256(abs path)[:12], the exact registry key vectr writes. */
function keyOf(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

function entry(workspace: string, port: number): InstanceEntry {
  return { workspace, port, pid: 1, started_at: 0, mode: 'full', host: '127.0.0.1' }
}

describe('resolveInstance', () => {
  const workspaces = {
    alpha: '/home/u/work/alpha',
    beta: '/home/u/work/beta',
  }
  const instances: InstancesFile = {
    [keyOf(workspaces.alpha)]: entry(workspaces.alpha, 8765),
    [keyOf(workspaces.beta)]: entry(workspaces.beta, 8766),
  }

  it('resolves by exact sha256[:12] workspace key', () => {
    expect(resolveInstance(instances, workspaces.alpha)?.port).toBe(8765)
    expect(resolveInstance(instances, workspaces.beta)?.port).toBe(8766)
  })

  it('resolves a nested cwd inside a listed workspace directory (prefix match)', () => {
    const nested = join(workspaces.alpha, 'packages', 'core')
    expect(resolveInstance(instances, nested)?.port).toBe(8765)
  })

  it('does not prefix-match a sibling directory sharing a name prefix', () => {
    const sibling = '/home/u/work/alphax'
    expect(resolveInstance(instances, sibling)).toBeUndefined()
  })

  it('falls back to a trailing-slash-tolerant workspace string match', () => {
    const trailing: InstancesFile = {
      [keyOf(workspaces.alpha)]: entry(`${workspaces.alpha}/`, 8765),
    }
    expect(resolveInstance(trailing, workspaces.alpha)?.port).toBe(8765)
    const cwdTrailing = join(workspaces.alpha, '/')
    expect(resolveInstance(trailing, cwdTrailing)?.port).toBe(8765)
  })

  it('returns undefined when no entry matches (the skip path)', () => {
    expect(resolveInstance(instances, '/home/u/work/elsewhere')).toBeUndefined()
    expect(resolveInstance({}, workspaces.alpha)).toBeUndefined()
  })
})

describe('readInstancesFile', () => {
  it('parses a temp instances.json and returns its records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vectr-client-'))
    roots.push(root)
    const file = join(root, 'instances.json')
    await writeFile(file, JSON.stringify({ [keyOf('/tmp/w')]: entry('/tmp/w', 8899) }))
    const ctx = new Context()
    const parsed = readInstancesFile(ctx, file)
    expect(parsed?.[keyOf('/tmp/w')]?.port).toBe(8899)
  })

  it('returns undefined for a missing file without throwing (skip path)', () => {
    const ctx = new Context()
    expect(readInstancesFile(ctx, join(tmpdir(), 'dsh-vectr-client-missing', 'instances.json'))).toBeUndefined()
  })

  it('throws loud on an unparseable registry file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vectr-client-'))
    roots.push(root)
    const file = join(root, 'instances.json')
    await writeFile(file, '{not json')
    const ctx = new Context()
    expect(() => readInstancesFile(ctx, file)).toThrow(/failed to parse/)
  })
})
