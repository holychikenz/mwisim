import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import simulateRoutes from './routes/simulate.js';
import optimizeTriggerRoutes from './routes/optimizeTriggers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api', simulateRoutes);
app.use('/api', optimizeTriggerRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Combat Simulator API running on http://localhost:${PORT}`);
});
