import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import optimizeTriggerRoutes from './routes/optimizeTriggers.js';
import optimizeEquipmentRoutes from './routes/optimizeEquipment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Only the UI's own origins may drive this API from a browser: the Pages site,
// and the Vite dev server (:5173) or cowstuff start-server.py (:17645) on loopback.
// Any other website gets no CORS headers, so the browser blocks its requests.
app.use(cors({ origin: /^(https:\/\/holychikenz\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/ }));
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api', optimizeTriggerRoutes);
app.use('/api', optimizeEquipmentRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Loopback only: this serves the local UI and nothing else.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Combat Simulator API running on http://127.0.0.1:${PORT}`);
});
