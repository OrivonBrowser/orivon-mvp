// Which apps may take a link of a scheme: an app the broker has loaded this session whose manifest lists the scheme in
// `protocols` and that holds a grant now (d-0596). Declaring a scheme is a request, never a claim: an app with no
// grant, or one that did not list the scheme, is never offered and never handed a link.
import type { Broker } from '../../broker/broker-contracts.js'
import { isHandableScheme, type AppLinkOption } from '../sessions/external-links.js'

export type DirectoryBroker = { readonly app: Pick<Broker['app'], 'registeredOriginsSync' | 'hasGrantsSync' | 'manifest'> }

export interface AppDirectory {
  /** Every app that may take `scheme`, in the order the broker loaded them. */
  appsFor: (scheme: string) => Promise<readonly AppLinkOption[]>
  /** The app at `origin` when it may take `scheme`. */
  appAt: (origin: string, scheme: string) => Promise<AppLinkOption | undefined>
}

export function createAppDirectory (broker: () => DirectoryBroker | undefined): AppDirectory {
  async function appAt (origin: string, scheme: string): Promise<AppLinkOption | undefined> {
    const live = broker()
    if (live === undefined || !isHandableScheme(scheme) || !live.app.hasGrantsSync(origin)) return undefined
    try {
      const manifest = await live.app.manifest(origin)
      return manifest.capabilities.protocols?.includes(scheme) === true ? { origin, name: manifest.name } : undefined
    } catch {
      return undefined
    }
  }
  return {
    appAt,
    async appsFor (scheme) {
      const origins = broker()?.app.registeredOriginsSync() ?? []
      const found = await Promise.all(origins.map(async (origin) => await appAt(origin, scheme)))
      return found.filter((app): app is AppLinkOption => app !== undefined)
    }
  }
}
