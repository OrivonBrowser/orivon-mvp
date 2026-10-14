// The Settings apps card's one door for what an app may do: the row of each capability, and the switch that
// turns one off or on. It reads the broker through the context so it always sees the broker now published, and
// moves a switch only through `./site-switches.ts`, the door the key popup uses, so the two never disagree.

import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import type { SubsystemContext } from '../registry.js'
import { buildSiteInfo } from './site-info.js'
import type { SiteCapabilityRow } from './site-info.js'
import { persistedCapabilityRows, withUndeclaredHeld } from './app-capability-rows.js'
import { turnOffCapability, turnOnCapability } from './site-switches.js'
import type { TurnOnResult } from './site-switches.js'

export interface AppSwitches {
  /** One row per capability the app declares or holds; empty when nothing is known about the origin. */
  readonly rowsFor: (origin: string) => Promise<readonly SiteCapabilityRow[]>
  /** Moves one switch. `shown` is what the row offered, so a manifest that changed meanwhile grants nothing. */
  readonly set: (origin: string, capability: CapabilityKind, on: boolean, shown: readonly Pattern[]) => Promise<TurnOnResult>
}

/** The Website level an origin is displayed at, when one is forced (ADR-0037: at Level 4 its rows carry no warning); none by default. */
type LevelOverrideFor = (origin: string) => ScoreLevel | undefined

export function createAppSwitches (ctx: SubsystemContext, levelOverrideFor: LevelOverrideFor = () => undefined): AppSwitches {
  return {
    async rowsFor (origin) {
      const broker = ctx.broker
      if (broker === undefined) return []
      if (broker.app.isRegisteredSync(origin)) {
        try {
          const [manifest, grants, pickedPaths] = await Promise.all([broker.app.manifest(origin), broker.app.grants(origin), broker.app.pickedPaths(origin)])
          return withUndeclaredHeld(buildSiteInfo(origin, manifest, grants, pickedPaths, true, levelOverrideFor(origin)).capabilityRows, grants, levelOverrideFor(origin))
        } catch {
          // A manifest that cannot be read this moment: the record on disk still says what is held.
        }
      }
      const persisted = broker.app.persistedAppsSync().find((app) => app.origin === origin)
      return persisted === undefined ? [] : persistedCapabilityRows(persisted, (await broker.declinedCapabilitiesFor(origin)) ?? [], levelOverrideFor(origin))
    },

    async set (origin, capability, on, shown) {
      const broker = ctx.broker
      if (broker === undefined) return 'not-registered'
      if (on) return await turnOnCapability(broker, origin, capability, shown)
      await turnOffCapability(broker, origin, capability)
      return 'ok'
    }
  }
}
