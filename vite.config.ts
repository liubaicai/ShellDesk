import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  optimizeDeps: {
    // IronRDP embeds its WASM payload in ESM. Serving it directly avoids a
    // multi-megabyte cold-start prebundle before the lazy RDP view can render.
    exclude: [
      '@devolutions/iron-remote-desktop',
      '@devolutions/iron-remote-desktop-rdp',
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/');

          if (
            normalizedId.includes('/node_modules/react/') ||
            normalizedId.includes('/node_modules/react-dom/')
          ) {
            return 'vendor-react';
          }

          if (
            normalizedId.includes('/node_modules/lucide-react/') ||
            normalizedId.includes('/node_modules/@radix-ui/')
          ) {
            return 'vendor-ui';
          }

          if (normalizedId.includes('/node_modules/@tauri-apps/')) {
            return 'vendor-tauri';
          }

          return undefined;
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
