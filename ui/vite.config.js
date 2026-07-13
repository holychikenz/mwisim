import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works when mounted under a prefix
  // (tampermonkey/start-server.py serves dist/ at http://127.0.0.1:17645/sim/).
  base: './',
  server: {
    fs: {
      // The simulation worker and game data are imported from ../src
      // (the engine lives at the csim repo root, outside ui/).
      allow: ['..']
    },
    proxy: {
      // Optional: the Express API (csim/api) for headless/automation use.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // cow/webapp character data (Load my character).
      '/cow': {
        target: 'http://localhost:12345',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cow/, '')
      }
    }
  }
})
