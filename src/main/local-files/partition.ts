/**
 * The Electron session every document opened from this computer runs in. No `persist:` prefix: it is
 * in memory, so nothing a local file stores outlives the run.
 */
export const LOCAL_FILES_PARTITION = 'orivon-local-files'
