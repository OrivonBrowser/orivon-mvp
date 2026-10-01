// Whether Orivon is the computer's default browser, and the one call that makes it so. Only a packaged install can
// register itself: a run from source would register the Electron binary, and an AppImage moves, so a registration
// naming it goes stale. The rule lives here so a test run can never change the machine's default browser.

export type DefaultBrowserState = 'default' | 'can-set' | 'unavailable'

export interface DefaultBrowserFacts {
  readonly isPackaged: boolean
  readonly appImage: boolean
  readonly isHttp: boolean
  readonly isHttps: boolean
}

export function defaultBrowserState (facts: DefaultBrowserFacts): DefaultBrowserState {
  if (!facts.isPackaged || facts.appImage) return 'unavailable'
  return facts.isHttp && facts.isHttps ? 'default' : 'can-set'
}

type WebProtocol = 'http' | 'https'

/** What the operating system says and does, behind calls a test replaces. */
export interface DefaultBrowserHost {
  readonly isPackaged: boolean
  readonly appImage: boolean
  isDefault: (protocol: WebProtocol) => boolean
  setDefault: (protocol: WebProtocol) => boolean
}

/** The operating system is asked only where the answer could be acted on. */
export function readDefaultBrowser (host: DefaultBrowserHost): DefaultBrowserState {
  const registrable = host.isPackaged && !host.appImage
  return defaultBrowserState({
    isPackaged: host.isPackaged,
    appImage: host.appImage,
    isHttp: registrable && host.isDefault('http'),
    isHttps: registrable && host.isDefault('https')
  })
}

/** How long the system gets to record a registration before it is read back. */
export const SETTLE_MS = 1000

export interface MakeDefaultResult {
  readonly state: DefaultBrowserState
  /** True when Orivon is the default browser afterwards. */
  readonly ok: boolean
}

/** Registers for both web protocols, waits, and reports what the system now says: it may decline without an error. */
export async function makeDefaultBrowser (host: DefaultBrowserHost, wait: (ms: number) => Promise<void>): Promise<MakeDefaultResult> {
  const before = readDefaultBrowser(host)
  if (before !== 'can-set') return { state: before, ok: before === 'default' }
  for (const protocol of ['http', 'https'] as const) {
    try {
      host.setDefault(protocol)
    } catch (error) {
      console.error(`[os] could not register for ${protocol}`, error)
    }
  }
  await wait(SETTLE_MS)
  const state = readDefaultBrowser(host)
  return { state, ok: state === 'default' }
}
