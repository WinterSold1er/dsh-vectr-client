/**
 * Build-artifact guards for the plain-node host.
 *
 * The rc.2 host imports `lib/index.js` with Node's native ESM loader and no
 * TypeScript transform, so any surviving `.ts` specifier (or a DSH source
 * subpath) makes the whole plugin fail to load. These assertions read the
 * emitted bundle, not the sources, because the bug this guards against was
 * invisible in the source tree: `src/index.ts` legitimately imports the rc.2
 * MCP helper subpath, and the build used to leave that specifier external.
 *
 * The artifact is committed (`files` includes `lib`), so a stale bundle failing
 * here is a real regression signal rather than a missing-build artifact.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Bundled entry points that the host or the Web client loads at run time. */
const ARTIFACTS = ['lib/index.js', 'lib/client.js']

/** Root bare package name of an import specifier (`@scope/name/sub` -> `@scope/name`). */
function rootPackage(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier)
}

/**
 * Collect static and dynamic import/export specifiers from an ESM artifact.
 * @param source - artifact text.
 * @returns every module specifier the artifact asks the loader to resolve.
 */
function moduleSpecifiers(source: string): string[] {
  const found = new Set<string>()
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s+['"]([^'"]+)['"]/gu,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.add(match[1])
    }
  }
  return [...found]
}

interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Manifest
}

describe('built artifacts load under plain node', () => {
  it.each(ARTIFACTS)('%s exists', (relative) => {
    expect(existsSync(join(packageRoot, relative)), `${relative} is missing; run npm run build`).toBe(true)
  })

  it.each(ARTIFACTS)('%s imports no TypeScript or DSH source subpath', (relative) => {
    const source = readFileSync(join(packageRoot, relative), 'utf8')
    expect(source).not.toMatch(/@deepseek-ai\/[^'"`\s]*\/src\//u)
    for (const specifier of moduleSpecifiers(source)) {
      expect(specifier, `${relative} still imports ${specifier}`).not.toMatch(/\.tsx?$/u)
      expect(specifier, `${relative} still imports ${specifier}`).not.toContain('/src/')
    }
  })

  it('inlines the rc.2 MCP connection helpers instead of importing them', () => {
    const source = readFileSync(join(packageRoot, 'lib/index.js'), 'utf8')
    for (const specifier of moduleSpecifiers(source)) {
      expect(rootPackage(specifier)).not.toBe('@deepseek-ai/dsh-mcp-client')
    }
    // The inlined supervisor must actually be present, otherwise the absence
    // above would also pass an artifact that silently dropped the connection.
    expect(source).toContain('McpStatusCell')
    expect(source).toContain('McpGeneration')
  })

  it.each(ARTIFACTS)('%s declares every bare import in the manifest', (relative) => {
    const source = readFileSync(join(packageRoot, relative), 'utf8')
    const manifest = readManifest()
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('#')) continue
      const name = rootPackage(specifier)
      expect(declared.has(name), `${relative} imports undeclared package ${name}`).toBe(true)
    }
  })
})
