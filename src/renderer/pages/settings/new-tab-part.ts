// What Settings keeps about the new tab's own picture: the reason main gave for refusing a file. Choosing one is main's
// (it opens the file picker and copies the file); this asks, and keeps the answer for the row to say.
import type { OrivonInternal } from '../shared/bridge.js'
import type { SettingsPart } from './settings-parts.js'

/** The reason main gave when it refused the file, or '' for a choice that went through or was cancelled. */
export function refusalOf (reply: unknown): string {
  if (typeof reply !== 'object' || reply === null) return ''
  const { ok, reason } = reply as { ok?: unknown, reason?: unknown }
  return ok === false && typeof reason === 'string' ? reason : ''
}

export class NewTabPart implements SettingsPart {
  /** Why the last file was refused; empty when there is nothing to say. */
  problem = ''

  constructor (private readonly bridge: OrivonInternal, private readonly changed: () => void) {}

  /** Opens main's file picker and uses the picture chosen. Cancelling leaves things as they were. */
  async choose (): Promise<void> {
    this.problem = refusalOf(await this.bridge.request('newTabBackground', { type: 'choose' }))
    this.changed()
  }
}
