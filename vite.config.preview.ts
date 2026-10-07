import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Preview-only Vite config for the grouped document checklist preview.
// Deliberately separate from vite.config.ts so the production entry point is
// unchanged (checklist-preview.html is not part of the production inputs)
// and there is no /api proxy — the preview must make no network calls.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  esbuild: {
    jsxDev: false,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
  build: {
    outDir: 'dist-preview',
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    rollupOptions: {
      input: 'checklist-preview.html',
    },
  },
})
