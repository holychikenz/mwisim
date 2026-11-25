// The loadout tool (lib/tools/loadout.js) over Express.
import { toolRouter } from '../lib/optimizerRoute.js';
import tool from '../lib/tools/loadout.js';

export { prepareLoadoutRun } from '../lib/tools/loadout.js';
export default toolRouter(tool);
