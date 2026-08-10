import { parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import the simulation classes
const CombatSimulator = (await import('../../src/combatsimulator/combatSimulator.js')).default;
const Player = (await import('../../src/combatsimulator/player.js')).default;
const Zone = (await import('../../src/combatsimulator/zone.js')).default;

const { playersData, zoneConfig, simulationTimeLimit, extraBuffs } = workerData;

// Create Zone
const zone = new Zone(zoneConfig.zoneHrid, zoneConfig.difficultyTier);

// Create Player objects from DTOs
const players = [];
for (let i = 0; i < playersData.length; i++) {
  const currentPlayer = Player.createFromDTO(structuredClone(playersData[i]));
  currentPlayer.zoneBuffs = zone.buffs;
  currentPlayer.extraBuffs = extraBuffs;
  players.push(currentPlayer);
}

// Create simulator
// `labyrinth` is the third positional arg — pass null explicitly so the options
// object lands in the options slot. Omitting it made `this.labyrinth` truthy, and
// startNewEncounter() calls this.labyrinth.getMonster() unconditionally, throwing
// on the first encounter.
const combatSimulator = new CombatSimulator(players, zone, null, { enableHpMpVisualization: false });

// Set up progress listener
combatSimulator.addEventListener("progress", (event) => {
  parentPort.postMessage({
    type: 'progress',
    progress: event.detail.progress,
    zone: event.detail.zone,
    difficultyTier: event.detail.difficultyTier
  });
});

// Run simulation
try {
  const simResult = await combatSimulator.simulate(simulationTimeLimit);
  parentPort.postMessage({ type: 'result', result: simResult });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
}
