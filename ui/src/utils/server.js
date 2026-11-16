import gameVersion from '../../../src/combatsimulator/data/gameVersion.json';
import versionTimestamp from '../../../src/combatsimulator/data/versionTimestamp.json';
export { TEST_BUILD } from './serverStorage.js';
// Live and test can share gameVersion; the dump's versionTimestamp date tells them apart.
export const DATA_VERSION = `${gameVersion} (${String(versionTimestamp).slice(0, 10)})`;
