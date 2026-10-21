// The Settings apps card's one door for what an app may do: the row of each capability, and the switch that
// turns one off or on. It reads the broker through the context so it always sees the broker now published, and
// moves a switch only through `./site-switches.ts`, the door the key popup uses, so the two never disagree.

import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import { isLocalFileKey } from '../../broker/policy/origin.js'
import type { SubsystemContext } from '../registry.js'
import { buildSiteInfo } from './site-info.js'
import type { SiteCapabilityRow } from './site-info.js'
import { persistedCapabilityRows, withUndeclaredHeld } from './app-capability-rows.js'
import { displayableName } from './permissions.js'
import { turnOffCapability, turnOnCapability } from './site-switches.js'
import type { TurnOnResult } from './site-switches.js'

export interface AppSwitches {
  /** One row per capability the app declares or holds; empty when nothing is known about the origin. */
  readonly rowsFor: (origin: string) => Promise<readonly SiteCapabilityRow[]>
  /**
   * The apps Orivon holds a record of that hold nothing and remember a refusal, other than `listed`: the apps whose
   * card is where the person finds them to switch something on again. Never loaded this session, so with no rows
   * (`rowsFor` has them); kept apart from the grant list, which leaves an empty record out.
   */
  readonly idleApps: (listed: ReadonlySet<string>) => Promise<ReadonlyArray<{ readonly origin: string, readonly appName: string }>>
  /** Moves one switch. `shown` is what the row offered, so a manifest that changed meanwhile grants nothing. */
  readonly set: (origin: string, capability: CapabilityKind, on: boolean, shown: readonly Pattern[]) => Promise<TurnOnResult>
}

/** The Website level an origin is displayed at, when one is forced (ADR-0037: at Level 4 its rows carry no warning); none by default. */
type LevelOverrideFor = (origin: string) => ScoreLevel | undefined

/** `changed` tells the chrome that what it knows of an app's permissions moved, so the key's dot follows a switch of this card at once (`../app-setup/entry-changes.ts`). */
export function createAppSwitches (ctx: SubsystemContext, levelOverrideFor: LevelOverrideFor = () => undefined, changed: () => void = () => {}): AppSwitches {
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

    async idleApps (listed) {
      const broker = ctx.broker
      if (broker === undefined) return []
      const idle: Array<{ origin: string, appName: string }> = []
      for (const app of broker.app.persistedAppsSync()) {
        if (listed.has(app.origin) || isLocalFileKey(app.origin) || Object.keys(app.grants).length > 0 || Object.keys(app.pickedPaths).length > 0) continue
        if (((await broker.declinedCapabilitiesFor(app.origin)) ?? []).length === 0) continue
        idle.push({ origin: app.origin, appName: displayableName(app.appName) ?? app.origin })
      }
      return idle
    },

    async set (origin, capability, on, shown) {
      const broker = ctx.broker
      if (broker === undefined) return 'not-registered'
      if (on) {
        const result = await turnOnCapability(broker, origin, capability, shown)
        if (result === 'ok') changed()
        return result
      }
      const result = await turnOffCapability(broker, origin, capability)
      if (result === 'ok') changed()
      return result
    }
  }
}
