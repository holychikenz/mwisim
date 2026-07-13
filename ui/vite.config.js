import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'

// The engine sources in ../src import "heap-js". Because those files live
// outside ui/, Node's upward module resolution from ../src never reaches
// ui/node_modules — it would only resolve heap-js via a root-level
// node_modules (present locally, absent in a ui-only CI install). Pin the
// bare specifier to the copy installed under ui/ so it resolves regardless
// of the importing file's location.
const require = createRequire(import.meta.url)
const heapPkg = require('heap-js/package.json')
const heapJs = require.resolve('heap-js/' + heapPkg.module)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'heap-js': heapJs,
    },
  },
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
