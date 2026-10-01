// The state a feature's Settings section keeps beyond the settings themselves:
// what it loaded from main and what main pushed since. A feature adds one
// `SettingsPartDef` here, one per line in name order, and reads its part with
// `state.part(name)` from its rows.
import type { OrivonInternal } from '../shared/bridge.js'
import { OsPart } from './os-part.js'
import { PasswordsPart } from './passwords/passwords-part.js'
import { SiteDataPart } from './site-data/site-data-part.js'
import { SitesPart } from './sites/sites-part.js'

export interface SettingsPart {
  /** Runs once, after the settings themselves are loaded. */
  load?: () => Promise<void>
  /** An event main pushed: true when this part took it, so no other part sees it. */
  handle?: (topic: string, payload: unknown) => boolean
}

export interface SettingsPartDef<P extends SettingsPart = SettingsPart> {
  readonly name: string
  /** `notify` redraws the page: call it when the part's state changed. */
  create: (bridge: OrivonInternal, notify: () => void) => P
}

export const SETTINGS_PARTS: readonly SettingsPartDef[] = [
  { name: 'os', create: (bridge, notify) => new OsPart(bridge, notify) },
  { name: 'passwords', create: (bridge, notify) => new PasswordsPart(bridge, notify) },
  { name: 'siteData', create: (bridge, notify) => new SiteDataPart(bridge, notify) },
  { name: 'sites', create: (bridge, notify) => new SitesPart(bridge, notify) }
]
