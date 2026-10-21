// What a package tagged for an app does on the first run of a new default profile: the app is opened as any address typed in
// the bar is, once the welcome screen has closed, and it is pinned first in the new tab's Featured row. Nothing else is
// touched: no grant, no consent, no telemetry choice, no setting. The tag only selects an entry of the allowlist; see
// README.md for why, and flavours.ts for how a tag is read.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import type { FeaturedStore } from '../newtab/featured-store.js'
import { findFlavour, type Flavour } from './flavours.js'

export const FLAVOUR_FILE = 'flavour.json'

export interface FirstRunDeps {
  /** The profile's folder. */
  readonly dir: string
  /** This process is the default profile in an ordinary window and the profile was new when it started (`isNewProfile`). */
  readonly isNewDefaultProfile: boolean
  readonly flavours: readonly Flavour[]
  readonly featured: Pick<FeaturedStore, 'setNewcomerPin'>
  /** Opens `address` in a tab, after the welcome screen has closed; a navigation like any other, so the app's own question is asked. */
  readonly openApp: (address: string) => void
  readonly now?: () => Date
}

let installed: FirstRunDeps | undefined
let appliedByThisProcess = false

/** Called once by the launch, before the first window; `applyFirstRunFlavour` does nothing until it has been. */
export function installFirstRunFlavour (deps: FirstRunDeps): void {
  installed = deps
  appliedByThisProcess = false
}

/** The id this profile was tagged with, or null when none was applied. */
export function storedFlavour (dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, FLAVOUR_FILE), 'utf8'))
    const id = typeof parsed === 'object' && parsed !== null ? (parsed as { id?: unknown }).id : undefined
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

/** Applies the first-run presets of the allowlisted app `id`, and reports whether it did. It does nothing, silently, for an id
 * that is not on the allowlist, for a profile that is not a new default profile, and once an id was applied to this profile:
 * the stored `flavour.json` (the id and when) is what stops a second one, however the tag reaches the browser. */
export function applyFirstRunFlavour (id: string): boolean {
  const deps = installed
  if (deps === undefined || !deps.isNewDefaultProfile || appliedByThisProcess) return false
  const flavour = findFlavour(deps.flavours, id)
  if (flavour === undefined || storedFlavour(deps.dir) !== null) return false
  appliedByThisProcess = true
  try {
    writeFileAtomic(join(deps.dir, FLAVOUR_FILE), JSON.stringify({ id: flavour.id, appliedAt: (deps.now?.() ?? new Date()).toISOString() }, null, 2))
  } catch (error) {
    console.error('[orivon] could not record the first-run app:', error)
  }
  const address = `ipfs://${flavour.app}`
  deps.featured.setNewcomerPin(address, flavour.name)
  deps.openApp(address)
  return true
}
