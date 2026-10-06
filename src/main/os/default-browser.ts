// Whether Orivon is the computer's default browser, and the one call that makes it so. Only an installed package
// (a .deb, an installer, a macOS app) registers itself: a run from source would register the Electron binary, and
// an AppImage moves, so a registration naming it goes stale. The rule lives here so a test run can never change the
// machine's default browser.

export type DefaultBrowserState = 'default' | 'can-set' | 'unavailable'

/** How this process was started: from an installed package, from an AppImage, or from source. */
export type Launcher = 'installed' | 'appimage' | 'source'

/** Why a registration cannot be made here; `private` is added by the caller, a private session being no one's browser. */
export type UnavailableReason = 'source' | 'appimage' | 'platform' | 'private'

export interface DefaultBrowserFacts {
  readonly platform: NodeJS.Platform
  readonly launcher: Launcher
}

const REGISTERING_PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'win32', 'darwin']

/** The reason this process may not register, or undefined when it may: decided from facts alone, so nothing has to ask the system. */
export function unavailableReason (facts: DefaultBrowserFacts): Exclude<UnavailableReason, 'private'> | undefined {
  if (facts.launcher !== 'installed') return facts.launcher
  return REGISTERING_PLATFORMS.includes(facts.platform) ? undefined : 'platform'
}

export const canOfferDefault = (facts: DefaultBrowserFacts): boolean => unavailableReason(facts) === undefined

type WebProtocol = 'http' | 'https'

/** What Orivon asks the desktop to open with it, on top of the web protocols, where it is the default browser on Linux. SVG is left under Open with. */
export const LINUX_DOCUMENT_TYPES: readonly string[] = ['text/html', 'application/xhtml+xml', 'application/pdf']

/** What the operating system says and does, behind calls a test replaces. */
export interface DefaultBrowserHost extends DefaultBrowserFacts {
  isDefault: (protocol: WebProtocol) => Promise<boolean>
  setDefault: (protocol: WebProtocol) => boolean
  /** Linux: makes Orivon the program that opens `mimeType`. Absent where the system asks the person instead. */
  setDocumentDefault?: (mimeType: string) => Promise<boolean>
  /** Windows lets only the person choose a default browser: this opens the page where they do. */
  openSettings: () => Promise<void>
}

export interface DefaultBrowserAnswer {
  readonly state: DefaultBrowserState
  /** Present when `state` is `unavailable`. */
  readonly reason?: UnavailableReason
}

/** The operating system is asked only where the answer could be acted on. */
export async function readDefaultBrowser (host: DefaultBrowserHost): Promise<DefaultBrowserAnswer> {
  const reason = unavailableReason(host)
  if (reason !== undefined) return { state: 'unavailable', reason }
  const [http, https] = await Promise.all([host.isDefault('http'), host.isDefault('https')])
  return { state: http && https ? 'default' : 'can-set' }
}

/** How long the system gets to record a registration before it is read back. */
export const SETTLE_MS = 1000

export interface MakeDefaultResult extends DefaultBrowserAnswer {
  /** True when Orivon is the default browser afterwards. */
  readonly ok: boolean
  /** The choice was left to the person, in the system's own settings or its confirmation: the answer is read again when they return. */
  readonly handedOff: boolean
}

/** Registers for both web protocols, waits, and reports what the system now says: it may decline without an error. */
export async function makeDefaultBrowser (host: DefaultBrowserHost, wait: (ms: number) => Promise<void>): Promise<MakeDefaultResult> {
  const before = await readDefaultBrowser(host)
  if (before.state !== 'can-set') return { ...before, ok: before.state === 'default', handedOff: false }
  if (host.platform === 'win32') {
    try {
      await host.openSettings()
      return { state: 'can-set', ok: false, handedOff: true }
    } catch (error) {
      console.error('[os] could not open the default apps settings', error)
      return { state: 'can-set', ok: false, handedOff: false }
    }
  }
  for (const protocol of ['http', 'https'] as const) {
    try {
      host.setDefault(protocol)
    } catch (error) {
      console.error(`[os] could not register for ${protocol}`, error)
    }
  }
  if (host.platform === 'linux') {
    for (const type of LINUX_DOCUMENT_TYPES) {
      try {
        await host.setDocumentDefault?.(type)
      } catch (error) {
        console.error(`[os] could not register for ${type}`, error)
      }
    }
  }
  await wait(SETTLE_MS)
  const after = await readDefaultBrowser(host)
  const ok = after.state === 'default'
  // macOS answers the registration with a confirmation the person gives later, so a read-back that still shows
  // another browser means the choice is theirs, not that the system refused.
  return { ...after, ok, handedOff: host.platform === 'darwin' && after.state === 'can-set' }
}

const programPath = (path: string): string => path.trim().replace(/^"|"$/g, '').replace(/\//g, '\\').toLowerCase()

/** Whether the program Windows runs for a web link is this one. Windows keeps the person's choice in the registry under
 * the hash of an application's own key, so the question goes to the system and the answer's path is compared with ours. */
export function isSameProgram (handlerPath: string, execPath: string): boolean {
  const handler = programPath(handlerPath)
  return handler !== '' && handler === programPath(execPath)
}
