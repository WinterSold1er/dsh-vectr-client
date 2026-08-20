/**
 * Unit tests for the vectr-client plugin's module surface and Config schema
 * defaults/validation.
 */
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config as ConfigSchema, DEFAULT_INSTANCES_FILE, DEFAULT_SERVER_NAME, DEFAULT_TOOL_CALL_TIMEOUT_MS, inject, name } from '../src/index.ts'

/** Resolve a raw config object through the schemastery schema (the Loader path). */
function resolveConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const result = ConfigSchema(raw as never)
  if (typeof result !== 'object' || result === null) throw new Error('Config schema did not return an object')
  return result as Record<string, unknown>
}

describe('vectr-client plugin module exports', () => {
  it('exports name, inject, and Config', () => {
    expect(name).toBe('vectr-client')
    expect(inject).toEqual(['agents'])
    expect(ConfigSchema).toBeDefined()
  })

  it('has no default export (namespace plugin)', async () => {
    const module = await import('../src/index.ts')
    expect('default' in module).toBe(false)
  })
})

describe('Config schema defaults and validation', () => {
  it('materializes every default from an empty config', () => {
    const resolved = resolveConfig({})
    expect(resolved.instancesPath).toBe(join(homedir(), '.vectr', 'instances.json'))
    expect(resolved.instancesPath).toBe(DEFAULT_INSTANCES_FILE)
    expect(resolved.serverName).toBe(DEFAULT_SERVER_NAME)
    expect(resolved.toolCallTimeoutMs).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS)
    expect(resolved.reconnect).toEqual({ enabled: false, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 })
  })

  it('accepts explicit values and merges a partial reconnect block', () => {
    const resolved = resolveConfig({
      instancesPath: '/tmp/custom-instances.json',
      serverName: 'workspace-vectr',
      toolCallTimeoutMs: 30_000,
      reconnect: { initialDelayMs: 100 },
    })
    expect(resolved.instancesPath).toBe('/tmp/custom-instances.json')
    expect(resolved.serverName).toBe('workspace-vectr')
    expect(resolved.toolCallTimeoutMs).toBe(30_000)
    expect(resolved.reconnect).toEqual({ enabled: false, initialDelayMs: 100, maxDelayMs: 30_000, maxAttempts: 10 })
  })

  it('rejects a non-numeric toolCallTimeoutMs', () => {
    expect(() => resolveConfig({ toolCallTimeoutMs: 'soon' })).toThrow()
  })

  it('rejects an invalid reconnect block', () => {
    expect(() => resolveConfig({ reconnect: { maxAttempts: 0 } })).toThrow()
  })
})
