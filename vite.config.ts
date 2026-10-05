import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths so the build works at https://<user>.github.io/digital-matter-lab/.
  base: './',
  build: {
    // Rapier's compat build inlines its WebAssembly binary, so the main chunk is large by design.
    chunkSizeWarningLimit: 6000,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
