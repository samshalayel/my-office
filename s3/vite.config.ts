import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'ES2020',
    rollupOptions: {
      input: {
        main: 'public/index.html',
      },
      output: {
        manualChunks: {
          vendor: ['idb'],
        },
      },
    },
  },
  server: {
    port: 3000,
    host: true,
    middleware: [],
  },
  // Service worker should be served as-is, not bundled
  optimizeDeps: {
    exclude: ['./src/sw.ts'],
  },
});
