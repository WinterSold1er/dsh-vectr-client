import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
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
