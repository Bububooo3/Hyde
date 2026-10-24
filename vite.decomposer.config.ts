import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/decomposer', plugins: [react()], base: './',
  build: { outDir: 'dist/web', target: 'es2022', rollupOptions: { input: { decomposer: 'apps/decomposer/decomposer.html' } } },
});
