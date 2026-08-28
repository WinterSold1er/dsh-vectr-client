/**
 * Boundary coverage for `slugFromPathname` (改动3 root-cause fix).
 *
 * The integration route test in `codebase-route.spec.ts` only covers the
 * "happy" prefixed cases (`/x/test`, `/x`, `/x/y/z`). This spec locks the
 * *edge* behavior so a regression (e.g. dropping `decodeURIComponent` or the
 * `?? ''` coalesce) cannot slip through green: empty pathname, root-only,
 * non-prefixed, prefix-without-trailing-slash, and `%2F` (encoded slash)
 * inputs — all of which the real prefix handler will see and must resolve to a
 * deterministic slug (or `''`, which the route maps to a 400).
 */
import { describe, expect, it } from 'vitest'
import { slugFromPathname } from '../src/index.ts'

describe('slugFromPathname boundary', () => {
  it('empty pathname -> empty slug (no index access crash)', () => {
    expect(slugFromPathname('')).toBe('')
  })

  it('root-only slash -> empty slug', () => {
    expect(slugFromPathname('/')).toBe('')
  })

  it('non-prefixed path -> empty slug (never a false slug match)', () => {
    expect(slugFromPathname('/foo/bar')).toBe('')
  })

  it('prefix with no trailing slash -> empty slug', () => {
    // `replace` only strips the prefix when the trailing slash is present, so a
    // bare `/api/vectr/codebases` (no slash) is NOT a valid slug carrier.
    expect(slugFromPathname('/api/vectr/codebases')).toBe('')
  })

  it('strips /test AND any deeper action segments', () => {
    expect(slugFromPathname('/api/vectr/codebases/demo/test/extra')).toBe('demo')
  })

  it('decodes %2F then splits on it (encoded slash does not escape the slug)', () => {
    // `a%2Fb` decodes to `a/b`; the first segment after split is `a`. This
    // locks the current (intended) behavior: a slug can never smuggle a `/`.
    expect(slugFromPathname('/api/vectr/codebases/a%2Fb')).toBe('a')
  })
})
