// The version this process runs and the notes written for it. The notes are read from CHANGELOG.md when the
// build is made (electron.vite.config.ts) and folded in as a literal, so a started browser reads no file for them.
import type { ReleaseNotes } from './release-notes.js'

declare const __ORIVON_RELEASE_NOTES__: ReleaseNotes | null | undefined
declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
// A test build only (the compiled-in flag the developer grant uses): scripts/check-dev-grant-absent.mjs looks for the variable's name in an ordinary build.
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

export interface RunningRelease {
  readonly version: string
  /** Null when the build carries none: a run from source, or a version CHANGELOG.md has no shipped entries for. */
  readonly notes: ReleaseNotes | null
}

/** Reads a ReleaseNotes from text; anything that is not exactly that shape is undefined. */
export function parseSeamNotes (raw: string | undefined): ReleaseNotes | undefined {
  if (raw === undefined || raw === '') return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const { version, sections } = value as { version?: unknown, sections?: unknown }
    if (typeof version !== 'string' || !Array.isArray(sections)) return undefined
    const parsed = sections.map((section: unknown) => {
      const { heading, items } = (typeof section === 'object' && section !== null ? section : {}) as { heading?: unknown, items?: unknown }
      return typeof heading === 'string' && Array.isArray(items) && items.every((item) => typeof item === 'string')
        ? { heading, items: items as string[] }
        : undefined
    })
    return parsed.every((section) => section !== undefined) ? { version, sections: parsed as ReleaseNotes['sections'][number][] } : undefined
  } catch {
    return undefined
  }
}

/** `appVersion` is Electron's `app.getVersion()`. A test build may name another version with its notes in ORIVON_TEST_RELEASE_NOTES. */
export function runningRelease (appVersion: string, env: NodeJS.ProcessEnv = process.env): RunningRelease {
  if (SEAM_ENABLED) {
    const seam = parseSeamNotes(env['ORIVON_TEST_RELEASE_NOTES'])
    if (seam !== undefined) return { version: seam.version, notes: seam.sections.length === 0 ? null : seam }
  }
  const built = typeof __ORIVON_RELEASE_NOTES__ === 'object' ? __ORIVON_RELEASE_NOTES__ : null
  return { version: appVersion, notes: built !== null && built.version === appVersion ? built : null }
}
