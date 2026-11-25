// The swaps tool (lib/tools/swaps.js) over Express.
import { toolRouter } from '../lib/optimizerRoute.js';
import tool from '../lib/tools/swaps.js';

export { prepareSwapRun, runSwapSearch } from '../lib/tools/swaps.js';
export default toolRouter(tool);
