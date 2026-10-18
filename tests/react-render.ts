/**
 * Shared headless React renderer for the client specs.
 *
 * This project has no jsdom, no `@testing-library/*` and no root-installed
 * `react-dom` — but `react-dom/server` renders hooks fine without a DOM, so it
 * is loaded from the local dsh monorepo checkout (which already has
 * react-dom@18.3.1, the exact peer of our react@18.3.1). `vitest.config.ts`
 * aliases `react` to that same checkout so the test graph ends up with ONE
 * React instance; two copies is what makes hooks throw "Invalid hook call".
 *
 * Zero new dependencies: nothing is installed, nothing is fetched.
 *
 * NOTE: `renderToStaticMarkup` never runs `useEffect`, so it renders one pass
 * with the initial state. A spec that needs the post-fetch state must render a
 * component that takes that state as props (see `WorkspaceConsoleView` in
 * `src/client/index.tsx`: `WorkspaceConsole` keeps the fetching + hooks, the
 * view is hook-free and therefore renders headlessly).
 *
 * @module tests/react-render
 */

import { createRequire } from 'node:module'
import type { ReactElement } from 'react'

/** react-dom @ 18.3.1 inside the local dsh checkout, resolvable without a root install. */
const REACT_DOM_DIR =
  '/home/csy/Code/installer/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom'

const requireFromReactDom = createRequire(`${REACT_DOM_DIR}/package.json`)

const { renderToStaticMarkup } = requireFromReactDom('./server.js') as {
  renderToStaticMarkup: (element: ReactElement) => string
}

/** Render a React element to static HTML. Hooks (useState/useMemo/…) work; effects do not run. */
export function renderToHtml(element: ReactElement): string {
  return renderToStaticMarkup(element)
}
