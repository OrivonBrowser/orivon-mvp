// What main knows about this profile for the "Start here" card, read when the page asks: the app a first-run package
// opened, whether another browser's profile can be imported, and whether the bundled uBlock Origin is on. Each part is
// handed in, so the reading runs under plain Node and the decision stays in ./start-here-state.ts.
import type { StartHereFacts } from './start-here-state.js'

/** The id the bundled uBlock Origin release signs to, the same on every profile (`resources/default-profile/`). */
export const UBLOCK_ORIGIN_ID = 'fkgkibajhfbepljeaefdnfnegdcjomkh'

export interface StartHereSources {
  readonly isPrivate: boolean
  /** The app named by the profile's `flavour.json`, or null. */
  readonly firstRunApp: () => { readonly name: string, readonly address: string } | null
  /** Whether another browser's profile can be read here; asked at most once per run, and a failure counts as none. */
  readonly otherBrowserFound: () => Promise<boolean>
  /** Whether an extension with this id is installed and enabled in the profile. */
  readonly extensionOn: (id: string) => boolean
}

export function startHereFacts (sources: StartHereSources): () => Promise<StartHereFacts> {
  let found: Promise<boolean> | undefined
  return async () => {
    if (sources.isPrivate) return { isPrivate: true, firstRunApp: null, importAvailable: false, uboOn: false }
    found ??= sources.otherBrowserFound().catch(() => false)
    return {
      isPrivate: false,
      firstRunApp: sources.firstRunApp(),
      importAvailable: await found,
      uboOn: sources.extensionOn(UBLOCK_ORIGIN_ID)
    }
  }
}
