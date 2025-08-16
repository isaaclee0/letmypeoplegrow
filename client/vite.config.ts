import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    hmr: false, // Disable HMR for Docker development to avoid WebSocket issues
    watch: {
      usePolling: true,
      interval: 1000,
    },
    // Completely disable WebSocket functionality
    ws: false,
    proxy: {
      '/api': {
        // When accessing Vite directly on :3000 (not via nginx), forward API to the server container
        target: 'http://server:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  define: {
    'process.env': {},
    'process.env.VITE_HMR': 'false',
    'process.env.VITE_WS': 'false',
  },
  // Ensure service worker is copied to build output
  publicDir: 'public',
});


