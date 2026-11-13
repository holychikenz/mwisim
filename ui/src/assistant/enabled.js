// Roboburble is not ready, so it is hidden unless the build sets VITE_ROBOBURBLE=true
// (e.g. `VITE_ROBOBURBLE=true npm run dev`). Vite env values are strings, never booleans.
export const ROBOBURBLE_ENABLED = import.meta.env?.VITE_ROBOBURBLE === 'true';
