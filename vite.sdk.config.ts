import { defineConfig } from 'vite';

/** Local SDK distribution; Node authoring loads without starting a browser. */
export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'packages/sdk/dist',
    emptyOutDir: true,
    lib: { entry: 'packages/sdk/src/index.ts', formats: ['es'], fileName: () => 'hyde-sdk.mjs' },
    rollupOptions: { external: /^node:/ },
  },
});
