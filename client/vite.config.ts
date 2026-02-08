import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Read version from VERSION file (single source of truth)
// Check parent dir (local dev), /VERSION (Docker dev mount), ./VERSION (Docker prod COPY)
const versionPaths = [
  path.resolve(__dirname, '..', 'VERSION'),
  '/VERSION',
  path.resolve(__dirname, 'VERSION'),
];
const versionFile = versionPaths.find(p => fs.existsSync(p));
const appVersion = versionFile
  ? fs.readFileSync(versionFile, 'utf-8').trim()
  : '0.0.0';

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
    // Allow all hosts to work with nginx proxy
    // Nginx will rewrite Host header to localhost:3000, but Vite still checks origin
    allowedHosts: ['all'],
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
    '__APP_VERSION__': JSON.stringify(appVersion),
  },
  // Ensure service worker is copied to build output
  publicDir: 'public',
});


