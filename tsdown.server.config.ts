/**
 * Server (host) bundle build for the dsh-vectr-client plugin.
 *
 * The harness consumes the package via its `main` (`lib/index.js`), an ESM
 * module that must keep every bare package import external so the running host
 * resolves it at load time. The one exception is the MCP connection helpers:
 * rc.2 exposes them only through the source subpath
 * `@deepseek-ai/dsh-mcp-client/src/connection.ts`, so leaving that specifier
 * external would put raw TypeScript in the artifact — a plain-node host cannot
 * load it (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` from the parameter properties in
 * `src/generation.ts`). Those modules are inlined at build time instead; the
 * bundle is plain JS and pulls no `.ts` specifier at run time.
 *
 * `tsconfig.server-build.json` omits the `paths` mapping tsc uses to type the
 * same subpath against the published declarations; without that override the
 * bundler resolves the import to `lib/types/connection.d.ts` and reports
 * MISSING_EXPORT. tsc (declaration emit) keeps using `tsconfig.json`.
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
  tsconfig: 'tsconfig.server-build.json',
  deps: {
    // Every bare specifier outside the alwaysBundle allow-list stays external,
    // including transitive ones reached through the inlined mcp-client sources
    // (e.g. `@modelcontextprotocol/client`, `zod`).
    neverBundle: true,
    alwaysBundle: [/^@deepseek-ai\/dsh-mcp-client(\/|$)/],
  },
  // tsdown defaults esm output to `.mjs`; the package `main` is `lib/index.js`,
  // so pin the entry filename back to `.js`.
  outputOptions: {
    entryFileNames: 'index.js',
  },
} satisfies UserConfig
