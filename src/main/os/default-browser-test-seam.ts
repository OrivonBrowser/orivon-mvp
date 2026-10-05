// Test builds only: ORIVON_TEST_DEFAULT_BROWSER=can-set|default|declined stands a recording host in for the
// operating system, so an e2e can prove what the browser asked of it without ever changing the machine's default.
// Gated on the compiled-in flag the developer grant uses (../dev/dev-grant.ts), so an ordinary build carries none
// of it: scripts/check-dev-grant-absent.mjs looks for the globals below in the output.
import type { DefaultBrowserHost } from './default-browser.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** `can-set`: not the default, and registering works. `default`: already is. `declined`: registering is asked for and not taken. */
export type SeamMode = 'can-set' | 'default' | 'declined'

export interface Recording {
  readonly isDefault: string[]
  readonly setDefault: string[]
  opened: number
  registered: boolean
}

declare global {
  // `var`: TypeScript requires it for a `declare global` augmentation.
  var __orivonDevDefaultBrowser: Recording | undefined
  var __orivonDevDefaultBrowserAskNow: (() => Promise<void>) | undefined
}

export function parseSeamMode (raw: string | undefined): SeamMode | undefined {
  return raw === 'can-set' || raw === 'default' || raw === 'declined' ? raw : undefined
}

/** A host on Linux from an installed package that records every call and keeps its own answer. */
export function recordingHost (mode: SeamMode): DefaultBrowserHost & { readonly recording: Recording } {
  const recording: Recording = { isDefault: [], setDefault: [], opened: 0, registered: mode === 'default' }
  return {
    platform: 'linux',
    launcher: 'installed',
    recording,
    isDefault: async (protocol) => { recording.isDefault.push(protocol); return recording.registered },
    setDefault: (protocol) => {
      recording.setDefault.push(protocol)
      if (mode !== 'declined') recording.registered = true
      return mode !== 'declined'
    },
    openSettings: async () => { recording.opened += 1 }
  }
}

/** Undefined outside a test build, where SEAM_ENABLED is a literal `false` and this whole branch is dead code. */
export function testDefaultBrowserHost (env: NodeJS.ProcessEnv = process.env): DefaultBrowserHost | undefined {
  if (!SEAM_ENABLED) return undefined
  const mode = parseSeamMode(env['ORIVON_TEST_DEFAULT_BROWSER'])
  if (mode === undefined) return undefined
  const host = recordingHost(mode)
  globalThis.__orivonDevDefaultBrowser = host.recording
  return host
}

/** Lets a test run the weekly check now, instead of waiting for its timer. */
export function exposeAskNow (check: () => Promise<void>): void {
  if (SEAM_ENABLED) globalThis.__orivonDevDefaultBrowserAskNow = check
}
