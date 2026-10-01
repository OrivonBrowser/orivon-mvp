// The manifest an extension actually loads: the installed (base) manifest
// with the person's choices applied. Pure -- the stages are the lanes' own
// files, listed here in the order they run; effective-manifest-runner.ts
// writes the result and reloads.
import type { ExtensionPrefs } from './extension-prefs.js'
import { applyGrantedStage } from './manifest-stage-granted.js'
import { applySiteAccessStage } from './manifest-stage-site-access.js'

export type ExtensionManifest = Readonly<Record<string, unknown>>

/** A stage returns a new manifest or the one it was given; it never mutates its input. */
export type ManifestStage = (manifest: ExtensionManifest, prefs: ExtensionPrefs) => ExtensionManifest

/** One per line, in running order: what the person granted, then where the extension may run. */
export const MANIFEST_STAGES: ReadonlyArray<ManifestStage> = [
  applyGrantedStage,
  applySiteAccessStage
]

export function effectiveManifest (base: ExtensionManifest, prefs: ExtensionPrefs): ExtensionManifest {
  return MANIFEST_STAGES.reduce((manifest, stage) => stage(manifest, prefs), base)
}

/** The bytes written to the version folder's `manifest.json`: the same serialisation an install writes, so an unchanged output compares equal. */
export function manifestText (manifest: ExtensionManifest): string {
  return JSON.stringify(manifest)
}
