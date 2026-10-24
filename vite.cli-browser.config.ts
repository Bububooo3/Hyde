import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist/cli',
    emptyOutDir: false,
    lib: { entry: 'src/cliBrowserRuntime.ts', name: 'HydeCliRuntime', formats: ['iife'], fileName: () => 'hyde-browser.iife.js' },
  },
});
