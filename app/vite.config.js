import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

if (process.env.VITE_API_BASE_URL) {
  const url = new URL(process.env.VITE_API_BASE_URL);
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('VITE_API_BASE_URL must use HTTPS (or local HTTP) with no credentials, query, or fragment.');
  }
}

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  server: {
    proxy: {
      // Forward /api calls to the Express proxy server
      '/api': {
        target: 'http://localhost:3011',
        changeOrigin: true,
      },
    },
  },
  assetsInclude: ['**/*.glb', '**/*.fbx'],
});
