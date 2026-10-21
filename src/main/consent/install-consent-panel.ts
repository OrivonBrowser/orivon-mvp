// What the first-visit question says, as data: the header lines, one switch row per capability being decided, and the
// line about capabilities asked for together. Pure and I/O-free, like ./grant-prompt-render.ts, so it is tested against
// real manifests; ./install-consent-prompt.ts puts it to the person.
import type { CapabilityKind, Manifest } from '../../contracts/index.js'
import { homeLine, originHost } from '../../trust/domain-binding.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import { offerCapability } from './capability-row.js'
import { extensionsOnSiteLine } from './grant-prompt-extensions.js'
import { formatOriginForDisplay } from './grant-prompt-origin.js'

/** What the key popup says under its switches for an app that asked for its capabilities together. */
export const TOGETHER_NOTE = 'This app asked for these together; turning one off may break it.'

export interface InstallPanelRow {
  readonly capability: CapabilityKind
  readonly warning: boolean
  readonly message: string
  /** What the grant reaches beyond the headline: shown under the row, as the whole-set dialogs do. */
  readonly explanation: string | undefined
}

export interface InstallPanelContent {
  readonly warning: boolean
  readonly title: string
  readonly message: string
  /** The claimed name first and the address last (AR-03); the panel shows the address in its own header and drops the repeat. */
  readonly detail: string
  readonly rows: readonly InstallPanelRow[]
  /** Shown while a switch is off; absent for an app that asked for its capabilities one by one. */
  readonly note: string | undefined
}

/** The capabilities the panel can show as a row. Only these may be asked about or refused: a "no" is recorded for what the person saw. */
export function offeredCapabilities (manifest: Manifest, capabilities: readonly CapabilityKind[]): readonly CapabilityKind[] {
  return capabilities.filter((capability) => offerCapability(manifest, capability) !== undefined)
}

export function describeInstallPanel (
  origin: string,
  manifest: Manifest,
  capabilities: readonly CapabilityKind[],
  level?: ScoreLevel,
  extensionsOnSite: readonly string[] = []
): InstallPanelContent {
  const rows: InstallPanelRow[] = []
  for (const capability of capabilities) {
    const offered = offerCapability(manifest, capability, level)
    if (offered !== undefined) rows.push({ capability, warning: offered.warning, message: offered.message, explanation: offered.explanation })
  }
  const displayOrigin = formatOriginForDisplay(origin)
  const home = homeLine(originHost(origin), manifest.domain)
  const extensions = extensionsOnSiteLine(extensionsOnSite)
  return {
    warning: rows.some((row) => row.warning),
    title: displayOrigin,
    message: 'This app wants to:',
    detail: [`Claims to be "${manifest.name}".`, ...(home === undefined ? [] : [home]), ...(extensions === undefined ? [] : [extensions]), displayOrigin].join('\n'),
    rows,
    note: manifest.consentGranularity === 'per-capability' ? undefined : TOGETHER_NOTE
  }
}
