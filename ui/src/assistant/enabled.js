// Roboburble is not ready, so it is hidden unless the build sets VITE_ROBOBURBLE=true
// (e.g. `VITE_ROBOBURBLE=true npm run dev`). Vite env values are strings; only the exact 'true' turns it on.
export const isEnabled = (env) => env?.VITE_ROBOBURBLE === 'true';
export const ROBOBURBLE_ENABLED = isEnabled(import.meta.env);
