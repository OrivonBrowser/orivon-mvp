// Remembers, per tab, which plain-HTTP address was upgraded, so a failed load
// of the upgraded address can be told apart from any other failed load and the
// person offered the way through. Pure: no `electron` import, time injected.

export interface Upgrade {
  /** The `http:` address that was asked for. */
  readonly from: string
  /** The `https:` address it was sent to. */
  readonly to: string
  readonly at: number
}

/** How long after an upgrade a failed load of its target still counts as the upgrade failing. */
export const FALLBACK_WINDOW_MS = 30_000
/** The same address upgraded twice inside this span is a page sending the browser round in a circle. */
export const LOOP_WINDOW_MS = 5_000

/**
 * Load errors (net error codes) that say nothing about HTTPS support: the
 * load was cancelled, or no connection to any server could be made at all,
 * so plain HTTP would fail the same way and the ordinary error page is the
 * honest answer.
 */
const NOT_ABOUT_HTTPS = new Set([-3, -21, -105, -106, -137])

export interface UpgradeTracker {
  /** An upgrade is about to happen: `loop` when this tab upgraded the same address moments ago. */
  noteUpgrade: (contentsId: number, from: string, to: string) => 'upgrade' | 'loop'
  /** A main-frame load failed: the upgrade it ends, or null when it is not the upgraded address failing. */
  failed: (contentsId: number, failedUrl: string, errorCode: number) => Upgrade | null
  /** The tab committed a page: a load of the upgraded address that worked closes the upgrade. */
  navigated: (contentsId: number, url: string) => void
  /**
   * The failed address is one this tracker owns: an upgrade that is waiting for it, or one it just matched. Another
   * sheet for the same failure (a certificate error) asks, so the person sees one explanation, with the way through.
   * Reads only, so the answer does not depend on which listener ran first.
   */
  claims: (contentsId: number, failedUrl: string, errorCode: number) => boolean
  /** A new main-frame load began: a failure claimed before it is over. */
  navigationStarted: (contentsId: number) => void
  forget: (contentsId: number) => void
}

function hostOf (url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function createUpgradeTracker (now: () => number = Date.now): UpgradeTracker {
  const byContents = new Map<number, Upgrade>()
  /** The failed address each tab's matched upgrade ended on, until the tab loads something else. */
  const claimed = new Map<number, string>()

  function matches (upgrade: Upgrade, failedUrl: string, errorCode: number): boolean {
    if (now() - upgrade.at > FALLBACK_WINDOW_MS || NOT_ABOUT_HTTPS.has(errorCode)) return false
    const failedHost = hostOf(failedUrl)
    return failedHost !== null && failedHost === hostOf(upgrade.to) && failedUrl.startsWith('https:')
  }

  return {
    noteUpgrade (contentsId, from, to) {
      const at = now()
      const previous = byContents.get(contentsId)
      claimed.delete(contentsId)
      byContents.set(contentsId, { from, to, at })
      return previous !== undefined && previous.from === from && at - previous.at < LOOP_WINDOW_MS ? 'loop' : 'upgrade'
    },
    failed (contentsId, failedUrl, errorCode) {
      const upgrade = byContents.get(contentsId)
      if (upgrade === undefined) return null
      if (now() - upgrade.at > FALLBACK_WINDOW_MS) {
        byContents.delete(contentsId)
        return null
      }
      if (!matches(upgrade, failedUrl, errorCode)) return null
      byContents.delete(contentsId)
      claimed.set(contentsId, failedUrl)
      return upgrade
    },
    claims (contentsId, failedUrl, errorCode) {
      const upgrade = byContents.get(contentsId)
      return claimed.get(contentsId) === failedUrl || (upgrade !== undefined && matches(upgrade, failedUrl, errorCode))
    },
    navigationStarted: (contentsId) => { claimed.delete(contentsId) },
    navigated (contentsId, url) {
      const upgrade = byContents.get(contentsId)
      if (upgrade !== undefined && hostOf(url) === hostOf(upgrade.to) && url.startsWith('https:')) byContents.delete(contentsId)
    },
    forget: (contentsId) => { byContents.delete(contentsId); claimed.delete(contentsId) }
  }
}

/** The tracker the net handlers, the fallback sheets and the certificate sheet share. */
export const upgradeTracker: UpgradeTracker = createUpgradeTracker()
