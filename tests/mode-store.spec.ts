/**
 * L2 — the plugin's own memory of which vectr STARTUP MODE each workspace was
 * put into (`src/modes.ts`).
 *
 * Why this file exists: the daemon registry (`~/.vectr/instances.json`) holds the
 * mode only as RUNTIME state, and both `vectr start` and `vectr status` prune dead
 * records globally. So after a harness restart (KillMode=control-group kills every
 * daemon) the mode is simply gone from every consumer's view, and a plugin that
 * re-issues `vectr start` with no flag gets vectr's default — `full` — and re-indexes
 * a workspace the user had deliberately downgraded (the 146k-file incident).
 *
 * These tests pin the store's contract: it is advisory (a broken/absent file means
 * "nothing remembered", never a crash), it is normalized so any start path can find
 * its key, it can only be written with modes this plugin knows how to request, and
 * harvesting the registry may NEVER downgrade an already-remembered mode.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODES_FILE,
  harvestFromInstances,
  isPersistedMode,
  lookupMode,
  modeStartFlags,
  readModes,
  resolveStartMode,
  toPersistedMode,
  writeMode,
} from '../src/modes.ts'
import type { InstancesFile } from '../src/domain/types.ts'

let dir = ''
let modesPath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vt-modes-'))
  modesPath = join(dir, 'vectr-modes.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('mode store — read', () => {
  it('treats a missing file as "nothing remembered" and does not create one', () => {
    expect(readModes(modesPath)).toEqual({})
    expect(existsSync(modesPath)).toBe(false)
    expect(lookupMode(modesPath, '/home/csy/Work/demo')).toBeUndefined()
  })

  it('survives a corrupted file: invalid JSON yields {} instead of throwing', () => {
    writeFileSync(modesPath, '{" /home/ws": "full"') // truncated JSON
    expect(() => readModes(modesPath)).not.toThrow()
    expect(readModes(modesPath)).toEqual({})
  })

  it('survives an empty or non-JSON file', () => {
    writeFileSync(modesPath, '')
    expect(readModes(modesPath)).toEqual({})
    writeFileSync(modesPath, 'not json at all')
    expect(readModes(modesPath)).toEqual({})
  })

  it('rejects a JSON value that is not a plain object (array / string / null)', () => {
    for (const payload of ['["/home/ws"]', '"/home/ws"', 'null', '42', 'true']) {
      writeFileSync(modesPath, payload)
      expect(readModes(modesPath)).toEqual({})
    }
  })

  it('drops values that are not modes this plugin can request, keeping the rest', () => {
    writeFileSync(
      modesPath,
      JSON.stringify({
        '/home/csy/Work/a': 'memory_only',
        '/home/csy/Work/b': 'search_only',
        '/home/csy/Work/c': 'full',
        '/home/csy/Work/lite': 'lite',
        '/home/csy/Work/unknown': 'banana',
        '/home/csy/Work/number': 7,
        '/home/csy/Work/null': null,
        '': 'full',
      }),
    )
    const modes = readModes(modesPath)
    expect(Object.keys(modes).sort()).toEqual([
      '/home/csy/Work/a',
      '/home/csy/Work/b',
      '/home/csy/Work/c',
    ])
    expect(modes['/home/csy/Work/lite']).toBeUndefined()
  })

  it('normalizes keys on read, so sloppy on-disk keys are still found', () => {
    writeFileSync(
      modesPath,
      JSON.stringify({ '/home/csy/Work/demo/': 'memory_only', '//home//csy//Work//other': 'full' }),
    )
    expect(lookupMode(modesPath, '/home/csy/Work/demo')).toBe('memory_only')
    expect(lookupMode(modesPath, '/home/csy/Work/other')).toBe('full')
    // An empty/blank workspace never matches anything.
    expect(lookupMode(modesPath, '   ')).toBeUndefined()
    expect(lookupMode(modesPath, undefined)).toBeUndefined()
  })
})

describe('mode store — write', () => {
  it('writes an atomically-replaced 0600 file and creates missing parent directories', () => {
    const nested = join(dir, 'nested', 'deeper', 'vectr-modes.json')
    expect(existsSync(join(dir, 'nested'))).toBe(false)

    expect(writeMode(nested, '/home/csy/Work/demo', 'memory_only')).toBe(true)

    const modeBits = statSync(nested).mode & 0o777
    expect(modeBits).toBe(0o600)
    expect(JSON.parse(readFileSync(nested, 'utf-8'))).toEqual({ '/home/csy/Work/demo': 'memory_only' })
    // tmp + rename: no partial/temp file may be left behind.
    expect(existsSync(`${nested}.${process.pid}.tmp`)).toBe(false)
  })

  it('accumulates workspaces instead of clobbering the map', () => {
    expect(writeMode(modesPath, '/home/csy/Work/a', 'memory_only')).toBe(true)
    expect(writeMode(modesPath, '/home/csy/Work/b', 'search_only')).toBe(true)
    expect(readModes(modesPath)).toEqual({
      '/home/csy/Work/a': 'memory_only',
      '/home/csy/Work/b': 'search_only',
    })
  })

  it('normalizes the key on write so any later lookup path hits it', () => {
    writeMode(modesPath, '/home/csy/Work/demo/', 'memory_only')
    expect(lookupMode(modesPath, '/home/csy/Work/demo')).toBe('memory_only')
    expect(lookupMode(modesPath, ' /home/csy/Work/demo ')).toBe('memory_only')
  })

  it('refuses a mode it cannot request and refuses a blank workspace: no write, no throw', () => {
    expect(writeMode(modesPath, '/home/csy/Work/a', 'lite' as never)).toBe(false)
    expect(writeMode(modesPath, '   ', 'full')).toBe(false)
    expect(existsSync(modesPath)).toBe(false)
  })

  it('reports an unwritable store as false instead of throwing (advisory persistence)', () => {
    // A directory cannot be replaced by a file: rename fails.
    const blocked = join(dir, 'blocked')
    mkdirSync(blocked)
    expect(writeMode(blocked, '/home/csy/Work/a', 'full')).toBe(false)
    expect(lookupMode(blocked, '/home/csy/Work/a')).toBeUndefined()
  })

  it('records the real default path shape (~/.dsh/vectr-modes.json)', () => {
    expect(DEFAULT_MODES_FILE.endsWith(join('.dsh', 'vectr-modes.json'))).toBe(true)
  })
})

describe('mode store — registry harvest', () => {
  const registry: InstancesFile = {
    aaaa: { workspace: '/home/csy/Work/a', port: 8765, mode: 'memory_only' },
    bbbb: { workspace: '/home/csy/Work/b/', port: 8766, mode: 'search-only' },
    cccc: { workspace: '/home/csy/Work/c', port: 8767, mode: 'full' },
    dddd: { workspace: '/home/csy/Work/d', port: 8768 },
    eeee: { workspace: '/home/csy/Work/e', port: 8769, mode: 'lite' },
    ffff: { workspace: 42 as unknown as string, port: 8770, mode: 'full' },
  }

  it('copies every known mode into the store and reports exactly which keys it added', () => {
    const harvest = harvestFromInstances(modesPath, registry)
    expect(harvest.added.slice().sort()).toEqual(['/home/csy/Work/a', '/home/csy/Work/b', '/home/csy/Work/c'])
    expect(harvest.conflicts).toEqual([])
    expect(harvest.writeFailed).toBe(false)
    expect(readModes(modesPath)).toEqual({
      '/home/csy/Work/a': 'memory_only',
      '/home/csy/Work/b': 'search_only',
      '/home/csy/Work/c': 'full',
    })
  })

  it('is idempotent: a second harvest writes nothing new and leaves the file untouched', () => {
    expect(harvestFromInstances(modesPath, registry).added).toHaveLength(3)
    const before = readFileSync(modesPath, 'utf-8')
    expect(harvestFromInstances(modesPath, registry)).toEqual({ added: [], conflicts: [], writeFailed: false })
    expect(readFileSync(modesPath, 'utf-8')).toBe(before)
  })

  it('NEVER overwrites a remembered mode — and says so: a stale registry `full` cannot downgrade memory_only', () => {
    expect(writeMode(modesPath, '/home/csy/Work/a', 'memory_only')).toBe(true)
    // Same workspace, but the registry now claims `full` (e.g. a half-pruned or
    // re-created record). Harvesting must not resurrect a full re-index.
    expect(
      harvestFromInstances(modesPath, { zzzz: { workspace: '/home/csy/Work/a', port: 8765, mode: 'full' } }),
    ).toEqual({
      added: [],
      conflicts: [{ workspace: '/home/csy/Work/a', stored: 'memory_only', incoming: 'full' }],
      writeFailed: false,
    })
    expect(lookupMode(modesPath, '/home/csy/Work/a')).toBe('memory_only')
    // A harvest with nothing to add leaves the bytes alone — no silent rewrite.
    expect(readFileSync(modesPath, 'utf-8')).toBe(JSON.stringify({ '/home/csy/Work/a': 'memory_only' }, null, 2))
  })

  it('the OTHER direction is visible too: a stale `full` in the store against a memory_only registry is a reported conflict', () => {
    // The counter-example harvest cannot fix on its own: an external/manual
    // `vectr start --memory-only` left the registry saying memory_only while the
    // store is still `full` from an earlier harvest. Overwriting either direction
    // from a record a prune can erase is not the harvest's call to make; making
    // the disagreement visible is.
    expect(writeMode(modesPath, '/home/csy/Work/a', 'full')).toBe(true)
    const harvest = harvestFromInstances(
      modesPath,
      { zzzz: { workspace: '/home/csy/Work/a', port: 8765, mode: 'memory_only' } },
    )
    expect(harvest.conflicts).toEqual([{ workspace: '/home/csy/Work/a', stored: 'full', incoming: 'memory_only' }])
    expect(harvest.added).toEqual([])
    expect(harvest.writeFailed).toBe(false)
    expect(lookupMode(modesPath, '/home/csy/Work/a')).toBe('full')
  })

  it('a store that could not be written reports writeFailed — never "nothing was harvested"', () => {
    // A directory cannot be replaced by a file: the atomic rename fails.
    const blocked = join(dir, 'blocked-harvest')
    mkdirSync(blocked)
    const harvest = harvestFromInstances(blocked, registry)
    expect(harvest.writeFailed).toBe(true)
    expect(harvest.added.slice().sort()).toEqual(['/home/csy/Work/a', '/home/csy/Work/b', '/home/csy/Work/c'])
    // Nothing reached disk, and the path itself is untouched.
    expect(readModes(blocked)).toEqual({})
    expect(statSync(blocked).isDirectory()).toBe(true)
  })

  it('tolerates a missing/undefined registry and non-object entries', () => {
    expect(harvestFromInstances(modesPath, undefined)).toEqual({ added: [], conflicts: [], writeFailed: false })
    expect(harvestFromInstances(modesPath, {})).toEqual({ added: [], conflicts: [], writeFailed: false })
    expect(
      harvestFromInstances(modesPath, {
        x: null as unknown as InstancesFile[string],
        y: 'nope' as unknown as InstancesFile[string],
        ok: { workspace: '/home/csy/Work/ok', port: 1, mode: 'memory_only' },
      }).added,
    ).toEqual(['/home/csy/Work/ok'])
    expect(lookupMode(modesPath, '/home/csy/Work/ok')).toBe('memory_only')
  })
})

describe('mode → `vectr start` flags', () => {
  it('maps memory_only and search_only to their flags', () => {
    expect(modeStartFlags('memory_only')).toEqual(['--memory-only'])
    expect(modeStartFlags('search_only')).toEqual(['--search-only'])
  })

  it('emits NO flag for `full` or for an unrecorded workspace (behaviour parity)', () => {
    expect(modeStartFlags('full')).toEqual([])
    expect(modeStartFlags(undefined)).toEqual([])
  })

  it('normalizes every registry spelling of a mode into a persistable one', () => {
    expect(toPersistedMode('memory-only')).toBe('memory_only')
    expect(toPersistedMode('MEMORY_ONLY')).toBe('memory_only')
    expect(toPersistedMode('search-only')).toBe('search_only')
    expect(toPersistedMode('full')).toBe('full')
    expect(toPersistedMode('lite')).toBeUndefined()
    expect(toPersistedMode(undefined)).toBeUndefined()
    expect(toPersistedMode(9)).toBeUndefined()
    expect(isPersistedMode('memory_only')).toBe(true)
    expect(isPersistedMode('memory-only')).toBe(false)
  })
})

describe('mode precedence for a start', () => {
  it('an explicit request-body choice wins over both registry and store', () => {
    expect(
      resolveStartMode({
        forcedMemoryOnly: true,
        registryMode: 'full',
        storedMode: 'search_only',
      }),
    ).toBe('memory_only')
    // `memoryOnly: false` is an explicit "give me the full index" too.
    expect(
      resolveStartMode({ forcedMemoryOnly: false, registryMode: 'memory_only', storedMode: 'memory_only' }),
    ).toBe('full')
  })

  it('registry beats the store when the request says nothing', () => {
    expect(resolveStartMode({ registryMode: 'memory_only', storedMode: 'full' })).toBe('memory_only')
    expect(resolveStartMode({ registryMode: 'full', storedMode: 'memory_only' })).toBe('full')
  })

  it('a registry mode this plugin cannot request falls through to the store', () => {
    expect(resolveStartMode({ registryMode: 'lite', storedMode: 'memory_only' })).toBe('memory_only')
    expect(resolveStartMode({ registryMode: 'whatever', storedMode: 'search_only' })).toBe('search_only')
  })

  it('nothing remembered anywhere → `full`, i.e. no flag at all', () => {
    expect(resolveStartMode({})).toBe('full')
    expect(modeStartFlags(resolveStartMode({}))).toEqual([])
  })
})
