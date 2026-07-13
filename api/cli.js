#!/usr/bin/env node

/**
 * CLI tool for running combat simulations
 *
 * Usage:
 *   node cli.js --zone "/actions/combat/fly" --time 100
 *   node cli.js --zone "/actions/combat/black_bear" --tier 2 --time 10
 *   node cli.js --list-zones
 */

import { runSimulation, getZones, loadGameData } from './lib/simulator.js';

const ONE_HOUR = 60 * 60 * 1e9;

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    zone: '/actions/combat/fly',
    tier: 0,
    time: 100, // hours
    level: 50, // player level for all skills
    listZones: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--zone':
      case '-z':
        options.zone = args[++i];
        break;
      case '--tier':
      case '-t':
        options.tier = parseInt(args[++i], 10);
        break;
      case '--time':
        options.time = parseInt(args[++i], 10);
        break;
      case '--level':
      case '-l':
        options.level = parseInt(args[++i], 10);
        break;
      case '--list-zones':
        options.listZones = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Combat Simulator CLI

Usage:
  node cli.js [options]

Options:
  --zone, -z <hrid>     Zone HRID (default: /actions/combat/fly)
  --tier, -t <number>   Difficulty tier 0-8 (default: 0)
  --time <hours>        Simulation time in hours (default: 100)
  --level, -l <number>  Player level for all skills (default: 50)
  --list-zones          List all available zones
  --help, -h            Show this help message

Examples:
  node cli.js --zone "/actions/combat/fly" --time 100
  node cli.js --zone "/actions/combat/black_bear" --tier 2 --level 80
  node cli.js --list-zones
`);
}

function formatNumber(num, decimals = 2) {
  if (num >= 1000000) return (num / 1000000).toFixed(decimals) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.listZones) {
    const zones = getZones();
    console.log('\nAvailable Zones:\n');
    console.log('Regular Zones:');
    zones.filter(z => !z.isDungeon).forEach(z => {
      console.log(`  ${z.hrid}`);
    });
    console.log('\nDungeons:');
    zones.filter(z => z.isDungeon).forEach(z => {
      console.log(`  ${z.hrid}`);
    });
    process.exit(0);
  }

  console.log(`\nRunning simulation...`);
  console.log(`  Zone: ${options.zone}`);
  console.log(`  Tier: T${options.tier}`);
  console.log(`  Duration: ${options.time} hours`);
  console.log(`  Player Level: ${options.level}\n`);

  const player = {
    hrid: 'player1',
    staminaLevel: options.level,
    intelligenceLevel: options.level,
    attackLevel: options.level,
    meleeLevel: options.level,
    defenseLevel: options.level,
    rangedLevel: options.level,
    magicLevel: options.level,
    equipment: {},
    food: [],
    drinks: [],
    abilities: [],
    houseRooms: {},
    achievements: {},
    debuffOnLevelGap: 0
  };

  const startTime = Date.now();

  try {
    const result = await runSimulation({
      players: [player],
      zone: { zoneHrid: options.zone, difficultyTier: options.tier },
      simulationTimeLimit: options.time * ONE_HOUR,
      extra: {}
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const hoursSimulated = result.simulatedTime / ONE_HOUR;

    console.log(`Simulation completed in ${duration}s\n`);
    console.log('=== Results ===\n');

    console.log(`Encounters: ${result.encounters} (${formatNumber(result.encounters / hoursSimulated)}/hr)`);

    if (result.isDungeon) {
      console.log(`Dungeons Completed: ${result.dungeonsCompleted}`);
      console.log(`Dungeons Failed: ${result.dungeonsFailed}`);
      console.log(`Max Wave Reached: ${result.maxWaveReached}`);
    }

    if (result.maxEnrageStack > 0) {
      console.log(`Max Enrage Stack: ${result.maxEnrageStack}`);
    }

    console.log('\n--- Experience per Hour ---');
    const exp = result.experienceGained.player1;
    if (exp) {
      console.log(`  Stamina:      ${formatNumber(exp.stamina / hoursSimulated)}`);
      console.log(`  Intelligence: ${formatNumber(exp.intelligence / hoursSimulated)}`);
      console.log(`  Attack:       ${formatNumber(exp.attack / hoursSimulated)}`);
      console.log(`  Melee:        ${formatNumber(exp.melee / hoursSimulated)}`);
      console.log(`  Defense:      ${formatNumber(exp.defense / hoursSimulated)}`);
      console.log(`  Ranged:       ${formatNumber(exp.ranged / hoursSimulated)}`);
      console.log(`  Magic:        ${formatNumber(exp.magic / hoursSimulated)}`);
    }

    const deaths = result.deaths.player1 || 0;
    if (deaths > 0) {
      console.log(`\nPlayer Deaths: ${deaths}`);
    }

    console.log('');
  } catch (error) {
    console.error('Simulation failed:', error.message);
    process.exit(1);
  }
}

main();
