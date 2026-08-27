/**
 * Client bundle build for the dsh-vectr-client plugin.
 *
 * Mirrors the harness's `clientBundle` preset (`packages/client/tsdown.client.ts`)
 * exactly: emits a closure-factory artifact that calls
 * `window.__ModuleLoader__.load({ id, factory })` so the host's client module
 * system can register this plugin's browser half. The plugin's own
 * `tsc`-only build produced an unwrapped ESM `lib/client/index.js`, which made
 * the host throw "bundle loaded without registering 'dsh-vectr-client'".
 *
 * Build: `tsdown --config tsdown.config.ts` (no DSH_BUILD_FACE needed; this
 * config is static). Output: `lib/client.js`.
 */

import type { UserConfig } from 'tsdown'

/** Platform modules the host seeds into the frozen client module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

export default {
  name: 'dsh-vectr-client/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  sourcemap: true,
  dts: false,
  clean: false,
  // Platform modules stay external (resolved via the host module table at
  // runtime); everything else is inlined into the single bundle.
  external: [...PLATFORM_MODULES],
  noExternal: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  banner: 'window.__ModuleLoader__.load({ id: "dsh-vectr-client", factory: (require) => {',
  footer: 'return exports; } });',
  outputOptions: {
    entryFileNames: 'client.js',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig
