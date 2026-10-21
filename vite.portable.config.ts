import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** A classic-script player lets exported stories open directly from file://. */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/portable',
    emptyOutDir: false,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: 'player.html',
      output: {
        format: 'iife',
        entryFileNames: 'player.js',
        assetFileNames: 'player.[ext]',
      },
    },
  },
});
