// The switch rows of an app's card in Settings: the rows the key popup shows for an app that is loaded
// (`./site-info.ts`), plus what that builder leaves out so no permission is ever without a switch.
// Pure: no broker, no I/O.

import type { CapabilityKind, Grant } from '../../contracts/index.js'
import type { PersistedApp } from '../../broker/grants/ledger-storage.js'
import { isCapabilityKind } from '../../broker/policy/request-grant.js'
import { describeCapabilityGrant } from '../consent/grant-prompt-render.js'
import { summaryAtLevel } from '../consent/grant-level.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import type { SiteCapabilityRow } from './site-info.js'

/** Why a switch that is off cannot be turned on, for an app Orivon has not opened since it started. */
export const OPEN_APP_FIRST = 'Open the app once to turn this on again.'

/** What each kind is called when only its name is known (a refusal remembered for an app that is not open). */
const CAPABILITY_NAMES: Readonly<Record<CapabilityKind, string>> = {
  'tcp.connect': 'Connect to computers',
  'tcp.listen.local': 'Accept connections from other programs on this device',
  'tcp.listen.network': 'Accept incoming connections',
  'udp.bind.local': 'Receive data from other programs on this device',
  'udp.bind.network': 'Receive data',
  'udp.send': 'Send data to computers',
  'https.connect': 'Connect to sites',
  fs: 'Store files in a private folder for this app on this device',
  id: 'Create a digital identity for you to use with this app',
  'web.context': 'Run code as other sites',
  'web.embed': 'Show other sites inside its page',
  'media.camera': 'Use your camera',
  'media.microphone': 'Use your microphone',
  'media.screen': 'Ask to share your screen, a window or a tab',
  'clipboard.read': 'Read your clipboard',
  secrets: 'Encrypt its own data with a key your system keyring protects',
  'trust.score': 'See what your Web3 Score provider says about other sites',
  'devices.hid': 'Use devices you approve'
}

function heldRow (grant: { readonly capability: CapabilityKind, readonly patterns: readonly string[] }, level: ScoreLevel | undefined): SiteCapabilityRow {
  const { warning, message } = summaryAtLevel(describeCapabilityGrant(grant.capability, grant.patterns), level)
  return { capability: grant.capability, on: true, canTurnOn: true, warning, message, patterns: grant.patterns }
}

/** `rows` with a row added for every held capability they lack: a grant the manifest no longer declares can still be switched off. */
export function withUndeclaredHeld (rows: readonly SiteCapabilityRow[], grants: readonly Grant[], level?: ScoreLevel): readonly SiteCapabilityRow[] {
  const shown = new Set(rows.map((row) => row.capability))
  return [...rows, ...grants.filter((grant) => !shown.has(grant.capability)).map((grant) => heldRow(grant, level))]
}

/**
 * The rows of an app not opened this session, from its record on disk: what it holds (on), and what the person switched off
 * (off, and cannot be switched on until the app is open, because only its manifest can bound a grant).
 * `declined` is untrusted disk content, so a name that is not a kind is skipped.
 */
export function persistedCapabilityRows (app: PersistedApp, declined: readonly string[], level?: ScoreLevel): readonly SiteCapabilityRow[] {
  const rows: SiteCapabilityRow[] = []
  for (const [capability, grant] of Object.entries(app.grants)) {
    if (isCapabilityKind(capability)) rows.push(heldRow({ capability, patterns: grant.patterns }, level))
  }
  const shown = new Set(rows.map((row) => row.capability))
  for (const capability of declined) {
    if (!isCapabilityKind(capability) || shown.has(capability)) continue
    shown.add(capability)
    rows.push({ capability, on: false, canTurnOn: false, warning: false, message: CAPABILITY_NAMES[capability], patterns: [] })
  }
  return rows
}
