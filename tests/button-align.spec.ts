/**
 * 问题2 layout regression: the actions cell must keep `test` + `delete` on one
 * line (flex + nowrap + gap, no marginLeft) and the column must reserve enough
 * width (th minWidth) that a long path column cannot squeeze it into a wrap.
 *
 * The plugin's runtime React comes from the host (react-dom is a peer, not a
 * dev dependency), so this in-suite guard checks the compiled module (the
 * `CodebaseRow` export exists) and the exact source patterns that produce the
 * fix — reverting the flex wrapper or re-adding marginLeft fails the guard. The
 * true pixel/bbox measurement lives in `tests/e2e/button-align.mjs` (run with
 * the system chromium).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CodebaseRow } from '../src/client/codebases.tsx'

const src = readFileSync(new URL('../src/client/codebases.tsx', import.meta.url), 'utf8')

describe('CodebaseRow action cell (问题2)', () => {
  it('CodebaseRow is exported (module compiles + testable)', () => {
    expect(typeof CodebaseRow).toBe('function')
  })

  it('wraps the two buttons in a flex container with nowrap + gap', () => {
    expect(src).toMatch(
      /display:\s*'flex',\s*alignItems:\s*'center',\s*gap:\s*4,\s*whiteSpace:\s*'nowrap'/,
    )
  })

  it('delete button uses no marginLeft (gap handles spacing)', () => {
    // The delete button must not re-introduce marginLeft (the old cause of wrap).
    expect(src).not.toMatch(/BTN\.danger[^>]*marginLeft/)
    expect(src).not.toMatch(/className=\{\s*BTN\.danger\s*\}\s*[^>]*style=\{\{\s*marginLeft/)
  })

  it('action td opts into nowrap so the cell never wraps', () => {
    expect(src).toMatch(/tdStyle,\s*whiteSpace:\s*'nowrap'/)
  })

  it('actions th sets minWidth:110 so long columns cannot crush it', () => {
    expect(src).toMatch(/minWidth:\s*110/)
    expect(src).toMatch(/whiteSpace:\s*'nowrap'/)
  })
})
