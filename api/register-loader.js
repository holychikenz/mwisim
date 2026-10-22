import { register } from 'node:module';

// Resolved against this file, not the cwd, so `--import <path>/register-loader.js`
// works from any directory.
register('./loader.js', import.meta.url);
