// A tab's sound: whether the page is making any, and whether the person switched it off. The mute belongs to the
// tab's record, not to a webContents, so it survives the view swap a cross-origin navigation makes.
import type { WebContents } from 'electron'
import type { TabSignal } from '../tab-signals.js'
import { siteSound } from '../../site-settings/site-sound.js'
import { contain } from '../contain.js'
import type { TabRecord } from '../tab-types.js'

/** Whether this tab's page is to be silent: the person muted the tab, or its site is told to be silent. The one place a rule for muting is decided. */
export function mutedFor (record: TabRecord, wc: WebContents): boolean {
  return record.muted === true || siteSound.blocked(wc.getURL())
}

/** Puts the record's mute on the page it shows now. */
export function applyMuted (record: TabRecord): void {
  const wc = record.view.webContents
  if (!wc.isDestroyed()) wc.setAudioMuted(mutedFor(record, wc))
}

export const audioSignal: TabSignal = {
  name: 'audio',
  wire: ({ wc, shown, record }) => {
    // No event follows a mute or an unmute, and `isCurrentlyAudible` stays true while muted: only a change of
    // what the page plays is announced here.
    wc.on('audio-state-changed', () => { if (shown()) record.host.emitState() })
    // A navigation can land on a site with a different sound setting, in the same view.
    wc.on('did-navigate', () => {
      contain('tab signal audio did-navigate', undefined, () => {
        if (wc.isDestroyed()) return
        wc.setAudioMuted(mutedFor(record, wc))
        if (shown()) record.host.emitState()
      })
    })
  },
  apply: ({ wc, record }) => { wc.setAudioMuted(mutedFor(record, wc)) },
  state: (record, wc) => {
    const audible = wc?.isCurrentlyAudible() ?? false
    return {
      muted: record.muted === true,
      audible,
      // Present only when true: a tab that is not silenced by its site carries no extra field.
      ...(audible && wc !== undefined && siteSound.blocked(wc.getURL()) ? { siteMuted: true } : {})
    }
  }
}
