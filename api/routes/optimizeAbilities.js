// The abilities tool (lib/tools/abilities.js) over Express.
import { toolRouter } from '../lib/optimizerRoute.js';
import tool from '../lib/tools/abilities.js';

export { prepareAbilityRun, runAbilitySearch } from '../lib/tools/abilities.js';
export default toolRouter(tool);
