import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The build lands in the Go module's embed directory, so `go build` bakes the
// frontend into the binary and a release is a single file with no runtime
// asset dependencies.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../internal/api/dist',
    emptyOutDir: true,
    // Fret is one screen deep; a single bundle beats a waterfall of chunks.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
    },
  },
})
