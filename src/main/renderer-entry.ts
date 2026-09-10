// Resolves one of electron-vite's multi-entry renderer outputs to a
// loadable URL. Split out of window.ts's own dashboard-URL resolution
// (queue item 4.4 adds a second caller, settings-window.ts, so this is now
// a shared reason, not just a shared shape -- code-guidelines.md Rule 3).

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `devServerUrl` is `process.env['ELECTRON_RENDERER_URL']`, read by the
 * caller -- electron-vite's dev server serves every renderer entry off the
 * SAME origin at a nested path, one per `rollupOptions.input` key
 * (electron.vite.config.ts). `baseDir` is the CALLING module's own
 * `import.meta.dirname`, kept a parameter rather than hardcoded so this
 * file needs no knowledge of where its caller's compiled output lands
 * relative to `../renderer/`.
 */
export function rendererEntryUrl (
  baseDir: string,
  devServerUrl: string | undefined,
  devSubpath: string,
  builtFileRelativePath: string
): string {
  return devServerUrl !== undefined
    ? `${devServerUrl}${devSubpath}`
    : pathToFileURL(join(baseDir, builtFileRelativePath)).href
}
