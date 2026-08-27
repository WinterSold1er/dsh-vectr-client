/**
 * Server (host) bundle build for the dsh-vectr-client plugin.
 *
 * The harness consumes the package via its `main` (`lib/index.js`), an ESM
 * module that must keep every `@deepseek-ai/*` (and other bare) import external
 * so the running host resolves them at load time. tsdown (esbuild) natively
 * resolves the `.ts` subpath specifiers the rc.2 mcp-client now requires
 * (`@deepseek-ai/dsh-mcp-client/src/connection.ts`) — tsc cannot emit JS while
 * `allowImportingTsExtensions` is on, so declaration emit stays in tsc and the
 * JS emit moves here, mirroring how `tsdown.config.ts` builds the client half.
 *
 * Build: `tsdown --config tsdown.server.config.ts`. Output: `lib/index.js`.
 */

import type { UserConfig } from 'tsdown'

export default {
  name: 'dsh-vectr-client/server',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  dts: false,
  clean: false,
  // Keep every bare (package) import external; bundle only this package's
  // relative sources. Node builtins stay external under platform: 'node'.
  packages: 'external',
  // tsdown defaults esm output to `.mjs`; the package `main` is `lib/index.js`,
  // so pin the entry filename back to `.js`.
  outputOptions: {
    entryFileNames: 'index.js',
  },
} satisfies UserConfig
