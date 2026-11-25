import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works when mounted under a prefix
  // (tampermonkey/start-server.py serves dist/ at http://127.0.0.1:17645/sim/).
  base: './',
  build: {
    rollupOptions: {
      output: {
        // Long-lived, separately cached chunks for what rarely changes. The
        // game data is still a static dependency (useGameData needs it at
        // start), so this buys caching and a smaller entry chunk, not less to
        // download on a first visit. Workers are bundled separately and are
        // not affected by manualChunks.
        manualChunks(id) {
          if (/[\\/]src[\\/]combatsimulator[\\/]data[\\/][^\\/]+\.json$/.test(id)) return 'gamedata';
          if (/node_modules[\\/]@mantine[\\/]/.test(id)) return 'mantine';
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
        }
      }
    }
  },
  server: {
    fs: {
      // The simulation worker and game data are imported from ../src
      // (the engine lives at the csim repo root, outside ui/).
      allow: ['..']
    },
  },
  // ES-module workers: the optimiser host (src/workers/optimizerHost.js) bundles
  // api/lib, whose modules load the engine's data with top-level await.
  worker: {
    format: 'es'
  }
})
