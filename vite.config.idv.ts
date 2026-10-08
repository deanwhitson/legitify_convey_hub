// Isolated build for the ID-verification demo harness. Builds only
// idv-harness.html to dist-idv/ — it neither touches nor is included in the
// production app build. The provider SDK module is replaced by a mock so the
// harness can exercise the real capture-mount path with zero provider
// traffic.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@sumsub/websdk-react': path.resolve(__dirname, './src/idv-harness/mockWebSdk.tsx'),
    },
  },
  build: {
    outDir: 'dist-idv',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'idv-harness.html'),
    },
  },
})
