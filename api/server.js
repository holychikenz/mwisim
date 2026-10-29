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

app.use(cors());
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
