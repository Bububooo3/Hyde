import { defineConfig } from 'vite';

/** Local SDK distribution; Node authoring loads without starting a browser. */
export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist/sdk',
    emptyOutDir: true,
    lib: { entry: 'src/sdk.ts', formats: ['es'], fileName: () => 'hyde-sdk.mjs' },
    rollupOptions: { external: /^node:/ },
  },
});
