/**
 * Bumped alongside sw.js's CACHE_VERSION on every deploy-worthy change —
 * shown in Verwalten so it's easy to confirm which version a device is
 * actually running (e.g. after the auto-reload-on-update kicks in, or to
 * tell someone reporting a bug which version they're on). Kept as a plain
 * exported constant rather than derived from sw.js's own CACHE_VERSION
 * since sw.js runs as a separate, non-module worker script and can't be
 * imported from here.
 */
export const APP_VERSION = 'v9';
