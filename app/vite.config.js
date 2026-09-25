import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
