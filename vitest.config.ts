import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Single React instance for the test graph: react-dom/server lives in the
      // local dsh monorepo checkout and peer-resolves react from there. Without
      // this dedupe, hooks throw "Invalid hook call" on two React copies.
      // Machine-local, same as the `link:` devDependencies in package.json
      // (which is why pnpm-lock.yaml is gitignored).
      react: '/home/csy/Code/installer/deepseek-harness/node_modules/.pnpm/react@18.3.1/node_modules/react',
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    // N1: run test files sequentially. Several specs share the real
    // 8760-8799 tunnel port window (probe/bind); parallel files could bind a
    // port another file is about to probe (TOCTOU) and flake ~9% of the time.
    fileParallelism: false,
    server: {
      deps: {
        inline: [/@deepseek-ai\/.*/],
      },
    },
  },
})
