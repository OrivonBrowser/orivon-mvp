// The registry of per-site askers. A lane that decides a web permission for
// a site (camera, location, a device chooser, ...) adds one `SiteAsker`; the
// permission gate consults the registry before its own rules and falls
// through on `undefined`. Pure: no `electron` import, so the registry and
// every asker are unit-tested under plain vitest.
import type { WebContents } from 'electron'

export interface SiteAsker {
  readonly name: string
  /** Answers a permission request, or `undefined` for a permission this asker
   * does not own and for any `contents` that is not an ordinary tab (an embed,
   * an extension context or a shell view keeps the gate's own rules). */
  request?: (contents: WebContents, permission: string, details: unknown) => Promise<boolean> | undefined
  /** The synchronous side, which can never wait on the person: it answers
   * only from what was already decided. `contents` is null when Electron
   * gives none, and an asker answers `undefined` for that too. */
  check?: (contents: WebContents | null, permission: string, requestingOrigin: string, details: unknown) => boolean | undefined
}

export interface SiteAsks {
  add: (asker: SiteAsker) => void
  request: (contents: WebContents, permission: string, details: unknown) => Promise<boolean> | undefined
  check: (contents: WebContents | null, permission: string, requestingOrigin: string, details: unknown) => boolean | undefined
}

/**
 * The first answer that is not `undefined` wins, askers in registration
 * order. An asker that throws is logged by name and skipped: the gate's own
 * rules then decide, and none of them allows a per-site name, so a broken
 * asker fails closed.
 */
export function createSiteAsks (): SiteAsks {
  const askers: SiteAsker[] = []
  return {
    add (asker) { askers.push(asker) },
    request (contents, permission, details) {
      for (const asker of askers) {
        if (asker.request === undefined) continue
        try {
          const answer = asker.request(contents, permission, details)
          if (answer !== undefined) return answer
        } catch (error) {
          console.error(`[site-asks] ${asker.name} failed on ${permission}:`, error)
        }
      }
      return undefined
    },
    check (contents, permission, requestingOrigin, details) {
      for (const asker of askers) {
        if (asker.check === undefined) continue
        try {
          const answer = asker.check(contents, permission, requestingOrigin, details)
          if (answer !== undefined) return answer
        } catch (error) {
          console.error(`[site-asks] ${asker.name} failed on ${permission}:`, error)
        }
      }
      return undefined
    }
  }
}

export const siteAsks: SiteAsks = createSiteAsks()
