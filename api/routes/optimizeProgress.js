// The progress tool (lib/tools/progress.js) over Express.
import { toolRouter } from '../lib/optimizerRoute.js';
import tool from '../lib/tools/progress.js';

export { prepareProgressRun, runProgress } from '../lib/tools/progress.js';
export default toolRouter(tool);
