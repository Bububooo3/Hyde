import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()], base: './',
  build: { outDir: 'dist-decomposer', target: 'es2022', rollupOptions: { input: { decomposer: 'decomposer.html' } } },
});
