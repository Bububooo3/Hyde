import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist/cli',
    emptyOutDir: true,
    lib: { entry: 'src/cli.ts', formats: ['es'], fileName: () => 'hyde.mjs' },
    rollupOptions: {
      external: /^(node:|playwright$)/,
      output: { banner: '#!/usr/bin/env node' },
    },
  },
});
