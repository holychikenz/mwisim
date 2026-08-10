import { Router } from 'express';
import { runSimulation, runGuildTrialSimulation, loadGameData, getZones } from '../lib/simulator.js';

const router = Router();

/**
 * POST /api/simulate
 * Run a single zone simulation (returns result when complete)
 */
router.post('/simulate', async (req, res) => {
  try {
    // guildBuffs: pre-resolved guild SHRINE buff objects. They apply to every
    // fight, not just guild trials (see lib/simulator.js).
    const { players, zone, simulationTimeLimit, extra = {}, guildBuffs = [] } = req.body;

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ success: false, error: 'Players array is required' });
    }

    if (!zone || !zone.zoneHrid) {
      return res.status(400).json({ success: false, error: 'Zone configuration is required' });
    }

    const timeLimit = simulationTimeLimit || 100000000000;

    const result = await runSimulation({
      players,
      zone,
      simulationTimeLimit: timeLimit,
      extra,
      guildBuffs
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('Simulation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/simulate-stream
 * Run simulation with Server-Sent Events for progress updates
 */
router.post('/simulate-stream', async (req, res) => {
  try {
    const { players, zone, simulationTimeLimit, extra = {}, guildBuffs = [] } = req.body;

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ success: false, error: 'Players array is required' });
    }

    if (!zone || !zone.zoneHrid) {
      return res.status(400).json({ success: false, error: 'Zone configuration is required' });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    const timeLimit = simulationTimeLimit || 100000000000;

    // Progress callback sends SSE events
    const onProgress = (progressData) => {
      res.write(`data: ${JSON.stringify({ type: 'progress', ...progressData })}\n\n`);
    };

    const result = await runSimulation({
      players,
      zone,
      simulationTimeLimit: timeLimit,
      extra,
      guildBuffs
    }, onProgress);

    // Send final result
    res.write(`data: ${JSON.stringify({ type: 'result', result })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Simulation error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

/**
 * POST /api/simulate-all
 * Run simulations across multiple zones in parallel
 */
router.post('/simulate-all', async (req, res) => {
  try {
    const { players, zones, simulationTimeLimit, extra = {}, guildBuffs = [] } = req.body;

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ success: false, error: 'Players array is required' });
    }

    if (!zones || !Array.isArray(zones) || zones.length === 0) {
      return res.status(400).json({ success: false, error: 'Zones array is required' });
    }

    const timeLimit = simulationTimeLimit || 100000000000;

    // Run simulations in parallel
    const results = await Promise.all(
      zones.map(async (zone) => {
        try {
          const result = await runSimulation({
            players,
            zone,
            simulationTimeLimit: timeLimit,
            extra,
            guildBuffs
          });
          return { zone: zone.zoneHrid, success: true, result };
        } catch (error) {
          return { zone: zone.zoneHrid, success: false, error: error.message };
        }
      })
    );

    res.json({ success: true, results });
  } catch (error) {
    console.error('Multi-simulation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/simulate-guild-trial
 * Run a guild-trial ladder simulation over N iterations (headless).
 * Body: { players[], trialHrid, startTier?, participantCount?, iterations?,
 *         trialOptions?, guildBuffs?, extra?, aggregateOptions? }
 */
router.post('/simulate-guild-trial', async (req, res) => {
  try {
    const {
      players,
      trialHrid,
      startTier,
      participantCount,
      iterations,
      trialOptions = {},
      guildBuffs = [],
      extra = {},
      aggregateOptions = {},
    } = req.body;

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ success: false, error: 'Players array is required' });
    }
    if (!trialHrid) {
      return res.status(400).json({ success: false, error: 'trialHrid is required' });
    }

    const result = await runGuildTrialSimulation({
      players,
      trialHrid,
      startTier,
      participantCount,
      iterations,
      trialOptions,
      guildBuffs,
      extra,
      aggregateOptions,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Guild trial simulation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/data/:name
 * Get game data files
 */
router.get('/data/:name', (req, res) => {
  try {
    const { name } = req.params;
    const data = loadGameData(name);
    res.json(data);
  } catch (error) {
    console.error('Data load error:', error);
    res.status(404).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/zones
 * Get list of available combat zones
 */
router.get('/zones', (req, res) => {
  try {
    const zones = getZones();
    res.json(zones);
  } catch (error) {
    console.error('Zones load error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
