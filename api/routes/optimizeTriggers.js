// POST /api/optimize-triggers(/preview): the trigger optimiser tool (lib/tools/triggers.js) over Express.
import { toolRouter } from '../lib/optimizerRoute.js';
import tool from '../lib/tools/triggers.js';

export default toolRouter(tool);
