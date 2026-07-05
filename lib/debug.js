// Debug logging utility — gated by a single flag.
// Toggle DEBUG to true for local development; keep false in production.
const DEBUG = false;

export const debug = {
  log(...args)   { if (DEBUG) console.log('[Fab]', ...args); },
  warn(...args)  { if (DEBUG) console.warn('[Fab]', ...args); },
  error(...args) { if (DEBUG) console.error('[Fab]', ...args); },
};
