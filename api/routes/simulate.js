import { Router } from 'express';
import { runSimulation } from '../lib/simulator.js';
import { normaliseRunLimits } from '../../shared/dungeonRuns.js';

const router = Router();

/**
 * POST /api/simulate
 * Run a single zone simulation (returns result when complete)
 *
 * A dungeon may instead be simulated as a number of runs: send `maxRuns`
 * (1-10000) and optionally `maxRunHours` (1-10, default 3; a run still going
 * after that long fails). The result then carries `dungeonsTimedOut`, and
 * `dungeonIdleTime`, the idle between runs included in `simulatedTime`. Bad
 * limits, or limits on a zone that is not a dungeon, are a 400.
 */
router.post('/simulate', async (req, res) => {
  try {
    let runLimits;
    try {
      runLimits = normaliseRunLimits(req.body);
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ success: false, error: error.message });
      throw error;
    }

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
      guildBuffs,
      ...(runLimits || {})
    });

    res.json({ success: true, result });
  } catch (error) {
    // The engine refuses run limits outside a dungeon with a RangeError.
    if (error instanceof RangeError) return res.status(400).json({ success: false, error: error.message });
    console.error('Simulation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
