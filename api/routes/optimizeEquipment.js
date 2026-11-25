// POST /api/optimize-equipment(/preview): the equipment scan tool (lib/tools/equipment.js) over Express.
import { toolRouter } from '../lib/optimizerRoute.js';
import tool from '../lib/tools/equipment.js';

export { prepareEquipmentRun } from '../lib/tools/equipment.js';
export default toolRouter(tool);
