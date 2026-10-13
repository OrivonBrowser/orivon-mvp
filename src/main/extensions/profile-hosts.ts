// The person's extensions in a profile session (`../route/site-partition.ts`): a library instance of its own, with the same
// APIs as the default session's but the side panel, so that the toolbar button, the popup, `chrome.tabs`, `chrome.webRequest`
// and the rules added at run time act on the tabs of that session; and the extensions themselves, one copy for every website
// in the session (`profile-extensions.ts`).
//
// Both profiles load them when their first website opens and remove them when their last one closes (`profile-demand.ts`), so an
// idle profile holds no extension page or worker and costs no memory, and with the whole browser on the tunnel an extension makes
// no direct request while no website the person left out of it is open. Tied to Electron.
import type { Session } from 'electron'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'
import { createProfileDemand } from './profile-demand.js'
import { createProfileExtensions } from './profile-extensions.js'
import { registerProfile } from './profile-registry.js'
import type { DnrEngine } from './dnr/dnr-engine.js'
import { registerDnrApiHandlers, type TabLookup } from './dnr-api.js'
import { installDnrWebRequestHandlers } from './dnr-webrequest.js'

export interface ProfileAttacherDeps {
  readonly defaultSession: Session
  /** The library instance for `target`, built before any extension loads into it. */
  readonly createHost: (target: Session) => ElectronChromeExtensions
  /** Puts the APIs on the instance's router. */
  readonly installApis: (host: ElectronChromeExtensions, target: Session) => void
  readonly userDataPath: string
  readonly engine: () => DnrEngine | undefined
  readonly tabs: TabLookup
}

export interface ProfileAttacher {
  /**
   * Gives `target` (the profile session named `partition`) its library instance and its rules, once, and does nothing more.
   * Synchronous, and before any view is made in the session: a tab of the session that exists before the instance does is
   * never one the instance knows.
   */
  readonly prepare: (target: Session, partition: string) => void
  /**
   * Makes `target` ready for a view about to be made in it: its extensions on, loaded before this settles when they were not
   * already. Undefined when there is nothing to wait for. Never throws: what cannot be loaded is logged.
   */
  readonly wake: (target: Session) => Promise<void> | undefined
}

const realClock = {
  now: () => Date.now(),
  setTimer: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimer: (timer: unknown): void => { clearTimeout(timer as ReturnType<typeof setTimeout>) }
}

export function createProfileAttacher (deps: ProfileAttacherDeps): ProfileAttacher {
  const attached = new Map<Session, { readonly wake: () => Promise<void> | undefined }>()

  function attach (target: Session, partition: string): { readonly wake: () => Promise<void> | undefined } {
    const demand = createProfileDemand(realClock)
    const extensions = createProfileExtensions(target.extensions, deps.defaultSession.extensions)
    registerProfile({ session: target, partition, demand, extensions })

    const host = deps.createHost(target)
    // A badge is drawn only for an extension this session holds: the engine's rules are the default session's, and name every extension.
    const badgeHost = { setBadgeText: (id: string, tabId: number, text: string): void => { if (target.extensions.getExtension(id) != null) host.setBadgeText(id, tabId, text) } }
    const { onRuleMatched, onTabNavigated } = registerDnrApiHandlers(host.getRouter(), badgeHost, deps.userDataPath, deps.tabs)
    installDnrWebRequestHandlers(target, deps.engine, onRuleMatched, onTabNavigated)
    deps.installApis(host, target)

    // orivon:floating-ok -- `activate` and `deactivate` catch everything they can throw
    demand.onChange((open) => { void (open ? extensions.activate() : extensions.deactivate()) })
    return {
      wake: () => {
        const ready = extensions.isReady()
        demand.wake()
        const done = extensions.activate()
        return ready ? undefined : done
      }
    }
  }

  return {
    prepare: (target, partition) => {
      if (!attached.has(target)) attached.set(target, attach(target, partition))
    },
    wake: (target) => attached.get(target)?.wake()
  }
}
