import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist/decomposer-cli',
    emptyOutDir: true,
    lib: { entry: 'src/decomposerCli.ts', formats: ['es'], fileName: () => 'hyde-decompose.mjs' },
    rollupOptions: { external: /^(node:|playwright$)/, output: { banner: '#!/usr/bin/env node' } },
  },
});
