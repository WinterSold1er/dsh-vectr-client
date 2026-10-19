/**
 * 问题2 layout regression: the actions cell must keep `test` + `start` + `delete`
 * on one line (flex + nowrap + gap, no marginLeft) and the column must reserve
 * enough width (th minWidth) that a long path column cannot squeeze it into a wrap.
 *
 * The plugin's runtime React comes from the host (react-dom is a peer, not a
 * dev dependency), so this in-suite guard checks the exact source patterns that
 * produce the fix in the LIVE component (`CodebaseSubRow` in
 * `src/client/index.tsx`) — reverting the flex wrapper or re-adding marginLeft
 * fails the guard. The legacy `CodebaseRow` this file used to guard lived in
 * `src/client/codebases.tsx`, which was deleted as dead code (nothing in `src/`
 * imported it; the client bundle entry is `src/client/index.tsx`).
 *
 * The true pixel/bbox measurement lives in `tests/e2e/button-align.mjs` (run
 * with the system chromium).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The live component rendered by the 阶段2 merged panel is `CodebaseSubRow`.
const clientSrc = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

describe('CodebaseSubRow action cell (问题2, 活组件)', () => {
  it('wraps the actions in a flex container with nowrap + gap', () => {
    expect(clientSrc).toMatch(
      /display:\s*'flex',\s*alignItems:\s*'center',\s*gap:\s*4,\s*whiteSpace:\s*'nowrap'/,
    )
  })

  it('action td opts into nowrap so the cell never wraps', () => {
    expect(clientSrc).toMatch(/tdStyle,\s*whiteSpace:\s*'nowrap'/)
  })

  it('delete button uses no marginLeft (gap handles spacing)', () => {
    expect(clientSrc).not.toMatch(/BTN\.danger[^>]*marginLeft/)
    expect(clientSrc).not.toMatch(/className=\{\s*BTN\.danger\s*\}\s*[^>]*style=\{\{\s*marginLeft/)
  })

  it('actions th reserves width (minWidth:130) so long columns cannot crush it', () => {
    expect(clientSrc).toMatch(/minWidth:\s*130,\s*whiteSpace:\s*'nowrap'/)
  })
})
