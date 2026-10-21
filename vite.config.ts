import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: './', build: { manifest: 'build-manifest.json', target: 'es2022', rollupOptions: { input: { main: 'index.html', player: 'player.html' } } } });

